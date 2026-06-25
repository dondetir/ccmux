import { describe, it, expect, afterEach } from "vitest";
import { mapNativeModel, modelCatalog } from "../src/models.js";

afterEach(() => modelCatalog.clear());

describe("mapNativeModel", () => {
  it("passes exact Copilot ids through", () => {
    modelCatalog.set("claude-haiku-4.5", { maxOutput: 32000 });
    expect(mapNativeModel("claude-haiku-4.5")).toBe("claude-haiku-4.5");
  });

  it("family-maps Anthropic ids to the newest Copilot model of that family", () => {
    modelCatalog.set("claude-haiku-4.5", { maxOutput: 32000 });
    modelCatalog.set("claude-sonnet-4.6", { maxOutput: 64000 });
    modelCatalog.set("claude-opus-4.7", { maxOutput: 64000 });
    modelCatalog.set("claude-opus-4.8", { maxOutput: 64000 });
    expect(mapNativeModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.6");
    expect(mapNativeModel("claude-opus-4-1")).toBe("claude-opus-4.8");
    expect(mapNativeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5");
  });

  it("falls back to the default for unknown families or empty catalog", () => {
    expect(mapNativeModel("claude-sonnet-4-5")).toBe("claude-haiku-4.5");
    expect(mapNativeModel("gpt-9-ultra")).toBe("claude-haiku-4.5");
  });
});

describe("needsTranslation", () => {
  it("routes exact non-Claude catalog ids to the OpenAI path", async () => {
    const { needsTranslation, mapModel } = await import("../src/models.js");
    modelCatalog.set("gpt-4.1", { maxOutput: 16384 });
    modelCatalog.set("claude-haiku-4.5", { maxOutput: 32000 });
    expect(needsTranslation("gpt-4.1")).toBe(true);
    expect(needsTranslation("claude-haiku-4.5")).toBe(false);
    expect(needsTranslation("claude-sonnet-4-5")).toBe(false); // family-mapped, native
    expect(needsTranslation("gpt-unknown")).toBe(false); // not in catalog
    expect(mapModel("gpt-4.1")).toBe("gpt-4.1"); // translation keeps exact id
  });
});
