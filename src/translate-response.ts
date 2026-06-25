import { mapStopReason, THINKING_SIG } from "./models.js";

// OpenAI Chat Completions response -> Anthropic Messages response (non-streaming).
export function openAIToAnthropic(data: any) {
  const choice = data.choices?.[0] ?? { message: {} };
  const content: any[] = [];
  // Ollama thinking models return chain-of-thought in message.reasoning; map to
  // an Anthropic thinking block with a placeholder signature, ahead of the text.
  if (choice.message?.reasoning)
    content.push({ type: "thinking", thinking: choice.message.reasoning, signature: THINKING_SIG });
  if (choice.message?.content) content.push({ type: "text", text: choice.message.content });
  for (const tc of choice.message?.tool_calls ?? []) {
    let parsedInput: any = {};
    try {
      parsedInput = JSON.parse(tc.function.arguments || "{}");
    } catch {
      console.warn(`ccmux: failed to parse tool_call arguments for ${tc.function?.name}; using {}`);
    }
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: parsedInput,
    });
  }
  return {
    id: data.id ?? "msg_unknown",
    type: "message",
    role: "assistant",
    model: data.model ?? "",
    content,
    stop_reason: mapStopReason(choice.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
