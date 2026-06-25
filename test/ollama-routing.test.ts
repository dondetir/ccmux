import { describe, it, expect, afterEach, vi } from "vitest";
import {
  modelCatalog,
  loadOllamaCatalog,
  copilotCatalogLoaded,
  contextScale,
  clampMaxTokens,
  needsTranslation,
  aliasModelId,
  unaliasModel,
} from "../src/models.js";
import { callCopilot } from "../src/upstream.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  modelCatalog.clear();
  globalThis.fetch = realFetch;
  delete process.env.OLLAMA_API_KEY;
});

describe("copilotCatalogLoaded (self-heal gate must ignore ollama-only entries)", () => {
  it("stays false when the catalog holds only ollama entries, so /v1/models still repopulates Copilot", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "glm-5.2" }] }),
    })) as any;

    await loadOllamaCatalog();

    expect(modelCatalog.size).toBeGreaterThan(0); // ollama filled the map...
    expect(copilotCatalogLoaded()).toBe(false); // ...but a size>0 check must NOT block the Copilot self-heal
  });

  it("is true once any Copilot entry is present", () => {
    modelCatalog.set("gpt-4.1", { maxOutput: 4096 }); // no provider tag -> copilot
    expect(copilotCatalogLoaded()).toBe(true);
  });
});

describe("loadOllamaCatalog", () => {
  it("populates namespaced ollama/<id> entries with ctx + effort from the static table", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "glm-5.2" }, { id: "qwen3-coder:480b" }, { id: "gemma3:27b" }, { id: "brand-new-model" }],
      }),
    })) as any;

    await loadOllamaCatalog();

    const glm = modelCatalog.get("ollama/glm-5.2");
    expect(glm?.provider).toBe("ollama");
    expect(glm?.maxPrompt).toBe(1_000_000); // from static table
    expect(glm?.maxOutput).toBe(32_768); // Ollama has no output limit -> generous cap, not 16k
    expect(glm?.efforts).toEqual(["low", "medium", "high"]); // thinking model

    const qwen = modelCatalog.get("ollama/qwen3-coder:480b");
    expect(qwen?.efforts).toEqual([]); // non-thinking -> no reasoning_effort advertised
    expect(qwen?.maxPrompt).toBe(262_144); // default ctx

    expect(modelCatalog.has("ollama/gemma3:27b")).toBe(false); // no tools -> skipped
    expect(modelCatalog.get("ollama/brand-new-model")?.maxPrompt).toBe(262_144); // unknown -> default ctx
  });

  it("is a no-op when no key is configured", async () => {
    globalThis.fetch = vi.fn() as any;
    await loadOllamaCatalog();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(modelCatalog.size).toBe(0);
  });
});

describe("ollama namespacing (resolve on the namespaced key, strip only on the wire)", () => {
  it("contextScale / clamp / routing all resolve for a namespaced ollama id", () => {
    modelCatalog.set("ollama/glm-5.2", { maxOutput: 16_384, maxPrompt: 1_000_000, efforts: ["low"], provider: "ollama" });
    expect(contextScale("ollama/glm-5.2")).toBeCloseTo(0.2); // 200k / 1000k -> Claude Code gets more room
    expect(clampMaxTokens("ollama/glm-5.2", 999_999)).toBe(16_384);
    expect(needsTranslation("ollama/glm-5.2")).toBe(true); // non-claude catalog id -> Path B
  });

  it("alias round-trips through Claude Code's discovery filter", () => {
    modelCatalog.set("ollama/glm-5.2", { maxOutput: 16_384, provider: "ollama" });
    expect(aliasModelId("ollama/glm-5.2")).toBe("claude-ollama/glm-5.2");
    expect(unaliasModel("claude-ollama/glm-5.2")).toBe("ollama/glm-5.2");
  });
});

describe("callCopilot ollama dispatch", () => {
  it("hits the Ollama endpoint and strips the ollama/ prefix on the wire", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    let captured: any = {};
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true } as any;
    }) as any;

    await callCopilot({ model: "ollama/glm-5.2", messages: [] }, {}, "ollama");

    expect(String(captured.url)).toContain("ollama.com/v1/chat/completions");
    expect(captured.body.model).toBe("glm-5.2"); // prefix stripped here only
  });
});
