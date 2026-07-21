import { mapModel, clampMaxTokens, resolveEffort, modelCatalog } from "./models.js";
import { extractSystemText } from "./translate-request.js";
import type { AnthropicBody } from "./types.js";

// Thrown for fields that have no /responses equivalent and must not be silently dropped. Caller returns HTTP 400.
export class ResponsesApiUnsupported extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ResponsesApiUnsupported";
  }
}

// Anthropic Messages body -> OpenAI Responses API body (POST .../responses).
// Key differences from Chat Completions: input[] not messages[], instructions not
// system, max_output_tokens, flat tool schema, tool_result -> function_call_output,
// reasoning.effort not reasoning_effort.
export function anthropicToResponses(body: AnthropicBody): any {
  if (body.stop_sequences?.length) {
    throw new ResponsesApiUnsupported(
      "stop_sequences is not supported by /responses models; remove it or use a different model",
    );
  }

  if ((body as any).top_k !== undefined) {
    console.warn("ccmux: top_k has no /responses equivalent and will be dropped");
  }

  const model = mapModel(body.model ?? "");
  const input: any[] = [];

  const systemText = extractSystemText(body.system);

  // Consecutive text blocks from the same role merge into one input item;
  // function_call and function_call_output are standalone items (Responses API
  // infers role from item type for those).
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      if (msg.content) input.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content) || msg.content.length === 0) continue;

    let pendingText = ""; // accumulated text for the current role

    const flushText = () => {
      if (pendingText) {
        input.push({ role: msg.role, content: pendingText });
        pendingText = "";
      }
    };

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          pendingText += block.text ?? "";
          break;

        case "tool_use":
          flushText();
          // call_id = the Anthropic tool_use id (toolu_* or call_*), preserved as-is.
          // No `id`: on input it must be a server-issued fc_* id, which we don't have.
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;

        case "tool_result":
          flushText();
          // call_id maps 1:1 to tool_use_id; Responses API is stateless and never reassigns call_ids.
          {
            let outputText: string;
            if (Array.isArray(block.content)) {
              let hasImage = false;
              const parts: string[] = [];
              for (const p of block.content) {
                if (p.type === "text") parts.push(p.text ?? "");
                else if (p.type === "image") hasImage = true;
              }
              if (hasImage)
                console.warn(
                  "ccmux: tool_result image content dropped; function_call_output only accepts string output",
                );
              outputText = parts.join("\n");
            } else {
              outputText = block.content ?? "";
            }
            if (block.is_error) outputText = "[tool_error] " + outputText;
            input.push({
              type: "function_call_output",
              call_id: block.tool_use_id,
              output: outputText,
            });
          }
          break;

        case "image": {
          flushText(); // flush before image so it appears in its own input item
          const src = block.source;
          if (src?.type === "url") {
            input.push({ role: msg.role, content: [{ type: "input_image", image_url: src.url }] });
          } else if (src?.type === "base64") {
            const dataUrl = `data:${src.media_type};base64,${src.data}`;
            input.push({ role: msg.role, content: [{ type: "input_image", image_url: dataUrl }] });
          } else {
            console.warn("ccmux: unsupported image source type; image block dropped");
          }
          break;
        }

        case "thinking":
        case "redacted_thinking":
          break; // no /responses equivalent; drop

        default:
          break;
      }
    }

    flushText();
  }

  const payload: any = {
    model,
    input,
    max_output_tokens: clampMaxTokens(model, body.max_tokens ?? 4096),
  };

  if (systemText) payload.instructions = systemText;
  if (body.stream) payload.stream = true;
  // GPT-5 reasoning models reject temperature/top_p on the Responses API
  // ("Unsupported parameter"/"invalid parameter"), which surfaces in Claude
  // Code as an error with no assistant response rendered. Drop them for
  // reasoning models; the Responses API doesn't honor sampling for reasoning.
  const rEntry = modelCatalog.get(model);
  const isReasoning = !!(
    rEntry &&
    ((rEntry.efforts?.length ?? 0) > 0 || rEntry.adaptiveThinking || rEntry.maxThinking)
  );
  if (body.temperature !== undefined && !isReasoning) payload.temperature = body.temperature;
  if ((body as any).top_p !== undefined && !isReasoning) payload.top_p = (body as any).top_p;

  // Tool schema is flat (no function wrapper); parameters renamed from input_schema.
  const allTools = body.tools ?? [];
  const tools = allTools.filter((t: any) => !t.type || t.type === "custom");
  if (tools.length !== allTools.length) {
    console.warn(
      `ccmux: dropped ${allTools.length - tools.length} server tool(s) for /responses`,
    );
  }
  if (tools.length) {
    payload.tools = tools.map((t: any) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }

  // tool_choice: Anthropic {type:"auto"|"any"|"tool",name?} -> Responses API "auto"|"required"|{type:"function",name}.
  const tc = (body as any).tool_choice;
  if (tc) {
    if (tc.type === "auto") {
      payload.tool_choice = "auto";
    } else if (tc.type === "any") {
      payload.tool_choice = "required";
    } else if (tc.type === "tool" && tc.name) {
      payload.tool_choice = { type: "function", name: tc.name };
    } else if (tc.type === "none") {
      payload.tool_choice = "none";
    }
  }

  // Effort maps to reasoning.effort (nested object, unlike Chat Completions reasoning_effort).
  const effort = resolveEffort(model, body.output_config?.effort);
  if (effort !== undefined) payload.reasoning = { effort };

  return payload;
}

// Maps Responses API status + incomplete_details to an Anthropic stop_reason.
export function responsesStatusToStopReason(
  status: string | undefined,
  incompleteDetails?: { reason?: string },
): string {
  if (incompleteDetails?.reason === "max_output_tokens") return "max_tokens";
  // "failed" maps to "end_turn" because "error" is not a valid Anthropic stop_reason;
  // upstream sends failed status in-band, not as an HTTP error.
  const map: Record<string, string> = { completed: "end_turn", incomplete: "max_tokens", failed: "end_turn" };
  return map[status ?? ""] ?? "end_turn";
}

// Non-streaming: OpenAI Responses API response -> Anthropic Messages response.
export function translateResponsesResponse(res: any): any {
  const content: any[] = [];

  for (const item of res.output ?? []) {
    switch (item.type) {
      case "message":
        for (const part of item.content ?? []) {
          if (part.type === "output_text") {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "refusal") {
            content.push({ type: "text", text: part.refusal });
          }
        }
        break;

      case "function_call":
        {
          let parsedInput: any = {};
          try {
            parsedInput = JSON.parse(item.arguments ?? "{}");
          } catch {
            console.warn(
              `ccmux: failed to parse function_call arguments for ${item.name}; using {}`,
            );
          }
          content.push({
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: parsedInput,
          });
        }
        break;

      case "reasoning":
        break; // no Anthropic equivalent; drop

      default:
        break;
    }
  }

  let stopReason = responsesStatusToStopReason(res.status, res.incomplete_details);
  // Override to "tool_use" so Claude Code enters the tool-execution loop.
  if (
    res.status === "completed" &&
    !res.incomplete_details &&
    content.some((b: any) => b.type === "tool_use")
  ) {
    stopReason = "tool_use";
  }

  return {
    id: res.id ?? "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0, // Responses API already uses Anthropic-compatible field names
      output_tokens: res.usage?.output_tokens ?? 0,
    },
  };
}
