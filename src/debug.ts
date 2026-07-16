import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./env.js";

// CCMUX_DEBUG=1 (or `ccmux --debug`) dumps every inbound Anthropic request, the
// translated upstream request (auth redacted), and the upstream response
// (status + body, or raw SSE frames for streams) to ~/.config/ccmux/debug.log.
// The file is 0600 and the proxy is loopback-only, so prompts/code stay local.
// This is the authoritative way to confirm upstream rejections (e.g. the
// "invalid parameter" GPT-5 reasoning models return for temperature/top_p).
export const DEBUG = /^(1|true|yes)$/i.test(process.env.CCMUX_DEBUG ?? "");

const LOG = path.join(CONFIG_DIR, "debug.log");

let ensured = false;
function ensureLog(): void {
  if (ensured) return;
  ensured = true;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* non-posix */ }
  } catch { /* best effort */ }
}

function stamp(): string {
  return new Date().toISOString();
}

// Redact bearer tokens so credentials never land in the debug log.
function redactAuth(h: any): any {
  if (!h || typeof h !== "object") return h;
  const out: any = Array.isArray(h) ? [...h] : { ...h };
  for (const k of Object.keys(out)) {
    if (/^authorization$/i.test(k))
      out[k] = String(out[k]).replace(/(Bearer\s+)[^\s]+/i, "$1<redacted>");
  }
  return out;
}

function write(label: string, text: string): void {
  if (!DEBUG) return;
  ensureLog();
  try {
    fs.appendFileSync(LOG, `[${stamp()}] ${label}\n${text}\n\n`, { mode: 0o600 });
    try { fs.chmodSync(LOG, 0o600); } catch { /* non-posix */ }
  } catch {
    // Debug must never break a request.
  }
}

export function debugObj(label: string, obj: unknown): void {
  if (!DEBUG) return;
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  write(label, text);
}

export function debugInbound(path: string, body: unknown): void {
  debugObj(`>>> INBOUND ${path}`, body);
}

export function debugUpstreamRequest(
  method: string,
  url: string,
  headers: unknown,
  body: unknown,
): void {
  if (!DEBUG) return;
  write(
    `>>> UPSTREAM ${method} ${url}`,
    JSON.stringify({ headers: redactAuth(headers), body }, null, 2),
  );
}

export function debugUpstreamResponse(status: number, bodyText: string): void {
  debugObj(`<<< UPSTREAM status ${status}`, bodyText);
}

// Tee a response stream so every raw chunk is logged as it flows to the
// translator. Returns a new ReadableStream that yields the same bytes; the
// translator reads it exactly like the original upstream body.
export function debugTeeStream(
  stream: ReadableStream<Uint8Array>,
  label: string,
): ReadableStream<Uint8Array> {
  if (!DEBUG) return stream;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          c.close();
          return;
        }
        try {
          write(`${label} (stream chunk)`, decoder.decode(value, { stream: true }));
        } catch { /* ignore */ }
        c.enqueue(value);
      } catch (e) {
        c.error(e as any);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}
