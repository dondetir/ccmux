// Shared types. Kept loose on purpose: the proxy passes through fields it
// doesn't understand and strips the ones upstream rejects (allowed-field rule).

export interface AnthropicContentBlock {
  type: string; // text | image | tool_use | tool_result | thinking | redacted_thinking
  [key: string]: any;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: any[];
  tool_choice?: { type: string; name?: string };
  stop_sequences?: string[];
  temperature?: number;
  stream?: boolean;
  [key: string]: any;
}

export interface TranslateFlags {
  vision: boolean; // any image block present -> Copilot-Vision-Request header
  agent: boolean;  // last message contains a tool_result -> X-Initiator: agent
}
