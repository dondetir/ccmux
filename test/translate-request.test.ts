import { describe, it, expect, vi } from "vitest";
import { anthropicToOpenAI } from "../src/translate-request.js";
import { modelCatalog } from "../src/models.js";

const base = { model: "claude-sonnet-4.5", max_tokens: 1024 };

describe("anthropicToOpenAI", () => {
  it("maps text + tool_use to content + tool_calls", () => {
    const { payload } = anthropicToOpenAI({
      ...base,
      messages: [
        { role: "user", content: "what time is it?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "tu_1", name: "get_time", input: { tz: "UTC" } },
          ],
        },
      ],
    } as any);
    const asst = payload.messages.at(-1);
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("Checking.");
    expect(asst.tool_calls).toEqual([
      { id: "tu_1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } },
    ]);
  });

  it("assistant with ONLY tool_calls gets content: null", () => {
    const { payload } = anthropicToOpenAI({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "f", input: {} }],
        },
      ],
    } as any);
    expect(payload.messages.at(-1).content).toBeNull();
  });

  it("tool_result becomes a separate role:tool message; agent flag set", () => {
    const { payload, flags } = anthropicToOpenAI({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "3pm" }] },
            { type: "text", text: "continue" },
          ],
        },
      ],
    } as any);
    expect(payload.messages[0]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "3pm" });
    expect(payload.messages[1]).toEqual({ role: "user", content: "continue" });
    expect(flags.agent).toBe(true);
  });

  it("joins system array and strips cache_control/thinking", () => {
    const { payload } = anthropicToOpenAI({
      ...base,
      system: [
        { type: "text", text: "a", cache_control: { type: "ephemeral" } },
        { type: "text", text: "b" },
      ],
      thinking: { type: "enabled", budget_tokens: 1000 },
      metadata: { user_id: "x" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret", signature: "sig" },
            { type: "text", text: "visible" },
          ],
        },
      ],
    } as any);
    expect(payload.messages[0]).toEqual({ role: "system", content: "a\nb" });
    expect(payload.messages[1].content).toBe("visible");
    const json = JSON.stringify(payload);
    expect(json).not.toContain("cache_control");
    expect(json).not.toContain("thinking");
    expect(json).not.toContain("metadata");
  });

  it("filters server tools, maps client tools", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { payload } = anthropicToOpenAI({
      ...base,
      tools: [
        { name: "read_file", description: "d", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      ],
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0]).toEqual({
      type: "function",
      function: { name: "read_file", description: "d", parameters: { type: "object" } },
    });
    expect(JSON.stringify(payload)).not.toContain("cache_control");
    warn.mockRestore();
  });

  it("clamps max_tokens to the catalog limit", () => {
    modelCatalog.set("claude-sonnet-4.5", { maxOutput: 4096 });
    const { payload } = anthropicToOpenAI({
      ...base,
      max_tokens: 32000,
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.max_tokens).toBe(4096);
    modelCatalog.clear();
  });

  it("maps tool_choice and stop_sequences; sets stream_options; vision flag", () => {
    const { payload, flags } = anthropicToOpenAI({
      ...base,
      stream: true,
      stop_sequences: ["END"],
      tool_choice: { type: "any" },
      tools: [{ name: "f", description: "", input_schema: { type: "object" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    } as any);
    expect(payload.tool_choice).toBe("required");
    expect(payload.stop).toEqual(["END"]);
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(flags.vision).toBe(true);
    expect(payload.messages.at(-1).content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("skips empty content arrays", () => {
    const { payload } = anthropicToOpenAI({
      ...base,
      messages: [
        { role: "user", content: [] },
        { role: "user", content: "hi" },
      ],
    } as any);
    expect(payload.messages).toHaveLength(1);
  });
});
