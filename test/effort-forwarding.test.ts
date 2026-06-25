import { describe, it, expect, afterEach } from "vitest";
import { anthropicToOpenAI } from "../src/translate-request.js";
import { modelCatalog } from "../src/models.js";

afterEach(() => {
  modelCatalog.clear();
});

const base = { model: "gpt-4.1", max_tokens: 1024 };

describe("Path B effort forwarding", () => {
  it("forwards effort as reasoning_effort when catalog lists efforts", () => {
    modelCatalog.set("gpt-4.1", {
      maxOutput: 16384,
      efforts: ["low", "medium", "high"],
    });
    const { payload } = anthropicToOpenAI({
      ...base,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.reasoning_effort).toBe("high");
  });

  it("maps effort to nearest supported level (xhigh -> high when max is high)", () => {
    modelCatalog.set("gpt-4.1", {
      maxOutput: 16384,
      efforts: ["low", "medium", "high"],
    });
    const { payload } = anthropicToOpenAI({
      ...base,
      output_config: { effort: "xhigh" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.reasoning_effort).toBe("high");
  });

  it("does not set reasoning_effort when model has no efforts in catalog", () => {
    modelCatalog.set("gpt-4.1", { maxOutput: 16384, efforts: [] });
    const { payload } = anthropicToOpenAI({
      ...base,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it("does not set reasoning_effort when catalog is empty", () => {
    const { payload } = anthropicToOpenAI({
      ...base,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it("does not set reasoning_effort when output_config has no effort", () => {
    modelCatalog.set("gpt-4.1", { maxOutput: 16384, efforts: ["low", "medium", "high"] });
    const { payload } = anthropicToOpenAI({
      ...base,
      output_config: {},
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.reasoning_effort).toBeUndefined();
  });
});
