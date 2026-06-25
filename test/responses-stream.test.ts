import { describe, it, expect, vi } from "vitest";
import { translateResponsesStream } from "../src/responses-stream.js";

function streamFrom(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

// Build a Responses API SSE frame: "event: <type>\ndata: <json>\n\n"
function frame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect(frames: string[], onUsage?: (u: any) => void, factor = 1) {
  const events: { event: string; data: any }[] = [];
  for await (const evt of translateResponsesStream(streamFrom(frames), onUsage ?? (() => {}), factor)) {
    const m = evt.match(/^event: (.+)\ndata: (.+)\n\n$/s);
    expect(m, `malformed SSE frame: ${JSON.stringify(evt)}`).not.toBeNull();
    events.push({ event: m![1], data: JSON.parse(m![2]) });
  }
  return events;
}

// Minimal text-only stream
const TEXT_STREAM = [
  frame("response.output_item.added", {
    item: { id: "item_1", type: "message" },
  }),
  frame("response.output_text.delta", { item_id: "item_1", delta: "Hello" }),
  frame("response.output_text.delta", { item_id: "item_1", delta: " world" }),
  frame("response.output_item.done", { item: { id: "item_1" } }),
  frame("response.completed", {
    response: {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }),
];

// Tool call stream
const TOOL_STREAM = [
  frame("response.output_item.added", {
    item: { id: "item_fc", type: "function_call", call_id: "toolu_01abc", name: "get_time" },
  }),
  frame("response.function_call_arguments.delta", { item_id: "item_fc", delta: '{"tz":' }),
  frame("response.function_call_arguments.delta", { item_id: "item_fc", delta: '"UTC"}' }),
  frame("response.output_item.done", { item: { id: "item_fc" } }),
  frame("response.completed", {
    response: {
      status: "completed",
      usage: { input_tokens: 15, output_tokens: 8 },
    },
  }),
];

describe("translateResponsesStream", () => {
  it("emits message_start and message_stop bookends", async () => {
    const ev = await collect(TEXT_STREAM);
    expect(ev[0].event).toBe("message_start");
    expect(ev.at(-1)!.event).toBe("message_stop");
    expect(ev.filter((e) => e.event === "message_start")).toHaveLength(1);
    expect(ev.filter((e) => e.event === "message_stop")).toHaveLength(1);
    expect(ev[1].event).toBe("ping");
  });

  it("text stream: content_block_start -> deltas -> content_block_stop -> message_delta", async () => {
    const ev = await collect(TEXT_STREAM);
    const names = ev.map((e) => e.event);

    const blockStart = ev.findIndex((e) => e.event === "content_block_start");
    expect(blockStart).toBeGreaterThan(0);
    expect(ev[blockStart].data.content_block.type).toBe("text");
    expect(ev[blockStart].data.index).toBe(0);

    const deltas = ev.filter((e) => e.event === "content_block_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => d.data.delta.text).join("")).toBe("Hello world");

    const blockStop = ev.findIndex((e) => e.event === "content_block_stop");
    expect(blockStop).toBeGreaterThan(blockStart + deltas.length);

    const msgDelta = ev.find((e) => e.event === "message_delta")!;
    expect(msgDelta.data.delta.stop_reason).toBe("end_turn");
    expect(names.at(-1)).toBe("message_stop");
  });

  it("text stream: usage extracted from response.completed and passed to onUsage", async () => {
    const onUsage = vi.fn();
    await collect(TEXT_STREAM, onUsage);
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 10, output_tokens: 5 });
  });

  it("scales client-facing input_tokens by factor; onUsage stays raw", async () => {
    const onUsage = vi.fn();
    const events = await collect(TEXT_STREAM, onUsage, 200_000 / 128_000);
    const msgDelta = events.find((e) => e.event === "message_delta")!;
    // 10 raw tokens * (200000/128000) = ~15.6 -> rounds to 16
    expect(msgDelta.data.usage.input_tokens).toBe(Math.round(10 * (200_000 / 128_000)));
    expect(msgDelta.data.usage.output_tokens).toBe(5);
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 10, output_tokens: 5 });
  });

  it("tool call: function_call item produces tool_use block with call_id as id", async () => {
    const ev = await collect(TOOL_STREAM);
    const blockStart = ev.find((e) => e.event === "content_block_start")!;
    expect(blockStart.data.content_block.type).toBe("tool_use");
    expect(blockStart.data.content_block.id).toBe("toolu_01abc"); // call_id becomes Anthropic id
    expect(blockStart.data.content_block.name).toBe("get_time");

    const deltas = ev.filter((e) => e.event === "content_block_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => d.data.delta.partial_json).join("")).toBe('{"tz":"UTC"}');
    expect(deltas[0].data.delta.type).toBe("input_json_delta");
  });

  it("tool call: item_id (not call_id) used for delta routing", async () => {
    // The stream uses item_id matching item.id ("item_fc"), not call_id ("toolu_01abc")
    const ev = await collect(TOOL_STREAM);
    const deltas = ev.filter((e) => e.event === "content_block_delta");
    // All deltas must target the same block index as the content_block_start
    const startIdx = ev.find((e) => e.event === "content_block_start")!.data.index;
    for (const d of deltas) expect(d.data.index).toBe(startIdx);
  });

  it("maps status: incomplete to stop_reason: max_tokens", async () => {
    const frames = [
      frame("response.completed", {
        response: { status: "incomplete", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    const ev = await collect(frames);
    const msgDelta = ev.find((e) => e.event === "message_delta")!;
    expect(msgDelta.data.delta.stop_reason).toBe("max_tokens");
  });

  it("maps status: failed to stop_reason: end_turn (error is not a valid Anthropic stop_reason)", async () => {
    const frames = [
      frame("response.completed", {
        response: { status: "failed", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    const ev = await collect(frames);
    const msgDelta = ev.find((e) => e.event === "message_delta")!;
    expect(msgDelta.data.delta.stop_reason).toBe("end_turn");
  });

  it("drops reasoning_summary_text.delta events silently", async () => {
    const frames = [
      frame("response.output_item.added", { item: { id: "r1", type: "message" } }),
      frame("response.reasoning_summary_text.delta", { item_id: "r1", delta: "reasoning..." }),
      frame("response.output_text.delta", { item_id: "r1", delta: "answer" }),
      frame("response.output_item.done", { item: { id: "r1" } }),
      frame("response.completed", {
        response: { status: "completed", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    const ev = await collect(frames);
    const deltas = ev.filter((e) => e.event === "content_block_delta");
    // Only the text delta, not the reasoning delta
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.text).toBe("answer");
  });

  it("signals onAbort when upstream errors; still closes cleanly", async () => {
    const enc = new TextEncoder();
    const dying = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode(frame("response.output_item.added", { item: { id: "i1", type: "message" } })),
        );
        c.error(new Error("connection reset"));
      },
    });
    const onAbort = vi.fn();
    const names: string[] = [];
    for await (const evt of translateResponsesStream(dying, undefined, 1, onAbort))
      names.push(evt.match(/^event: (.+)\n/)![1]);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(names.at(-1)).toBe("message_stop");
  });

  it("reasoning item in output_item.added does not open a block", async () => {
    const frames = [
      frame("response.output_item.added", { item: { id: "r_item", type: "reasoning" } }),
      frame("response.reasoning_summary_text.delta", { item_id: "r_item", delta: "I reasoned..." }),
      frame("response.output_item.done", { item: { id: "r_item" } }),
      frame("response.output_item.added", { item: { id: "text_item", type: "message" } }),
      frame("response.output_text.delta", { item_id: "text_item", delta: "result" }),
      frame("response.output_item.done", { item: { id: "text_item" } }),
      frame("response.completed", {
        response: { status: "completed", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    const ev = await collect(frames);
    // Only ONE content_block_start (for the message item, not the reasoning item)
    const starts = ev.filter((e) => e.event === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].data.content_block.type).toBe("text");
    // The text delta should be captured
    const deltas = ev.filter((e) => e.event === "content_block_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.text).toBe("result");
  });

  it("unknown delta item_id (no prior added event) is silently ignored", async () => {
    // Orphan delta: item_id doesn't match anything in itemIdToIndex
    const frames = [
      frame("response.function_call_arguments.delta", { item_id: "unknown_id", delta: '{"x":1}' }),
      frame("response.completed", {
        response: { status: "completed", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    // Should not throw; just no content_block_delta events
    const ev = await collect(frames);
    expect(ev.filter((e) => e.event === "content_block_delta")).toHaveLength(0);
    expect(ev.at(-1)!.event).toBe("message_stop");
  });

  it("tool call stream: stop_reason is tool_use (not end_turn)", async () => {
    const ev = await collect(TOOL_STREAM);
    const msgDelta = ev.find((e) => e.event === "message_delta")!;
    expect(msgDelta.data.delta.stop_reason).toBe("tool_use");
  });

  it("tool call stream: stop_reason stays max_tokens even with function_call (truncation wins)", async () => {
    const frames = [
      frame("response.output_item.added", {
        item: { id: "item_fc2", type: "function_call", call_id: "toolu_99", name: "foo" },
      }),
      frame("response.function_call_arguments.delta", { item_id: "item_fc2", delta: "{}" }),
      frame("response.output_item.done", { item: { id: "item_fc2" } }),
      frame("response.completed", {
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
    const ev = await collect(frames);
    const msgDelta = ev.find((e) => e.event === "message_delta")!;
    expect(msgDelta.data.delta.stop_reason).toBe("max_tokens");
  });

  it("function_call_arguments.done with no prior deltas emits synthetic delta", async () => {
    // Upstream sends .done with full payload but no preceding .delta events
    const frames = [
      frame("response.output_item.added", {
        item: { id: "item_short", type: "function_call", call_id: "toolu_short", name: "ping" },
      }),
      frame("response.function_call_arguments.done", {
        item_id: "item_short",
        arguments: '{"msg":"hi"}',
      }),
      frame("response.output_item.done", { item: { id: "item_short" } }),
      frame("response.completed", {
        response: { status: "completed", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    const ev = await collect(frames);
    const deltas = ev.filter((e) => e.event === "content_block_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.type).toBe("input_json_delta");
    expect(deltas[0].data.delta.partial_json).toBe('{"msg":"hi"}');
  });

  it("output_text.done with no prior deltas emits synthetic text delta", async () => {
    const frames = [
      frame("response.output_item.added", { item: { id: "item_short_text", type: "message" } }),
      frame("response.output_text.done", { item_id: "item_short_text", text: "short answer" }),
      frame("response.output_item.done", { item: { id: "item_short_text" } }),
      frame("response.completed", {
        response: { status: "completed", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    const ev = await collect(frames);
    const deltas = ev.filter((e) => e.event === "content_block_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.type).toBe("text_delta");
    expect(deltas[0].data.delta.text).toBe("short answer");
  });

  it("function_call_arguments.done after deltas does NOT emit extra synthetic delta", async () => {
    // When deltas already arrived, .done should not add a duplicate
    const frames = [
      frame("response.output_item.added", {
        item: { id: "item_nodupe", type: "function_call", call_id: "toolu_nodupe", name: "f" },
      }),
      frame("response.function_call_arguments.delta", { item_id: "item_nodupe", delta: '{"a":1}' }),
      frame("response.function_call_arguments.done", {
        item_id: "item_nodupe",
        arguments: '{"a":1}',
      }),
      frame("response.output_item.done", { item: { id: "item_nodupe" } }),
      frame("response.completed", {
        response: { status: "completed", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    ];
    const ev = await collect(frames);
    const deltas = ev.filter((e) => e.event === "content_block_delta");
    // Only the one original delta, not duplicated by .done
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.partial_json).toBe('{"a":1}');
  });
});
