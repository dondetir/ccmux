import { describe, it, expect, afterEach } from "vitest";
import { modelCatalog, needsResponsesApi, aliasModelId, unaliasModel, needsTranslation, loadCatalog } from "../src/models.js";

afterEach(() => {
  modelCatalog.clear();
});

describe("model id alias round-trip (/model picker discovery)", () => {
  it("aliases non-Claude ids so discovery keeps them", () => {
    expect(aliasModelId("gpt-4.1")).toBe("claude-gpt-4.1");
    expect(aliasModelId("gemini-2.5-pro")).toBe("claude-gemini-2.5-pro");
  });

  it("leaves claude-/anthropic- ids unchanged", () => {
    expect(aliasModelId("claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(aliasModelId("anthropic-x")).toBe("anthropic-x");
  });

  it("unaliases back to the real Copilot id when it is a catalog model", () => {
    modelCatalog.set("gpt-4.1", { maxOutput: 16384 });
    expect(unaliasModel("claude-gpt-4.1")).toBe("gpt-4.1");
  });

  it("does NOT strip a real Claude id (stripped form is not a catalog model)", () => {
    modelCatalog.set("claude-sonnet-4.5", { maxOutput: 65536 });
    expect(unaliasModel("claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
  });

  it("leaves an unaliasable claude- id alone (empty/offline catalog)", () => {
    expect(unaliasModel("claude-gpt-4.1")).toBe("claude-gpt-4.1");
  });

  it("self-heals: loadCatalog repopulates an empty catalog so aliases round-trip again", () => {
    // Startup fetch failed → empty catalog → aliased id can't be stripped and
    // would misroute to the native path (needsTranslation false).
    expect(unaliasModel("claude-gpt-4.1")).toBe("claude-gpt-4.1");
    expect(needsTranslation("claude-gpt-4.1")).toBe(false);
    // /v1/models self-heal repopulates from the live fetch before any selection.
    loadCatalog({ data: [{ id: "gpt-4.1", capabilities: { limits: {}, supports: {} } }] });
    expect(unaliasModel("claude-gpt-4.1")).toBe("gpt-4.1");
    expect(needsTranslation("gpt-4.1")).toBe(true);
  });
});

describe("needsResponsesApi", () => {
  it("returns false when catalog is empty (safe fallback to Path B)", () => {
    expect(needsResponsesApi("gpt-5-mini")).toBe(false);
  });

  it("returns true for model with only /responses endpoint", () => {
    modelCatalog.set("gpt-5-mini", { maxOutput: 1024, supportedEndpoints: ["/responses"] });
    expect(needsResponsesApi("gpt-5-mini")).toBe(true);
  });

  it("returns false for model with /chat/completions (Path B stays)", () => {
    modelCatalog.set("gpt-4.1", {
      maxOutput: 16384,
      supportedEndpoints: ["/chat/completions"],
    });
    expect(needsResponsesApi("gpt-4.1")).toBe(false);
  });

  it("returns true for dual-endpoint reasoning model (routes to Path C)", () => {
    // gpt-5.4 lists both endpoints but rejects tools + reasoning_effort on
    // /chat/completions, so it must use /responses.
    modelCatalog.set("gpt-5.4", {
      maxOutput: 16384,
      supportedEndpoints: ["/chat/completions", "/responses"],
    });
    expect(needsResponsesApi("gpt-5.4")).toBe(true);
  });

  it("returns false for Claude model (Path A/B, not C)", () => {
    modelCatalog.set("claude-sonnet-4.6", {
      maxOutput: 65536,
      supportedEndpoints: ["/v1/messages"],
    });
    expect(needsResponsesApi("claude-sonnet-4.6")).toBe(false);
  });

  it("returns false for model not in catalog", () => {
    expect(needsResponsesApi("unknown-model")).toBe(false);
  });

  it("returns false for model with empty supportedEndpoints array", () => {
    modelCatalog.set("gpt-5-mini", { maxOutput: 1024, supportedEndpoints: [] });
    expect(needsResponsesApi("gpt-5-mini")).toBe(false);
  });

  it("returns false for model with undefined supportedEndpoints", () => {
    modelCatalog.set("gpt-5-mini", { maxOutput: 1024 });
    expect(needsResponsesApi("gpt-5-mini")).toBe(false);
  });
});
