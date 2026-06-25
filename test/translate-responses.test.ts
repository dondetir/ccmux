import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  anthropicToResponses,
  translateResponsesResponse,
  ResponsesApiUnsupported,
} from "../src/translate-responses.js";
import { modelCatalog } from "../src/models.js";

const base = { model: "gpt-5-mini", max_tokens: 1024 };

// Seed the catalog with a mock gpt-5-mini entry so mapModel returns it unchanged
beforeEach(() => {
  modelCatalog.set("gpt-5-mini", {
    maxOutput: 16384,
    efforts: ["low", "medium", "high"],
    supportedEndpoints: ["/responses"],
  });
});
afterEach(() => {
  modelCatalog.clear();
});

describe("anthropicToResponses", () => {
  it("converts simple user text message", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [{ role: "user", content: "hello" }],
    } as any);
    expect(payload.model).toBe("gpt-5-mini");
    expect(payload.input).toEqual([{ role: "user", content: "hello" }]);
    expect(payload.max_output_tokens).toBe(1024);
    expect(payload.instructions).toBeUndefined();
  });

  it("converts system prompt to instructions field", () => {
    const payload = anthropicToResponses({
      ...base,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.instructions).toBe("You are a helpful assistant.");
    expect(payload.input).not.toContain(expect.objectContaining({ role: "system" }));
  });

  it("joins system array blocks into instructions", () => {
    const payload = anthropicToResponses({
      ...base,
      system: [
        { type: "text", text: "Part A." },
        { type: "text", text: "Part B." },
      ],
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.instructions).toBe("Part A.\nPart B.");
  });

  it("converts tool_use block to function_call item with matching id and call_id", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_01abc", name: "get_weather", input: { city: "NYC" } },
          ],
        },
      ],
    } as any);
    expect(payload.input).toHaveLength(1);
    const fc = payload.input[0];
    expect(fc.type).toBe("function_call");
    expect(fc.id).toBe("toolu_01abc");
    expect(fc.call_id).toBe("toolu_01abc"); // 1:1 passthrough
    expect(fc.name).toBe("get_weather");
    expect(fc.arguments).toBe('{"city":"NYC"}');
  });

  it("converts tool_result to function_call_output with call_id matching tool_use_id", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01abc",
              content: [{ type: "text", text: "Sunny, 72F" }],
            },
          ],
        },
      ],
    } as any);
    expect(payload.input).toHaveLength(1);
    const fco = payload.input[0];
    expect(fco.type).toBe("function_call_output");
    expect(fco.call_id).toBe("toolu_01abc"); // matches the tool_use_id 1:1
    expect(fco.output).toBe("Sunny, 72F");
  });

  it("merges consecutive text blocks from the same message into one input item", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    } as any);
    // Should produce ONE merged item, not two
    expect(payload.input).toHaveLength(1);
    expect(payload.input[0]).toEqual({ role: "user", content: "Hello world" });
  });

  it("flushes pending text before function_call items (multi-block grouping)", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will check." },
            { type: "tool_use", id: "toolu_02", name: "check", input: {} },
          ],
        },
      ],
    } as any);
    // Text flushed first, then function_call
    expect(payload.input).toHaveLength(2);
    expect(payload.input[0]).toEqual({ role: "assistant", content: "I will check." });
    expect(payload.input[1].type).toBe("function_call");
  });

  it("maps flat tool schema — parameters renamed from input_schema, no function wrapper", () => {
    const payload = anthropicToResponses({
      ...base,
      tools: [
        { name: "search", description: "Search the web", input_schema: { type: "object" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.tools).toHaveLength(1);
    const t = payload.tools[0];
    expect(t.type).toBe("function");
    expect(t.name).toBe("search");
    expect(t.description).toBe("Search the web");
    expect(t.parameters).toEqual({ type: "object" });
    expect(t.function).toBeUndefined(); // no function wrapper
  });

  it("filters server tools", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = anthropicToResponses({
      ...base,
      tools: [
        { name: "read_file", description: "d", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      ],
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].name).toBe("read_file");
    warn.mockRestore();
  });

  it("maps output_config.effort to reasoning.effort using nearestEffort", () => {
    const payload = anthropicToResponses({
      ...base,
      output_config: { effort: "xhigh" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    // xhigh not in ["low","medium","high"] — nearestEffort picks "high" (highest below xhigh)
    expect(payload.reasoning).toEqual({ effort: "high" });
  });

  it("does not set reasoning when model has no effort support", () => {
    modelCatalog.set("gpt-5-mini", { maxOutput: 16384, efforts: [], supportedEndpoints: ["/responses"] });
    const payload = anthropicToResponses({
      ...base,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.reasoning).toBeUndefined();
  });

  it("maps tool_choice auto to 'auto'", () => {
    const payload = anthropicToResponses({
      ...base,
      tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.tool_choice).toBe("auto");
  });

  it("maps tool_choice any to 'required'", () => {
    const payload = anthropicToResponses({
      ...base,
      tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.tool_choice).toBe("required");
  });

  it("maps tool_choice {type:'tool', name} to {type:'function', name}", () => {
    const payload = anthropicToResponses({
      ...base,
      tools: [{ name: "search", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "search" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.tool_choice).toEqual({ type: "function", name: "search" });
  });

  it("maps tool_choice none to 'none' (no tools required)", () => {
    const payload = anthropicToResponses({
      ...base,
      tools: [{ name: "search", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "none" },
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.tool_choice).toBe("none");
  });

  it("throws ResponsesApiUnsupported for stop_sequences", () => {
    expect(() =>
      anthropicToResponses({
        ...base,
        stop_sequences: ["STOP"],
        messages: [{ role: "user", content: "hi" }],
      } as any),
    ).toThrow(ResponsesApiUnsupported);
  });

  it("warns and drops top_k", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = anthropicToResponses({
      ...base,
      top_k: 5,
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("top_k"));
    expect(payload.top_k).toBeUndefined();
    warn.mockRestore();
  });

  it("drops thinking/redacted_thinking blocks silently", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret" },
            { type: "text", text: "visible" },
          ],
        },
      ],
    } as any);
    // Only the text block should produce an item
    expect(payload.input).toHaveLength(1);
    expect(payload.input[0].content).toBe("visible");
  });

  it("sets stream: true when body.stream is true", () => {
    const payload = anthropicToResponses({
      ...base,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.stream).toBe(true);
  });

  it("forwards temperature and top_p when present", () => {
    const payload = anthropicToResponses({
      ...base,
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.temperature).toBe(0.7);
    expect(payload.top_p).toBe(0.9);
  });

  it("does not set temperature/top_p when absent", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(payload.temperature).toBeUndefined();
    expect(payload.top_p).toBeUndefined();
  });

  it("maps image block (url source) to input_image item", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this:" },
            { type: "image", source: { type: "url", url: "https://example.com/img.png" } },
          ],
        },
      ],
    } as any);
    // text flushed first, then image as standalone input item
    expect(payload.input).toHaveLength(2);
    expect(payload.input[0]).toEqual({ role: "user", content: "Describe this:" });
    expect(payload.input[1]).toEqual({
      role: "user",
      content: [{ type: "input_image", image_url: "https://example.com/img.png" }],
    });
  });

  it("maps image block (base64 source) to data: URL in input_image", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "abc123" },
            },
          ],
        },
      ],
    } as any);
    expect(payload.input).toHaveLength(1);
    expect(payload.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,abc123",
    });
  });

  it("warns and drops image block with unknown source type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "file_id", file_id: "xyz" } }],
        },
      ],
    } as any);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsupported image source"));
    expect(payload.input).toHaveLength(0); // dropped
    warn.mockRestore();
  });

  it("prefixes tool_result output with [tool_error] when is_error is true", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_err",
              is_error: true,
              content: [{ type: "text", text: "file not found" }],
            },
          ],
        },
      ],
    } as any);
    expect(payload.input[0].output).toBe("[tool_error] file not found");
  });

  it("does not prefix tool_result output when is_error is false/absent", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_ok",
              content: [{ type: "text", text: "success" }],
            },
          ],
        },
      ],
    } as any);
    expect(payload.input[0].output).toBe("success");
  });

  it("multi-turn: tool_use id in first turn matches call_id in second turn", () => {
    const payload = anthropicToResponses({
      ...base,
      messages: [
        { role: "user", content: "what's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_xyz", name: "weather", input: { city: "Austin" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_xyz",
              content: [{ type: "text", text: "Hot, 95F" }],
            },
          ],
        },
      ],
    } as any);
    const fcItem = payload.input.find((i: any) => i.type === "function_call");
    const fcoItem = payload.input.find((i: any) => i.type === "function_call_output");
    expect(fcItem.call_id).toBe("toolu_xyz");
    expect(fcoItem.call_id).toBe("toolu_xyz"); // must match
  });
});

describe("translateResponsesResponse", () => {
  it("converts output_text to text content block", () => {
    const res = translateResponsesResponse({
      id: "resp_123",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hello!" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.id).toBe("resp_123");
    expect(res.role).toBe("assistant");
    expect(res.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(res.stop_reason).toBe("end_turn");
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("converts function_call output item to tool_use block with call_id as id", () => {
    const res = translateResponsesResponse({
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_item_1",
          call_id: "toolu_01abc",
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
      ],
      usage: { input_tokens: 5, output_tokens: 10 },
    });
    expect(res.content).toHaveLength(1);
    const tu = res.content[0];
    expect(tu.type).toBe("tool_use");
    expect(tu.id).toBe("toolu_01abc"); // call_id used as Anthropic id
    expect(tu.name).toBe("get_weather");
    expect(tu.input).toEqual({ city: "NYC" });
  });

  it("maps status: incomplete to stop_reason: max_tokens", () => {
    const res = translateResponsesResponse({
      status: "incomplete",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(res.stop_reason).toBe("max_tokens");
  });

  it("maps incomplete_details.reason: max_output_tokens to max_tokens", () => {
    const res = translateResponsesResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(res.stop_reason).toBe("max_tokens");
  });

  it("maps status: failed to stop_reason: end_turn (error is not a valid Anthropic stop_reason)", () => {
    const res = translateResponsesResponse({
      status: "failed",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(res.stop_reason).toBe("end_turn");
  });

  it("drops reasoning items from output", () => {
    const res = translateResponsesResponse({
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "I thought..." }] },
        { type: "message", content: [{ type: "output_text", text: "Result" }] },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
  });

  it("handles malformed function_call arguments gracefully (uses empty input)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = translateResponsesResponse({
      status: "completed",
      output: [
        { type: "function_call", id: "fc_1", call_id: "toolu_1", name: "f", arguments: "not json" },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(res.content[0].input).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sets stop_reason: tool_use when completed with function_call output", () => {
    const res = translateResponsesResponse({
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_item_2",
          call_id: "toolu_02",
          name: "search",
          arguments: '{"q":"test"}',
        },
      ],
      usage: { input_tokens: 5, output_tokens: 10 },
    });
    expect(res.stop_reason).toBe("tool_use");
  });

  it("keeps stop_reason: max_tokens even when tool_use blocks present (truncation wins)", () => {
    const res = translateResponsesResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "function_call",
          id: "fc_item_3",
          call_id: "toolu_03",
          name: "foo",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(res.stop_reason).toBe("max_tokens");
  });
});
