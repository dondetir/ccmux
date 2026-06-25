import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  PORT,
  USE_NATIVE,
  COPILOT_BASE,
  COPILOT_HEADERS,
  callCopilot,
  callCopilotNative,
  callCopilotResponses,
  countTokensUpstream,
} from "./upstream.js";
import { getCopilotToken, tokenStartupCheck } from "./token.js";
import {
  initModelCatalog,
  loadOllamaCatalog,
  loadCatalog,
  copilotCatalogLoaded,
  mapNativeModel,
  clampMaxTokens,
  ensureModelPolicy,
  needsTranslation,
  needsResponsesApi,
  aliasModelId,
  unaliasModel,
  adaptBodyToModel,
  contextScale,
  scaleUsage,
  modelCatalog,
  NATIVE_MODEL,
} from "./models.js";
import { anthropicToOpenAI } from "./translate-request.js";
import { openAIToAnthropic } from "./translate-response.js";
import { translateStream } from "./stream.js";
import { rewriteNativeStream } from "./native-stream.js";
import { anthropicToResponses, translateResponsesResponse, ResponsesApiUnsupported } from "./translate-responses.js";
import { translateResponsesStream } from "./responses-stream.js";
import { startIdleReaper } from "./sessions.js";

const app = new Hono();

const NATIVE_ALLOWED = new Set([
  "model", "max_tokens", "messages", "system", "tools", "tool_choice",
  "temperature", "top_p", "top_k", "stop_sequences", "stream", "thinking",
  "output_config",
]);

// Models this plan turned out not to serve (mapped model -> fallback).
const downgraded = new Map<string, string>();

// Applies family mapping, then remembered per-plan downgrades.
function resolveModel(raw: string): string {
  const mapped = mapNativeModel(raw);
  return downgraded.get(mapped) ?? mapped;
}

// Mirror upstream errors so Claude Code's retry logic keeps working: it backs
// off on 429/529 specifically. Never flatten to 502.
async function mirrorError(c: Context, up: Response, preRead?: string) {
  const type =
    up.status === 429 ? "rate_limit_error" : up.status >= 500 ? "api_error" : "invalid_request_error";
  const ra = up.headers.get("retry-after");
  if (ra) c.header("Retry-After", ra);
  const text = preRead ?? (await up.text());
  return c.json({ type: "error", error: { type, message: text } }, up.status as any);
}

app.post("/v1/messages", async (c) => {
  const body = await c.req.json();
  // The /model picker may send an aliased id (claude-gpt-4.1); restore the real
  // Copilot id so path selection + scaling use it.
  body.model = unaliasModel(body.model ?? "");
  try {
    // Path A: native pass-through. GPT/Gemini ids always use the translation path;
    // Claude goes native when USE_NATIVE is set.
    if (USE_NATIVE && !needsTranslation(body.model ?? "")) {
      body.model = resolveModel(body.model ?? "");
      if (body.max_tokens) body.max_tokens = clampMaxTokens(body.model, body.max_tokens);
      // Copilot's native endpoint (Vertex Claude) validates strictly and 400s on
      // unknown fields. Allowlist instead of chasing each new field Claude Code adds.
      for (const k of Object.keys(body))
        if (!NATIVE_ALLOWED.has(k)) delete body[k];
      // Rewrite thinking + output_config.effort to what the serving model supports.
      adaptBodyToModel(body);
      await ensureModelPolicy(body.model);
      let up = await callCopilotNative(body);
      // Downgrade once to NATIVE_MODEL if the plan doesn't serve the mapped model,
      // and remember it so future requests don't repeat the probe.
      if (up.status === 400 && body.model !== NATIVE_MODEL) {
        const txt = await up.text();
        if (txt.includes("model_not_supported")) {
          console.warn(`${body.model} not available on this plan; falling back to ${NATIVE_MODEL}`);
          downgraded.set(body.model, NATIVE_MODEL);
          body.model = NATIVE_MODEL;
          if (body.max_tokens) body.max_tokens = clampMaxTokens(body.model, body.max_tokens);
          adaptBodyToModel(body);
          up = await callCopilotNative(body);
        } else {
          return c.json({ type: "error", error: { type: "invalid_request_error", message: txt } }, 400);
        }
      }
      if (!up.ok) {
        const txt = await up.text();
        return mirrorError(c, up, txt);
      }
      const factor = contextScale(body.model);
      if (body.stream) {
        c.header("Content-Type", "text/event-stream");
        return stream(c, async (s) => {
          for await (const evt of rewriteNativeStream(up.body!, factor, () => {}, () => {}))
            await s.write(evt);
        });
      }
      const json: any = await up.json();
      scaleUsage(json.usage, factor);
      return c.json(json);
    }

    // Path C: Responses API for models that only expose /responses (gpt-5*, mai-code-1*).
    if (needsResponsesApi(body.model ?? "")) {
      let responsesPayload: any;
      try {
        responsesPayload = anthropicToResponses(body);
      } catch (e: any) {
        if (e instanceof ResponsesApiUnsupported) {
          return c.json({ type: "error", error: { type: "invalid_request_error", message: e.message } }, 400);
        }
        throw e;
      }
      const up = await callCopilotResponses(responsesPayload);
      if (!up.ok) {
        const txt = await up.text();
        return mirrorError(c, up, txt);
      }
      const factor = contextScale(responsesPayload.model);
      if (body.stream) {
        c.header("Content-Type", "text/event-stream");
        return stream(c, async (s) => {
          for await (const evt of translateResponsesStream(up.body!, () => {}, factor, () => {}))
            await s.write(evt);
        });
      }
      const res = translateResponsesResponse(await up.json());
      scaleUsage(res.usage, factor);
      return c.json(res);
    }

    // Path B: translation. Ollama models hit Ollama's OpenAI-compatible endpoint;
    // everything else hits Copilot's.
    const { payload, flags } = anthropicToOpenAI(body);
    const provider = modelCatalog.get(body.model)?.provider ?? "copilot";
    const up = await callCopilot(payload, flags, provider);
    if (!up.ok) {
      const txt = await up.text();
      return mirrorError(c, up, txt);
    }
    const factor = contextScale(payload.model);

    if (body.stream) {
      c.header("Content-Type", "text/event-stream");
      return stream(c, async (s) => {
        for await (const evt of translateStream(up.body!, () => {}, factor, () => {}))
          await s.write(evt);
      });
    }
    const res = openAIToAnthropic(await up.json());
    scaleUsage(res.usage, factor);
    return c.json(res);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return c.json({ type: "error", error: { type: "proxy_error", message: msg } }, 500);
  }
});

// Claude Code calls this for context management. Must never 404.
app.post("/v1/messages/count_tokens", async (c) => {
  const body = await c.req.json();
  // Apply same model resolution as /v1/messages so counts match the serving model.
  body.model = resolveModel(unaliasModel(body.model ?? ""));
  const factor = contextScale(body.model);
  // Ollama has no token-count endpoint; fall through to the local estimate.
  if ((modelCatalog.get(body.model)?.provider ?? "copilot") !== "ollama") {
    const upstream = await countTokensUpstream(body);
    if (upstream !== null) return c.json({ input_tokens: Math.round(upstream * factor) });
  }
  // Fallback: ~4 chars/token. Include tools — they dominate Claude Code payloads
  // and omitting them badly skews context management.
  const text =
    JSON.stringify(body.system ?? "") +
    JSON.stringify(body.messages ?? []) +
    JSON.stringify(body.tools ?? "");
  return c.json({ input_tokens: Math.round((text.length / 4) * factor) });
});

app.get("/v1/models", async (c) => {
  let data: any;
  try {
    const t = await getCopilotToken();
    const res = await fetch(`${COPILOT_BASE}/models`, {
      headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${t}` },
    });
    // Mirror upstream errors so proxyUp()'s auth-readiness gate fails correctly.
    if (!res.ok) return mirrorError(c, res);
    data = await res.json();
    // Self-heal: if the startup catalog fetch failed, repopulate from this live
    // fetch. Gate on copilotCatalogLoaded(), not map size, because Ollama entries
    // can pre-fill the map and defeat a size===0 check.
    if (!copilotCatalogLoaded()) loadCatalog(data);
  } catch (e) {
    // If Copilot has no credentials but Ollama is configured, serve the Ollama
    // catalog alone so the proxy is usable Ollama-only. If the Copilot catalog
    // was already loaded (transient failure), propagate instead of silently degrading.
    const ollamaOnly = !copilotCatalogLoaded() && [...modelCatalog.values()].some((m) => m.provider === "ollama");
    if (!ollamaOnly) throw e;
    data = { data: [] };
  }
  // Same filter the official Copilot CLI uses: only models it groups in its picker.
  data.data = (data.data ?? []).filter((m: any) => m.model_picker_category != null);
  // Push Ollama models so the alias loop below includes them in the picker.
  for (const [key, entry] of modelCatalog) {
    if (entry.provider !== "ollama") continue;
    (data.data ??= []).push({
      id: key,
      name: key.slice("ollama/".length),
      capabilities: { limits: { max_context_window_tokens: entry.maxPrompt, max_output_tokens: entry.maxOutput } },
      _ccmux_backend: "ollama",
    });
  }
  // Prefix non-Claude ids so Claude Code's gateway discovery lists gpt/gemini
  // in /model (it filters to claude-/anthropic-). unaliasModel reverses it on
  // inbound requests. Fold backend + context size into display_name for the picker.
  for (const m of data?.data ?? []) {
    if (!m?.id) continue;
    const backend =
      (m._ccmux_backend ?? modelCatalog.get(m.id)?.provider ?? "copilot") === "ollama" ? "ollama" : "copilot";
    const ctx = m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens;
    const ctxStr = ctx ? ` (${Math.round(ctx / 1000)}k ctx)` : "";
    m.display_name = `${m.name ?? m.id} [${backend}]${ctxStr}`;
    delete m._ccmux_backend;
    m.id = aliasModelId(m.id);
  }
  return c.json(data);
});

// Auth-only mode: resolve and persist a GitHub token, then exit without serving.
// The CLI runs this with a TTY so device flow can prompt; the proxy itself starts
// headless and cannot.
if (process.argv.includes("--login")) {
  getCopilotToken()
    .then(() => {
      console.log("ccmux: GitHub Copilot authentication ready.");
      process.exit(0);
    })
    .catch((e) => {
      console.error("ccmux: login failed:", e?.message ?? e);
      process.exit(1);
    });
} else {
  tokenStartupCheck();
  initModelCatalog().catch(() => {});
  loadOllamaCatalog().catch(() => {});

  // Bind loopback only. This server forwards Copilot credentials and intentionally
  // ignores the client's API key.
  serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
    console.log(
      `ccmux on http://127.0.0.1:${PORT} (${USE_NATIVE ? "native" : "translation"} path)`,
    );
  });

  // When started by `ccmux claude` (MANAGED), shut down once all sessions end.
  startIdleReaper();
}
