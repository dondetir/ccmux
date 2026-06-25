import { describe, it, expect, vi } from "vitest";
import { translateStream } from "../src/stream.js";

function streamFrom(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function collect(frames: string[]) {
  const events: { event: string; data: any }[] = [];
  for await (const evt of translateStream(streamFrom(frames))) {
    const m = evt.match(/^event: (.+)\ndata: (.+)\n\n$/s);
    expect(m).not.toBeNull();
    events.push({ event: m![1], data: JSON.parse(m![2]) });
  }
  return events;
}

// Recorded-style OpenAI stream: text, then one tool call with arguments split
// across 3 chunks, then finish + usage-only chunk (empty choices).
const TOOL_STREAM = [
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "I'll check" } }] }),
  chunk({ choices: [{ index: 0, delta: { content: " the time." } }] }),
  chunk({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "get_time", arguments: "" } },
          ],
        },
      },
    ],
  }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"tz":' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"UTC"' } }] } }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 42 } }),
  "data: [DONE]\n\n",
];

describe("translateStream", () => {
  it("obeys the streaming event protocol for text + tool call", async () => {
    const ev = await collect(TOOL_STREAM);
    const names = ev.map((e) => e.event);

    // exactly one message_start (first) and one message_stop (last)
    expect(names[0]).toBe("message_start");
    expect(names[1]).toBe("ping");
    expect(names.at(-1)).toBe("message_stop");
    expect(names.filter((n) => n === "message_start")).toHaveLength(1);
    expect(names.filter((n) => n === "message_stop")).toHaveLength(1);

    // text block: start(0) -> 2 text deltas -> stop(0), closed BEFORE tool opens
    const textStart = ev.findIndex((e) => e.event === "content_block_start" && e.data.content_block.type === "text");
    const toolStart = ev.findIndex((e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use");
    expect(textStart).toBeGreaterThan(0);
    expect(toolStart).toBeGreaterThan(textStart);
    expect(ev[textStart].data.index).toBe(0);
    const textStop = ev.findIndex((e) => e.event === "content_block_stop" && e.data.index === 0);
    expect(textStop).toBeGreaterThan(textStart);
    expect(textStop).toBeLessThan(toolStart); // close before open

    // tool block: monotonic new index, id + name on start
    expect(ev[toolStart].data.index).toBe(1);
    expect(ev[toolStart].data.content_block.id).toBe("call_1");
    expect(ev[toolStart].data.content_block.name).toBe("get_time");

    // raw partial_json fragments reassemble byte-identically
    const frags = ev
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json);
    expect(frags).toHaveLength(3);
    expect(frags.join("")).toBe('{"tz":"UTC"}');
    expect(JSON.parse(frags.join(""))).toEqual({ tz: "UTC" });

    // tool block closed, then message_delta with stop_reason + usage, then stop
    const toolStop = ev.findIndex((e) => e.event === "content_block_stop" && e.data.index === 1);
    const msgDelta = ev.findIndex((e) => e.event === "message_delta");
    expect(toolStop).toBeGreaterThan(toolStart);
    expect(msgDelta).toBeGreaterThan(toolStop);
    expect(ev[msgDelta].data.delta.stop_reason).toBe("tool_use");
    expect(ev[msgDelta].data.usage.output_tokens).toBe(42); // usage-only chunk captured
    expect(ev[msgDelta].data.usage.input_tokens).toBe(10);
  });

  it("scales client-facing input_tokens by the context factor; onUsage stays raw", async () => {
    const onUsage = vi.fn();
    const events: { event: string; data: any }[] = [];
    for await (const evt of translateStream(streamFrom(TOOL_STREAM), onUsage, 200_000 / 128_000)) {
      const m = evt.match(/^event: (.+)\ndata: (.+)\n\n$/s);
      events.push({ event: m![1], data: JSON.parse(m![2]) });
    }
    const msgDelta = events.find((e) => e.event === "message_delta")!;
    expect(msgDelta.data.usage.input_tokens).toBe(Math.round(10 * (200_000 / 128_000))); // 16
    expect(msgDelta.data.usage.output_tokens).toBe(42); // output never scaled
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 10, output_tokens: 42 }); // raw for cost tracking
  });

  it("text-only stream ends cleanly with end_turn", async () => {
    const ev = await collect([
      chunk({ choices: [{ index: 0, delta: { content: "hello" } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const names = ev.map((e) => e.event);
    expect(names).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(ev[5].data.delta.stop_reason).toBe("end_turn");
  });

  it("signals onAbort when the upstream stream errors, still closing cleanly", async () => {
    const enc = new TextEncoder();
    const dying = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(chunk({ choices: [{ index: 0, delta: { content: "par" } }] })));
        c.error(new Error("connection reset"));
      },
    });
    const onAbort = vi.fn();
    const names: string[] = [];
    for await (const evt of translateStream(dying, undefined, 1, onAbort))
      names.push(evt.match(/^event: (.+)\n/)![1]);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(names.at(-1)).toBe("message_stop"); // clean shutdown, no hang
  });

  it("malformed frames are skipped; truncated upstream still closes cleanly", async () => {
    const ev = await collect([
      chunk({ choices: [{ index: 0, delta: { content: "partial" } }] }),
      "data: {not json}\n\n",
      // upstream dies here: no finish_reason, no [DONE]
    ]);
    const names = ev.map((e) => e.event);
    expect(names.at(-1)).toBe("message_stop");
    expect(names.filter((n) => n === "content_block_stop")).toHaveLength(1); // open block closed
  });

  it("two parallel tool calls get distinct monotonic indices", async () => {
    const ev = await collect([
      chunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "a", arguments: "{}" } }] } }],
      }),
      chunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "b", arguments: "{}" } }] } }],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ]);
    const starts = ev.filter((e) => e.event === "content_block_start");
    expect(starts.map((s) => s.data.index)).toEqual([0, 1]);
    expect(starts.map((s) => s.data.content_block.id)).toEqual(["c1", "c2"]);
    // first block closed before second opened
    const stop0 = ev.findIndex((e) => e.event === "content_block_stop" && e.data.index === 0);
    const start1 = ev.findIndex((e) => e.event === "content_block_start" && e.data.index === 1);
    expect(stop0).toBeLessThan(start1);
  });

  it("maps Ollama reasoning to a signed thinking block before the text block", async () => {
    const ev = await collect([
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: "Let me" } }] }),
      chunk({ choices: [{ index: 0, delta: { content: "", reasoning: " think." } }] }),
      chunk({ choices: [{ index: 0, delta: { content: "Answer" } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    // thinking block opens at index 0
    const thinkStart = ev.findIndex((e) => e.event === "content_block_start" && e.data.content_block.type === "thinking");
    expect(thinkStart).toBeGreaterThan(0);
    expect(ev[thinkStart].data.index).toBe(0);

    // thinking_delta carries the reasoning text verbatim
    const thinkDeltas = ev.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta");
    expect(thinkDeltas.map((e) => e.data.delta.thinking).join("")).toBe("Let me think.");

    // signature_delta is the thinking block's last event, immediately before its stop
    const sig = ev.findIndex((e) => e.event === "content_block_delta" && e.data.delta.type === "signature_delta");
    const thinkStop = ev.findIndex((e) => e.event === "content_block_stop" && e.data.index === 0);
    expect(sig).toBe(thinkStop - 1);
    expect(ev[sig].data.delta.signature).toBeTruthy();

    // text block opens at index 1, only after the thinking block closed
    const textStart = ev.findIndex((e) => e.event === "content_block_start" && e.data.content_block.type === "text");
    expect(ev[textStart].data.index).toBe(1);
    expect(textStart).toBeGreaterThan(thinkStop);
    expect(ev.at(-1)!.event).toBe("message_stop");
  });

  it("closes a thinking-only response (no content) with a signature then stop", async () => {
    const ev = await collect([
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: "thinking..." } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const names = ev.map((e) => e.event);
    const sig = ev.findIndex((e) => e.event === "content_block_delta" && e.data.delta.type === "signature_delta");
    const stop = ev.findIndex((e) => e.event === "content_block_stop");
    expect(sig).toBeGreaterThanOrEqual(0);
    expect(sig).toBeLessThan(stop); // signature before stop
    expect(names.at(-1)).toBe("message_stop");
  });
});
