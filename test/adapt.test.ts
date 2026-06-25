import { describe, it, expect, afterEach } from "vitest";
import { modelCatalog, adaptBodyToModel, contextScale, scaleUsage } from "../src/models.js";
import { rewriteNativeStream } from "../src/native-stream.js";

afterEach(() => modelCatalog.clear());

const HAIKU = {
  maxOutput: 32000, maxPrompt: 128000,
  adaptiveThinking: false, minThinking: 1024, maxThinking: 32000, efforts: [],
};
const FABLE = {
  maxOutput: 64000, maxPrompt: 200000,
  adaptiveThinking: true, minThinking: 1024, maxThinking: 32000,
  efforts: ["low", "medium", "high", "xhigh", "max"],
};
const SONNET = { ...FABLE, efforts: ["low", "medium", "high", "max"] };

describe("adaptBodyToModel — thinking", () => {
  it("passes adaptive through on adaptive-capable models", () => {
    modelCatalog.set("claude-fable-5", FABLE);
    const body: any = { model: "claude-fable-5", max_tokens: 64000, thinking: { type: "adaptive" } };
    adaptBodyToModel(body);
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("converts adaptive to enabled+budget on budget-only models (haiku)", () => {
    modelCatalog.set("claude-haiku-4.5", HAIKU);
    const body: any = { model: "claude-haiku-4.5", max_tokens: 64000, thinking: { type: "adaptive" } };
    adaptBodyToModel(body);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
  });

  it("clamps enabled budgets into [min, min(maxThinking, max_tokens-1)]", () => {
    modelCatalog.set("claude-haiku-4.5", HAIKU);
    const body: any = { model: "claude-haiku-4.5", max_tokens: 8000, thinking: { type: "enabled", budget_tokens: 50000 } };
    adaptBodyToModel(body);
    expect(body.thinking.budget_tokens).toBe(7999);
  });

  it("drops thinking when max_tokens leaves no room for the minimum budget", () => {
    modelCatalog.set("claude-haiku-4.5", HAIKU);
    const body: any = { model: "claude-haiku-4.5", max_tokens: 512, thinking: { type: "adaptive" } };
    adaptBodyToModel(body);
    expect(body.thinking).toBeUndefined();
  });

  it("drops adaptive when the catalog is unavailable (old conservative behavior)", () => {
    const body: any = { model: "claude-haiku-4.5", max_tokens: 64000, thinking: { type: "adaptive" } };
    adaptBodyToModel(body);
    expect(body.thinking).toBeUndefined();
  });

  it("keeps disabled untouched", () => {
    modelCatalog.set("claude-haiku-4.5", HAIKU);
    const body: any = { model: "claude-haiku-4.5", max_tokens: 1000, thinking: { type: "disabled" } };
    adaptBodyToModel(body);
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});

describe("adaptBodyToModel — output_config.effort", () => {
  it("keeps supported effort values", () => {
    modelCatalog.set("claude-fable-5", FABLE);
    const body: any = { model: "claude-fable-5", output_config: { effort: "xhigh" } };
    adaptBodyToModel(body);
    expect(body.output_config).toEqual({ effort: "xhigh" });
  });

  it("maps unsupported values to the nearest supported level", () => {
    modelCatalog.set("claude-sonnet-4.6", SONNET); // no xhigh
    const body: any = { model: "claude-sonnet-4.6", output_config: { effort: "xhigh" } };
    adaptBodyToModel(body);
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("maps unknown future effort levels to the highest supported", () => {
    modelCatalog.set("claude-sonnet-4.6", SONNET);
    const body: any = { model: "claude-sonnet-4.6", output_config: { effort: "ultra" } };
    adaptBodyToModel(body);
    expect(body.output_config).toEqual({ effort: "max" });
  });

  it("drops output_config entirely on models without reasoning effort", () => {
    modelCatalog.set("claude-haiku-4.5", HAIKU);
    const body: any = { model: "claude-haiku-4.5", output_config: { effort: "high" } };
    adaptBodyToModel(body);
    expect(body.output_config).toBeUndefined();
  });

  it("strips non-effort output_config fields", () => {
    modelCatalog.set("claude-fable-5", FABLE);
    const body: any = { model: "claude-fable-5", output_config: { effort: "low", format: { type: "json_schema" } } };
    adaptBodyToModel(body);
    expect(body.output_config).toEqual({ effort: "low" });
  });
});

describe("contextScale / scaleUsage", () => {
  it("scales by assumed/actual prompt window", () => {
    modelCatalog.set("claude-haiku-4.5", HAIKU); // 128k actual vs 200k assumed
    expect(contextScale("claude-haiku-4.5")).toBeCloseTo(200000 / 128000);
    expect(contextScale("unknown-model")).toBe(1);
  });

  it("scales input-side usage fields, leaves output untouched", () => {
    const usage: any = { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };
    scaleUsage(usage, 1.5625);
    expect(usage).toEqual({ input_tokens: 156, cache_read_input_tokens: 1563, output_tokens: 50 });
  });
});

describe("rewriteNativeStream", () => {
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  function stream(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) { c.enqueue(enc.encode(text)); c.close(); },
    });
  }

  it("scales usage, reports merged raw usage once at end, passes other frames byte-identically", async () => {
    const frames =
      sse("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 1000, output_tokens: 1 } } }) +
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }) +
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }) +
      sse("message_stop", { type: "message_stop" });

    const calls: any[] = [];
    let out = "";
    for await (const f of rewriteNativeStream(stream(frames), 2, (u) => calls.push(u))) out += f;

    expect(out).toContain('"input_tokens":2000'); // scaled for the client
    expect(calls).toHaveLength(1); // merged usage reported once at stream end
    expect(calls[0].input_tokens).toBe(1000); // raw for cost tracking
    expect(calls[0].output_tokens).toBe(42); // message_delta wins over message_start
    expect(out).toContain(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }).trimEnd() + "\n\n");
    expect(out).toContain("message_stop");
  });

  it("scales data-only frames (no event: line) too", async () => {
    const frame = `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100 } } })}\n\n`;
    let out = "";
    for await (const f of rewriteNativeStream(stream(frame), 2)) out += f;
    expect(out).toContain('"input_tokens":200');
  });

  it("factor 1 leaves every frame byte-identical", async () => {
    const frames =
      sse("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 7 } } }) +
      sse("message_stop", { type: "message_stop" });
    let out = "";
    for await (const f of rewriteNativeStream(stream(frames), 1)) out += f;
    expect(out).toBe(frames);
  });
});
