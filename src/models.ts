import { COPILOT_BASE, COPILOT_HEADERS, OLLAMA_BASE, ollamaKey } from "./upstream.js";
import { getCopilotToken } from "./token.js";

// Populated once at startup from GET {COPILOT_BASE}/models. Empty catalog
// (offline/startup failure) means: no clamping, no scaling, default model ids.
export interface CatalogEntry {
  maxOutput: number;
  policy?: string;
  maxPrompt?: number; // capabilities.limits.max_prompt_tokens (0/undefined = unknown)
  adaptiveThinking?: boolean; // capabilities.supports.adaptive_thinking
  minThinking?: number; // capabilities.supports.min_thinking_budget
  maxThinking?: number; // capabilities.supports.max_thinking_budget
  efforts?: string[]; // capabilities.supports.reasoning_effort values
  supportedEndpoints?: string[]; // e.g. ["/chat/completions", "/responses"]
  provider?: "copilot" | "ollama"; // backend that serves this id (default copilot)
}
export const modelCatalog = new Map<string, CatalogEntry>();

export let SMALL_MODEL = ""; // cheapest available chat model, resolved at startup
let OPUS = "claude-opus-4";
let SONNET = "claude-sonnet-4.5";

// Populate the catalog from a parsed GET /models payload. Extracted so the
// /v1/models route can self-heal an empty catalog on the first client request,
// preventing aliased non-Claude ids from misrouting to the native path.
export function loadCatalog(data: any): void {
  for (const m of data?.data ?? []) {
    const sup = m.capabilities?.supports ?? {};
    modelCatalog.set(m.id, {
      maxOutput: m.capabilities?.limits?.max_output_tokens ?? 4096,
      policy: m.policy?.state,
      maxPrompt:
        m.capabilities?.limits?.max_prompt_tokens ??
        m.capabilities?.limits?.max_context_window_tokens,
      adaptiveThinking: sup.adaptive_thinking === true,
      minThinking: sup.min_thinking_budget,
      maxThinking: sup.max_thinking_budget,
      efforts: Array.isArray(sup.reasoning_effort) ? sup.reasoning_effort : [],
      supportedEndpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints : undefined,
    });
  }
  // Family defaults are Copilot-only: Ollama ids must not become SMALL_MODEL
  // or they route background calls to the wrong backend.
  const ids = [...modelCatalog.keys()].filter((id) => modelCatalog.get(id)?.provider !== "ollama");
  SMALL_MODEL = ids.find((id) => /-mini|nano/i.test(id)) ?? ids[0] ?? ""; // not /mini/: matches "gemini"
  if (!modelCatalog.has(OPUS)) OPUS = ids.find((id) => /opus/i.test(id)) ?? SONNET;
  if (!modelCatalog.has(SONNET)) SONNET = ids.find((id) => /sonnet/i.test(id)) ?? ids[0] ?? SONNET;
}

// True once any Copilot model is in the catalog. Must NOT be satisfied by
// ollama-only entries: a bare size>0 check would skip repopulation after a
// failed Copilot startup fetch, breaking self-heal for the proxy's lifetime.
export function copilotCatalogLoaded(): boolean {
  return [...modelCatalog.values()].some((e) => e.provider !== "ollama");
}

export async function initModelCatalog(): Promise<void> {
  try {
    const bearer = await getCopilotToken();
    const res = await fetch(`${COPILOT_BASE}/models`, {
      headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) throw new Error(`/models ${res.status}`);
    loadCatalog((await res.json()) as any);
  } catch (e: any) {
    console.warn(`model catalog unavailable (${e?.message ?? e}); using defaults, no max_tokens clamping`);
  }
}

// Ollama catalog: keyed `ollama/<id>` to avoid Copilot id collisions (prefix
// stripped on the wire). Context windows from a static table rather than a
// per-model fan-out at startup; gemma3:* skipped (no tool support).
const OLLAMA_DEFAULT_CTX = 262_144;
const OLLAMA_CTX: Record<string, number> = {
  "deepseek-v4-flash": 1_048_576, "gemini-3-flash-preview": 1_048_576,
  "glm-5.2": 1_000_000, "deepseek-v4-pro": 524_288, "minimax-m3": 524_288,
  "minimax-m2.1": 204_800, "glm-4.7": 202_752, "glm-5": 202_752, "glm-5.1": 202_752,
  "minimax-m2.5": 196_608, "minimax-m2.7": 196_608,
  "deepseek-v3.1:671b": 163_840, "deepseek-v3.2": 163_840,
  "gpt-oss:20b": 131_072, "gpt-oss:120b": 131_072, "rnj-1:8b": 32_768,
};
// Models with no thinking capability; reasoning_effort not advertised for these.
const OLLAMA_NONTHINK = new Set([
  "devstral-2:123b", "devstral-small-2:24b", "ministral-3:3b", "ministral-3:8b",
  "ministral-3:14b", "mistral-large-3:675b", "qwen3-coder-next", "qwen3-coder:480b",
  "rnj-1:8b",
]);

export async function loadOllamaCatalog(): Promise<void> {
  if (!ollamaKey()) return; // no key -> Ollama off, zero change for Copilot-only users
  try {
    const res = await fetch(`${OLLAMA_BASE}/models`, { headers: { Authorization: `Bearer ${ollamaKey()}` } });
    if (!res.ok) throw new Error(`/models ${res.status}`);
    const data: any = await res.json();
    for (const m of data?.data ?? []) {
      const id = m?.id;
      if (!id || String(id).startsWith("gemma3:")) continue; // gemma3: no tool support
      const ctx = OLLAMA_CTX[id] ?? OLLAMA_DEFAULT_CTX;
      modelCatalog.set(`ollama/${id}`, {
        // Ollama has no per-model output limit, only context_length. 32k covers
        // agentic edits; min(ctx) guards tiny-context models.
        maxOutput: Math.min(32_768, ctx),
        maxPrompt: ctx,
        efforts: OLLAMA_NONTHINK.has(id) ? [] : ["low", "medium", "high"],
        provider: "ollama",
      });
    }
  } catch (e: any) {
    console.warn(`ollama catalog unavailable (${e?.message ?? e}); ollama models disabled`);
  }
}

// Path A fallback: model substituted when Claude Code sends an id Copilot
// doesn't know. Free tier default is haiku-4.5; override with NATIVE_MODEL.
export const NATIVE_MODEL = process.env.NATIVE_MODEL ?? "claude-haiku-4.5";

export function mapNativeModel(m: string): string {
  if (modelCatalog.has(m)) return m; // exact Copilot id, pass through
  if (process.env.NATIVE_MODEL) return process.env.NATIVE_MODEL; // explicit override wins
  // Map Claude Code's Anthropic family ids to the newest Copilot Claude of
  // that family (haiku/sonnet/opus/fable).
  const fam = ["haiku", "sonnet", "opus", "fable"].find((f) => m.includes(f));
  if (fam) {
    const best = [...modelCatalog.keys()]
      .filter((id) => id.startsWith("claude-") && id.includes(fam))
      .sort()
      .at(-1);
    if (best) return best;
  }
  return NATIVE_MODEL;
}

// Auto-enable Copilot's one-time per-model policy consent on first use, so
// paid-plan users don't hit model_not_supported unexpectedly. Non-fatal.
const policyAttempted = new Set<string>();
export async function ensureModelPolicy(model: string): Promise<void> {
  const entry = modelCatalog.get(model);
  if (!entry || entry.policy === undefined || entry.policy === "enabled" || policyAttempted.has(model)) return;
  policyAttempted.add(model);
  try {
    const bearer = await getCopilotToken();
    const res = await fetch(`${COPILOT_BASE}/models/${model}/policy`, {
      method: "POST",
      headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ state: "enabled" }),
    });
    if (res.ok) {
      entry.policy = "enabled";
    }
  } catch {
    /* request still goes through; upstream error will surface if blocked */
  }
}

export function mapModel(m: string): string {
  if (modelCatalog.has(m)) return m; // exact Copilot id, keep it
  if (m.includes("haiku")) return SMALL_MODEL || SONNET;
  if (m.includes("opus")) return OPUS;
  return SONNET;
}

// Non-Claude catalog ids (gpt-*, gemini-*) must use the OpenAI translation
// path; the native /v1/messages endpoint is Claude-only.
export function needsTranslation(m: string): boolean {
  return modelCatalog.has(m) && !m.startsWith("claude-");
}

// Gateway model discovery only surfaces ids starting with claude-/anthropic-.
// Alias every other id as `claude-<id>` so gpt/gemini appear in the /model picker.
export function aliasModelId(id: string): string {
  return /^(claude|anthropic)-/.test(id) ? id : "claude-" + id;
}
// Strip the synthetic prefix back to the real Copilot id before routing, but
// ONLY when the stripped id is in the catalog (real Claude ids are left untouched).
// Requires a populated catalog; /v1/models self-heals an empty one before routing.
export function unaliasModel(m: string): string {
  if (!m.startsWith("claude-")) return m;
  const real = m.slice("claude-".length);
  return modelCatalog.has(real) && !real.startsWith("claude-") ? real : m;
}

// Route every /responses-capable model (the gpt-5 reasoning family) to Path C.
// Even dual-endpoint models like gpt-5.4 reject tools + reasoning_effort on
// /chat/completions ("use /v1/responses instead"), so /responses is the only
// path that works for them. Chat-only models (gpt-4o, gemini) fall through.
export function needsResponsesApi(model: string): boolean {
  return (modelCatalog.get(model)?.supportedEndpoints ?? []).includes("/responses");
}

export function clampMaxTokens(model: string, requested: number): number {
  const cap = modelCatalog.get(model)?.maxOutput;
  return cap ? Math.min(requested, cap) : requested;
}

// Claude Code assumes a 200k context window from the Anthropic model name.
// Copilot models often have smaller limits (e.g. haiku-4.5: 128k), so Claude
// Code would compact too late and hit upstream 400s. Scaling reported
// input-token counts by assumed/actual keeps context tracking accurate.
const ASSUMED_CONTEXT = Number(process.env.CLAUDE_CONTEXT_WINDOW ?? 200_000);

export function contextScale(model: string): number {
  const prompt = modelCatalog.get(model)?.maxPrompt;
  return prompt ? ASSUMED_CONTEXT / prompt : 1;
}

export function scaleUsage(usage: any, factor: number): void {
  if (!usage || factor === 1) return;
  for (const k of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
    if (typeof usage[k] === "number") usage[k] = Math.round(usage[k] * factor);
}

// Rewrite thinking + output_config.effort to what the serving model supports.
// Verified live: haiku-4.5 accepts thinking{enabled,budget_tokens}; the native
// endpoint validates output_config.effort per model (invalid_reasoning_effort).
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function nearestEffort(want: string, supported: string[]): string {
  if (supported.includes(want)) return want;
  const i = EFFORT_ORDER.indexOf(want);
  if (i === -1) {
    // Unknown future level: scan downward from max
    for (let j = EFFORT_ORDER.length - 1; j >= 0; j--)
      if (supported.includes(EFFORT_ORDER[j])) return EFFORT_ORDER[j];
    return supported[0];
  }
  // Closest supported level at or below the requested one
  for (let j = i; j >= 0; j--) if (supported.includes(EFFORT_ORDER[j])) return EFFORT_ORDER[j];
  // Nothing at or below: take the lowest supported level above
  for (let j = i + 1; j < EFFORT_ORDER.length; j++) if (supported.includes(EFFORT_ORDER[j])) return EFFORT_ORDER[j];
  return supported[0];
}

// Resolve effort to forward, or undefined to drop it. Only forwarded when the
// catalog confirms support; some Copilot endpoints 400 on unknown fields.
export function resolveEffort(model: string, want: unknown): string | undefined {
  const efforts = modelCatalog.get(model)?.efforts ?? [];
  if (typeof want === "string" && efforts.length) return nearestEffort(want, efforts);
  return undefined;
}

export function adaptBodyToModel(body: any): void {
  const entry = modelCatalog.get(body.model);

  const th = body.thinking;
  if (th) {
    const minB = entry?.minThinking ?? 1024;
    const capB = Math.min(entry?.maxThinking ?? Infinity, (body.max_tokens ?? Infinity) - 1);
    if (th.type === "adaptive" && entry && !entry.adaptiveThinking) {
      // model supports explicit budget but not adaptive (e.g. haiku-4.5)
      if (entry.maxThinking && capB >= minB) body.thinking = { type: "enabled", budget_tokens: capB };
      else delete body.thinking;
    } else if (th.type === "enabled") {
      const budget = Math.min(Math.max(th.budget_tokens ?? minB, minB), capB);
      if (budget >= minB) th.budget_tokens = budget;
      else delete body.thinking;
    } else if (th.type === "adaptive" && !entry) {
      delete body.thinking; // catalog unavailable; upstream may 400 on adaptive
    } else if (th.type !== "adaptive" && th.type !== "disabled") {
      delete body.thinking; // unknown future mode; drop to be safe
    }
  }

  if (body.output_config !== undefined) {
    const efforts = entry?.efforts ?? [];
    const effort = body.output_config?.effort;
    // keep only effort; other output_config fields are unverified upstream
    if (typeof effort === "string" && efforts.length) {
      body.output_config = { effort: nearestEffort(effort, efforts) };
    } else {
      delete body.output_config;
    }
  }
}

// Placeholder signature for thinking blocks synthesized from Ollama `reasoning`.
// Claude Code requires a signature field; value is never verified upstream
// because anthropicToOpenAI drops thinking blocks on the return trip.
export const THINKING_SIG = "b2xsYW1h"; // base64 "ollama"

export function mapStopReason(f: string | null): string {
  return (
    ({ stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" } as Record<string, string>)[
      f ?? ""
    ] ?? "end_turn"
  );
}
