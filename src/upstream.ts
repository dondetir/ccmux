import "./env.js"; // load .env BEFORE any env reads below
import { getCopilotToken } from "./token.js";
import { debugUpstreamRequest } from "./debug.js";
import type { TranslateFlags } from "./types.js";

export const PORT = Number(process.env.PORT ?? 4141);

// Set USE_NATIVE=1 to use Path A (native pass-through). Default uses translation.
export const USE_NATIVE = process.env.USE_NATIVE === "1";

// ⚠️ UNOFFICIAL — not in GitHub's public API docs. Community defaults.
// Env-overridable so tests can point at a mock upstream.
export const TOKEN_EXCHANGE_URL =
  process.env.TOKEN_EXCHANGE_URL ?? "https://api.github.com/copilot_internal/v2/token";
// Live plan/quota snapshot (token_based_billing, quota_snapshots, reset date).
export const COPILOT_USER_URL =
  process.env.COPILOT_USER_URL ?? "https://api.github.com/copilot_internal/user";
export const COPILOT_BASE = process.env.COPILOT_BASE ?? "https://api.githubcopilot.com";

// Ollama Cloud: OpenAI-compatible backend, static API key (no exchange/expiry).
// Empty key = Ollama disabled.
export const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "https://ollama.com/v1";
// Lazy read so a key saved by `ccmux login` is picked up without a module reload.
export const ollamaKey = (): string => process.env.OLLAMA_API_KEY ?? "";

// Client-identity headers Copilot's backend expects. Versions drift; if you get
// a 4xx that mentions editor/version, bump these.
export const COPILOT_HEADERS: Record<string, string> = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.99.0",
  "Editor-Plugin-Version": "copilot-chat/0.26.0",
  "User-Agent": "GitHubCopilotChat/0.26.0",
  "Openai-Intent": "conversation-panel",
  "Content-Type": "application/json",
};

// Path B: send an OpenAI-format body to the chat endpoint.
export async function callCopilot(
  openaiBody: unknown,
  flags: Partial<TranslateFlags> = {},
  provider: "copilot" | "ollama" = "copilot",
): Promise<Response> {
  // Strip the `ollama/` namespace prefix before sending on the wire.
  if (provider === "ollama") {
    const body = openaiBody as any;
    const wire = { ...body, model: String(body.model ?? "").replace(/^ollama\//, "") };
    const url = `${OLLAMA_BASE}/chat/completions`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${ollamaKey()}` };
    debugUpstreamRequest("POST", url, headers, wire);
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(wire),
    });
  }
  const bearer = await getCopilotToken();
  const headers: Record<string, string> = { ...COPILOT_HEADERS, Authorization: `Bearer ${bearer}` };
  headers["X-Initiator"] = flags.agent ? "agent" : "user";
  if (flags.vision) headers["Copilot-Vision-Request"] = "true";
  const url = `${COPILOT_BASE}/chat/completions`;
  debugUpstreamRequest("POST", url, headers, openaiBody);
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(openaiBody),
  });
}

// Path A: forward the Anthropic body unchanged to Copilot's native endpoint.
export async function callCopilotNative(anthropicBody: unknown): Promise<Response> {
  const bearer = await getCopilotToken();
  const headers = {
    ...COPILOT_HEADERS,
    Authorization: `Bearer ${bearer}`,
    "anthropic-version": "2023-06-01",
  };
  const url = `${COPILOT_BASE}/v1/messages`;
  debugUpstreamRequest("POST", url, headers, anthropicBody);
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(anthropicBody),
  });
}

// Path C: Responses API. Endpoint is /responses (no /v1 prefix); returns 400
// model_not_supported on free tier, not 404.
export async function callCopilotResponses(responsesBody: unknown): Promise<Response> {
  const bearer = await getCopilotToken();
  const headers = { ...COPILOT_HEADERS, Authorization: `Bearer ${bearer}` };
  const url = `${COPILOT_BASE}/responses`;
  debugUpstreamRequest("POST", url, headers, responsesBody);
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(responsesBody),
  });
}

// Proxy to the native count endpoint; returns null so the caller uses a local
// estimate. The route must never 404.
export async function countTokensUpstream(anthropicBody: unknown): Promise<number | null> {
  try {
    const bearer = await getCopilotToken();
    const headers = {
      ...COPILOT_HEADERS,
      Authorization: `Bearer ${bearer}`,
      "anthropic-version": "2023-06-01",
    };
    const url = `${COPILOT_BASE}/v1/messages/count_tokens`;
    debugUpstreamRequest("POST", url, headers, anthropicBody);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
    });
    if (res.ok) return ((await res.json()) as any).input_tokens ?? null;
  } catch {
    /* fall through to local estimate */
  }
  return null;
}
