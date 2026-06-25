// OpenAI Responses API SSE stream -> Anthropic SSE event protocol.
// Key differences from Chat Completions (stream.ts):
//   - Items opened via response.output_item.added; routed by item.id (NOT call_id)
//   - Text deltas: response.output_text.delta; tool arg deltas: response.function_call_arguments.delta
//   - Items close via response.output_item.done
//   - Usage arrives on response.completed (not a final empty-choices chunk)

import { sse } from "./stream.js";
import { responsesStatusToStopReason } from "./translate-responses.js";

export async function* translateResponsesStream(
  upstream: ReadableStream<Uint8Array>,
  onUsage: (usage: { input_tokens: number; output_tokens: number }) => void = () => {},
  factor = 1,
  onAbort: () => void = () => {},
): AsyncGenerator<string> {
  const msgId = "msg_" + Date.now();
  yield sse("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model: "",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield sse("ping", { type: "ping" });

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  let nextIndex = 0;
  const itemIdToIndex = new Map<string, number>(); // item.id -> Anthropic block index
  let openBlock: number | null = null;
  let stopReason = "end_turn";
  let hadToolUse = false; // true if any function_call item was opened
  // Tracks which item_ids have emitted at least one delta (for .done no-delta fallback)
  const emittedDelta = new Set<string>();
  let outTokens = 0;
  let inTokens = 0;

  const closeOpen = function* () {
    if (openBlock !== null) {
      yield sse("content_block_stop", { type: "content_block_stop", index: openBlock });
      openBlock = null;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";

      for (const frame of frames) {
        if (!frame.trim()) continue;

        let eventType = "";
        let dataStr = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
        }

        if (!eventType || !dataStr || dataStr === "[DONE]") continue;

        let ev: any;
        try {
          ev = JSON.parse(dataStr);
        } catch {
          continue; // malformed frame: skip, keep streaming
        }

        switch (eventType) {
          case "response.output_item.added": {
            const item = ev.item;
            if (!item) break;

            if (item.type === "reasoning") {
              // No Anthropic equivalent; skip. output_item.done will no-op via idx === undefined.
              break;
            }

            yield* closeOpen();
            const idx = nextIndex++;
            itemIdToIndex.set(item.id, idx);
            openBlock = idx;

            if (item.type === "function_call") {
              hadToolUse = true;
              yield sse("content_block_start", {
                type: "content_block_start",
                index: idx,
                content_block: {
                  type: "tool_use",
                  id: item.call_id, // Anthropic tool_use id matches the call_id we sent in
                  name: item.name ?? "",
                  input: {},
                },
              });
            } else {
              yield sse("content_block_start", {
                type: "content_block_start",
                index: idx,
                content_block: { type: "text", text: "" },
              });
            }
            break;
          }

          case "response.output_text.delta": {
            const idx = itemIdToIndex.get(ev.item_id);
            if (idx === undefined) break;
            if (openBlock !== idx) {
              yield* closeOpen();
              openBlock = idx;
            }
            if (ev.delta) {
              emittedDelta.add(ev.item_id);
              yield sse("content_block_delta", {
                type: "content_block_delta",
                index: idx,
                delta: { type: "text_delta", text: ev.delta },
              });
            }
            break;
          }

          case "response.output_text.done": {
            // If no deltas arrived, emit full text now so short payloads are not lost.
            if (!emittedDelta.has(ev.item_id) && ev.text) {
              const idx = itemIdToIndex.get(ev.item_id);
              if (idx !== undefined) {
                yield sse("content_block_delta", {
                  type: "content_block_delta",
                  index: idx,
                  delta: { type: "text_delta", text: ev.text },
                });
              }
            }
            break;
          }

          case "response.function_call_arguments.delta": {
            const idx = itemIdToIndex.get(ev.item_id);
            if (idx === undefined) break;
            if (openBlock !== idx) {
              yield* closeOpen();
              openBlock = idx;
            }
            if (ev.delta) {
              emittedDelta.add(ev.item_id);
              yield sse("content_block_delta", {
                type: "content_block_delta",
                index: idx,
                delta: { type: "input_json_delta", partial_json: ev.delta },
              });
            }
            break;
          }

          case "response.function_call_arguments.done": {
            // If no deltas arrived, emit full arguments now so short tool calls are not empty.
            if (!emittedDelta.has(ev.item_id) && ev.arguments) {
              const idx = itemIdToIndex.get(ev.item_id);
              if (idx !== undefined) {
                yield sse("content_block_delta", {
                  type: "content_block_delta",
                  index: idx,
                  delta: { type: "input_json_delta", partial_json: ev.arguments },
                });
              }
            }
            break;
          }

          case "response.output_item.done": {
            const item = ev.item;
            const idx = item ? itemIdToIndex.get(item.id) : undefined;
            if (idx !== undefined) {
              yield sse("content_block_stop", { type: "content_block_stop", index: idx });
              if (openBlock === idx) openBlock = null;
            }
            break;
          }

          case "response.reasoning_summary_text.delta":
            break; // no Anthropic equivalent; drop

          case "response.completed": {
            const response = ev.response;
            if (response?.usage) {
              inTokens = response.usage.input_tokens ?? 0;
              outTokens = response.usage.output_tokens ?? 0;
            }
            stopReason = responsesStatusToStopReason(response?.status, response?.incomplete_details);
            // Tool calls need "tool_use" stop_reason so the agent loop continues.
            if (response?.status === "completed" && !response?.incomplete_details && hadToolUse) {
              stopReason = "tool_use";
            }
            break;
          }

          case "error":
            onAbort();
            break;

          default:
            break;
        }
      }
    }
  } catch {
    onAbort();
  }

  yield* closeOpen();
  onUsage({ input_tokens: inTokens, output_tokens: outTokens }); // raw, for cost tracking
  yield sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: Math.round(inTokens * factor), output_tokens: outTokens },
  });
  yield sse("message_stop", { type: "message_stop" });
}
