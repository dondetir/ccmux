import { mapStopReason, THINKING_SIG } from "./models.js";

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// OpenAI SSE stream -> Anthropic SSE event protocol.
// Invariants: monotonic block indices, tool index map, RAW partial_json
// fragments (never parse/re-stringify), close-before-open, exactly one
// message_start/message_stop, upstream death -> close cleanly, never hang.
export async function* translateStream(
  upstream: ReadableStream<Uint8Array>,
  onUsage: (usage: { input_tokens: number; output_tokens: number }) => void = () => {},
  factor = 1, // context-scale factor for client-facing input counts
  onAbort: () => void = () => {}, // called when upstream dies mid-stream
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
  // Anthropic sends a ping right after message_start; some clients expect early bytes.
  yield sse("ping", { type: "ping" });

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  let nextIndex = 0;
  let textIndex: number | null = null; // index of the open text block, if any
  let thinkingIndex: number | null = null; // index of the thinking block (Ollama reasoning), if any
  const toolIndexMap = new Map<number, number>(); // openai tool index -> anthropic block index
  let openBlock: number | null = null; // currently open anthropic block index
  let stopReason = "end_turn";
  let outTokens = 0;
  let inTokens = 0;

  const closeOpen = function* () {
    if (openBlock !== null) {
      // A thinking block must carry a signature; emit it as the block's last event.
      if (openBlock === thinkingIndex)
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: thinkingIndex,
          delta: { type: "signature_delta", signature: THINKING_SIG },
        });
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
        const line = frame.replace(/^data:\s*/, "").trim();
        if (!line || line === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue; // malformed frame: skip, keep streaming
        }
        // Usage arrives on a final chunk whose choices array is EMPTY; capture
        // it before the choice guard or output_tokens stays 0.
        if (chunk.usage?.completion_tokens) outTokens = chunk.usage.completion_tokens;
        if (chunk.usage?.prompt_tokens) inTokens = chunk.usage.prompt_tokens;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        // ---- thinking (Ollama reasoning) ----
        // Surface delta.reasoning as an Anthropic thinking block; never reopen a stopped index.
        if (delta.reasoning) {
          if (thinkingIndex === null || openBlock !== thinkingIndex) {
            yield* closeOpen();
            thinkingIndex = nextIndex++;
            openBlock = thinkingIndex;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: thinkingIndex,
              content_block: { type: "thinking", thinking: "" },
            });
          }
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: thinkingIndex,
            delta: { type: "thinking_delta", thinking: delta.reasoning },
          });
        }

        // ---- text ----
        if (delta.content) {
          if (textIndex === null) {
            yield* closeOpen();
            textIndex = nextIndex++;
            openBlock = textIndex;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: textIndex,
              content_block: { type: "text", text: "" },
            });
          } else if (openBlock !== textIndex) {
            yield* closeOpen();
            openBlock = textIndex;
          }
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        // ---- tool calls ----
        for (const tc of delta.tool_calls ?? []) {
          const oaIdx = tc.index ?? 0;
          let aIdx = toolIndexMap.get(oaIdx);
          if (aIdx === undefined) {
            yield* closeOpen();
            textIndex = null; // a new tool block ends the text run
            aIdx = nextIndex++;
            toolIndexMap.set(oaIdx, aIdx);
            openBlock = aIdx;
            yield sse("content_block_start", {
              type: "content_block_start",
              index: aIdx,
              content_block: { type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input: {} },
            });
          } else if (openBlock !== aIdx) {
            yield* closeOpen();
            openBlock = aIdx;
          }
          const argFrag = tc.function?.arguments;
          if (argFrag) {
            yield sse("content_block_delta", {
              type: "content_block_delta",
              index: aIdx,
              delta: { type: "input_json_delta", partial_json: argFrag },
            });
          }
        }

        if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);
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
    // input_tokens scaled so Claude Code's context tracking matches the serving model's prompt limit.
    usage: { input_tokens: Math.round(inTokens * factor), output_tokens: outTokens },
  });
  yield sse("message_stop", { type: "message_stop" });
}
