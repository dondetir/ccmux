import { mapModel, clampMaxTokens, resolveEffort } from "./models.js";
import type { AnthropicBody, AnthropicMessage, TranslateFlags } from "./types.js";

// Collapse an Anthropic system prompt (string | text-block[]) to a plain string.
export function extractSystemText(system: AnthropicBody["system"]): string {
  if (typeof system === "string") return system;
  return (system ?? []).map((b: any) => b.text ?? "").join("\n");
}

// Last message carries a tool_result -> agent-initiated turn. Copilot accounts
// these differently (X-Initiator header); shared by both request translators.
export function isAgentTurn(messages: AnthropicMessage[] | undefined): boolean {
  const last = messages?.[messages.length - 1];
  return Array.isArray(last?.content) && last.content.some((b: any) => b.type === "tool_result");
}

// Anthropic Messages body -> OpenAI Chat Completions body.
// Anthropic-only fields (cache_control, thinking, metadata, betas) are stripped
// by construction: only known fields are copied onto fresh objects.
export function anthropicToOpenAI(body: AnthropicBody): { payload: any; flags: TranslateFlags } {
  const messages: any[] = [];
  const flags: TranslateFlags = { vision: false, agent: false };

  if (body.system) {
    const sys = extractSystemText(body.system);
    if (sys) messages.push({ role: "system", content: sys });
  }

  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      if (msg.content) messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content) || msg.content.length === 0) continue;

    const parts: any[] = []; // text / image_url content parts
    const toolCalls: any[] = [];
    const toolMsgs: any[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;
        case "image":
          flags.vision = true;
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.source?.media_type};base64,${block.source?.data}` },
          });
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case "tool_result": {
          const content = Array.isArray(block.content)
            ? block.content
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n")
            : (block.content ?? "");
          if (Array.isArray(block.content) && block.content.some((p: any) => p.type === "image"))
            console.warn("tool_result image dropped (no OpenAI tool-message equivalent)");
          toolMsgs.push({ role: "tool", tool_call_id: block.tool_use_id, content });
          break;
        }
        default:
          break; // thinking / redacted_thinking / unknown: drop
      }
    }

    // OpenAI tool messages must directly follow the assistant tool_calls message.
    messages.push(...toolMsgs);

    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
    const hasImage = parts.some((p) => p.type === "image_url");
    if (msg.role === "assistant") {
      if (text || toolCalls.length) {
        const m: any = { role: "assistant", content: text || null }; // null, not "" per OpenAI spec
        if (toolCalls.length) m.tool_calls = toolCalls;
        messages.push(m);
      }
    } else if (hasImage) {
      messages.push({ role: msg.role, content: parts });
    } else if (text) {
      messages.push({ role: msg.role, content: text });
    }
  }

  flags.agent = isAgentTurn(body.messages);

  const model = mapModel(body.model ?? "");
  const payload: any = {
    model,
    messages,
    max_tokens: clampMaxTokens(model, body.max_tokens ?? 4096),
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true }; // omitting this leaves output_tokens at 0
  }
  if (body.stop_sequences?.length) payload.stop = body.stop_sequences;

  // Keep only client tools; server tools (web_search_20250305, etc.) have no input_schema and 400 upstream.
  const allTools = body.tools ?? [];
  let tools = allTools.filter((t: any) => !t.type || t.type === "custom");
  if (tools.length !== allTools.length)
    console.warn(`dropped ${allTools.length - tools.length} server tool(s)`);
  if (tools.length > 128) {
    // OpenAI-format endpoint hard-caps tools at 128; Claude Code lists built-ins before MCP tools.
    console.warn(`tool list capped at 128 (was ${tools.length}) for OpenAI-format upstream`);
    tools = tools.slice(0, 128);
  }
  if (tools.length) {
    payload.tools = tools.map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  // Only forward reasoning_effort when the catalog confirms support; some Copilot
  // endpoints 400 on unknown fields, and catalog absence means we can't confirm.
  const effort = resolveEffort(model, body.output_config?.effort);
  if (effort !== undefined) payload.reasoning_effort = effort;

  if (body.tool_choice && tools.length) {
    const tc = body.tool_choice;
    payload.tool_choice =
      tc.type === "any"
        ? "required"
        : tc.type === "tool"
          ? { type: "function", function: { name: tc.name } }
          : "auto";
  }

  return { payload, flags };
}
