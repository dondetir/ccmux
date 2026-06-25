#!/usr/bin/env node
// ccmux CLI launcher. Plain .mjs, no build step (tsx not required to run this file).
// `ccmux claude` starts the proxy if needed, gates on /v1/models (auth ready),
// and injects ANTHROPIC_BASE_URL + model discovery into the spawned session.
// No ~/.claude/settings.json edits needed or made.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const PORT = Number(process.env.PORT ?? 4141);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = process.env.HOME || process.env.USERPROFILE;
const SESSIONS_DIR = join(HOME || "", ".config", "ccmux", "sessions");
const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "https://ollama.com/v1";
const GH_COPILOT_DIR = join(HOME || "", ".config", "github-copilot");
// Mirrors what the proxy reads: token.ts checks apps.json and hosts.json;
// env.ts loads ./.env (cwd=ROOT) then ~/.config/ccmux/env. Regex is anchored
// to match env.ts's key parser (no leading whitespace allowed).
const ENV_FILES = [join(ROOT, ".env"), join(HOME || "", ".config", "ccmux", "env")];
function envFilesHave(re) {
  return ENV_FILES.some((p) => {
    try { return readFileSync(p, "utf8").split("\n").some((l) => re.test(l)); }
    catch { return false; }
  });
}
const hasCopilotCreds = () =>
  !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) ||
  existsSync(join(GH_COPILOT_DIR, "apps.json")) ||
  existsSync(join(GH_COPILOT_DIR, "hosts.json")) ||
  envFilesHave(/^(GH_TOKEN|GITHUB_TOKEN)=/);
const hasOllamaKey = () =>
  !!process.env.OLLAMA_API_KEY || envFilesHave(/^OLLAMA_API_KEY=/);

const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
})();

// ANSI helpers (degrade gracefully outside a TTY or when NO_COLOR is set).
const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", mag: "\x1b[35m" };
const HAS_COLOR = process.stdout.isTTY && !/^(0|false|no)$/i.test(process.env.NO_COLOR ?? "");
const paint = (code, t) => (HAS_COLOR ? `${code}${t}${C.reset}` : t);

function hero() {
  const font = {
    c: [" ███ ", "██   ", "██   ", " ███ "],
    m: ["█   █", "██ ██", "█ █ █", "█   █"],
    u: ["█   █", "█   █", "█   █", " ███ "],
    x: ["█   █", " ██  ", "  ██ ", "█   █"],
  };
  const word = ["c", "c", "m", "u", "x"];
  const rows = [0, 1, 2, 3].map((r) => word.map((ch) => font[ch][r]).join(" "));
  const ramp = [51, 45, 39, 99, 135, 171, 207, 213];
  const gradRow = (r) => {
    if (!HAS_COLOR) return r;
    const W = r.length;
    let out = "";
    for (let i = 0; i < W; i++) {
      const ch = r[i];
      if (ch === " ") { out += " "; continue; }
      const idx = Math.min(ramp.length - 1, Math.round((i / (W - 1)) * (ramp.length - 1)));
      out += `\x1b[1;38;5;${ramp[idx]}m${ch}\x1b[0m`;
    }
    return out;
  };
  const art = rows.map(gradRow).join("\n");
  const tag = `${paint(C.bold, "Speaks Anthropic.")} ${paint(C.dim, "Routes to Copilot + Ollama.")}`;
  const rule = "─".repeat(58);
  // Right-align the version to the rule width so it sits in the top-right corner.
  const ver = paint(C.cyan, "v" + VERSION);
  const vraw = `v${VERSION}`;
  const pad = Math.max(0, rule.length - vraw.length);
  const verRow = " ".repeat(pad) + ver;
  return `\n${verRow}\n${art}\n\n  ${tag}\n${paint(C.dim, rule)}\n`;
}

const USAGE = `${hero()}${paint(C.bold, "Usage:")} ccmux <command> [args]

${paint(C.cyan, "Commands:")}
  claude [args...]   Start the proxy (if needed) + launch Claude Code through it
  serve              Run the proxy in the foreground on http://127.0.0.1:${PORT}
  login copilot      GitHub device-flow login (saves token, auto-restarts proxy)
  login ollama       Paste (or set OLLAMA_API_KEY) an Ollama Cloud key, validate, auto-restart proxy
  logout             Remove saved tokens (GitHub + Ollama) + VS Code Copilot
                     tokens + stop the proxy. Use \`eval "$(ccmux logout)"\` to also
                     clear exported tokens in the current shell
  help               Show this help

${paint(C.mag, "Environment")} ${paint(C.dim, "(or ~/.config/ccmux/env):")}
  NATIVE_MODEL  Override the model served to Claude Code (default claude-haiku-4.5)
  PORT          Proxy port, localhost only (default ${PORT})

${paint(C.dim, "More env vars (USE_NATIVE, CLAUDE_CONTEXT_WINDOW, GH_TOKEN, OLLAMA_API_KEY): see README.")}
${paint(C.dim, "Logs stream to ~/.config/ccmux/proxy.log.")}`;
// Register this launcher PID so a MANAGED proxy can tell when no session is
// using it (startIdleReaper in sessions.ts checks this dir). Prune dead pids
// on entry so a killed launcher can't leave the dir growing indefinitely.
function registerSession() {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(SESSIONS_DIR)) {
      const pid = Number(f);
      let alive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch {}
      }
      if (!alive) { try { rmSync(join(SESSIONS_DIR, f)); } catch {} }
    }
    writeFileSync(join(SESSIONS_DIR, String(process.pid)), "", { mode: 0o600 });
  } catch (e) {
    // Write failure means the reaper can't see this session and may
    // self-stop the proxy mid-session, so surface rather than swallow.
    console.warn("ccmux: failed to register session, proxy may self-stop:", e.message);
  }
}
function deregisterSession() {
  try { rmSync(join(SESSIONS_DIR, String(process.pid))); } catch {}
}

function proxyUp() {
  return fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
}

async function waitForProxy(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await proxyUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function resolveProxyCommand() {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  return existsSync(tsx) ? { cmd: tsx, args: ["src/index.ts"] } : { cmd: "npx", args: ["tsx", "src/index.ts"] };
}

function startProxy() {
  if (!HOME) {
    console.error("ccmux: HOME (or USERPROFILE on Windows) must be set");
    process.exit(1);
  }
  const logDir = join(HOME, ".config", "ccmux");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700); // ensure mode on existing dirs
  const log = join(logDir, "proxy.log");
  const { cmd, args } = resolveProxyCommand();
  const fd = (() => {
    try {
      const f = openSync(log, "a", 0o600);
      chmodSync(log, 0o600); // ensure mode despite umask
      return f;
    } catch {
      return undefined;
    }
  })();
  const stdio = fd === undefined ? "ignore" : ["ignore", fd, fd];
  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    stdio,
    // USE_NATIVE=1: default native pass-through; USE_NATIVE=0 opts out.
    // CCMUX_MANAGED=1: proxy was booted for `ccmux claude` sessions; self-stops
    // when none remain (startIdleReaper). `serve` does not set this flag.
    env: { ...process.env, USE_NATIVE: process.env.USE_NATIVE ?? "1", CCMUX_MANAGED: "1" },
  });
  child.unref();
}

// TCP-listen check (lighter than proxyUp, which gates on Copilot auth).
// Confirms the server booted even when only Ollama is configured.
function portOpen(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: PORT });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(t); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(t); resolve(false); });
  });
}

async function waitForPort(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// -sTCP:LISTEN targets only the process holding the listen socket, never a
// connected client, so this can't accidentally kill an active Claude session.
function stopProxy() {
  const lsofRes = spawnSync("lsof", ["-ti:" + PORT, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (lsofRes.error) {
    console.warn("ccmux: lsof not found; couldn't stop a running proxy. Kill it manually if the port is taken.");
    return false;
  }
  const pids = lsofRes.stdout?.trim();
  let stopped = false;
  if (pids) for (const pid of pids.split("\n")) { try { process.kill(Number(pid)); stopped = true; } catch {} }
  return stopped;
}

// Restart so a freshly saved credential takes effect immediately. The model
// catalog loads once at startup, so a new key isn't visible until restart.
async function restartProxy() {
  const wasRunning = stopProxy();
  if (wasRunning) await new Promise((r) => setTimeout(r, 800)); // let the old socket release
  startProxy();
  const up = await waitForPort();
  if (up) console.log(`ccmux: proxy ${wasRunning ? "restarted" : "started"} on ${BASE}`);
  else console.error("ccmux: proxy did not come up. Check ~/.config/ccmux/proxy.log");
}

function runProxyForeground() {
  if (!HOME) {
    console.error("ccmux: HOME (or USERPROFILE on Windows) must be set");
    process.exit(1);
  }
  const { cmd, args } = resolveProxyCommand();
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, USE_NATIVE: process.env.USE_NATIVE ?? "1" },
  });
  child.once("close", (code) => process.exit(code ?? 0));
}

// Run --login in the foreground (TTY attached) so the GitHub device flow can
// prompt. No-op when a token already resolves from env, .env, or VS Code config.
function runLogin() {
  const { cmd, args } = resolveProxyCommand();
  const child = spawn(cmd, [...args, "--login"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, USE_NATIVE: process.env.USE_NATIVE ?? "1" },
  });
  return new Promise((resolve) => child.once("close", (code) => resolve(code ?? 0)));
}

const OLLAMA_KEY_HELP = "Get one at https://ollama.com/settings/keys (sign in and copy an API key).";

// Validate key against /models before saving, so a typo is caught immediately.
// Returns model count (>0) when valid, else 0.
async function validateOllamaKey(key) {
  try {
    const res = await fetch(`${OLLAMA_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return 0;
    const data = await res.json();
    return (data?.data ?? []).length;
  } catch {
    return 0;
  }
}

// Ollama Cloud uses a static API key (no OAuth exchange). "login" saves the key
// to ~/.config/ccmux/env (0600) so it persists across sessions.
async function loginOllama() {
  let key = process.env.OLLAMA_API_KEY;
  if (!key) {
    if (!process.stdin.isTTY) {
      console.error("ccmux: no OLLAMA_API_KEY in env and no terminal to prompt.");
      console.error(`       ${OLLAMA_KEY_HELP}`);
      console.error("       Run `ccmux login ollama` in a terminal, or export OLLAMA_API_KEY=sk-... first.");
      process.exit(1);
    }
    console.log(`Ollama Cloud API key. ${OLLAMA_KEY_HELP}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = () => {}; // mute echo so the pasted key isn't left in scrollback
    process.stdout.write("Paste your Ollama Cloud API key: ");
    key = (await new Promise((r) => rl.question("", r))).trim();
    rl.close();
    process.stdout.write("\n");
  }
  if (!key) { console.error("ccmux: no key entered."); console.error(`       ${OLLAMA_KEY_HELP}`); process.exit(1); }

  const n = await validateOllamaKey(key);
  if (!n) {
    console.error("ccmux: Ollama Cloud rejected that key (401/403 or returned no models).");
    console.error(`       ${OLLAMA_KEY_HELP}`);
    process.exit(1);
  }

  const dir = join(HOME || "", ".config", "ccmux");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const p = join(dir, "env");
  const kept = existsSync(p)
    ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim() && !/^\s*OLLAMA_API_KEY=/.test(l))
    : [];
  kept.push(`OLLAMA_API_KEY=${key}`);
  writeFileSync(p, kept.join("\n") + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  console.log(`ccmux: saved OLLAMA_API_KEY to ${p} (key validated)`);
}

// Clear persisted credentials (env files + VS Code Copilot token files) and
// stop the proxy. Emits `unset ...` on stdout so `eval "$(ccmux logout)"` also
// clears tokens exported in the live shell. All human messages go to stderr so
// eval only picks up the unset line.
function logout() {
  const warn = (m) => process.stderr.write(m + "\n");
  // env.ts loads from ./.env (cwd=ROOT) then ~/.config/ccmux/env;
  // token.ts honors GH_TOKEN and GITHUB_TOKEN. Clear both files.
  let removedToken = false;
  for (const envFile of [join(ROOT, ".env"), join(HOME || "", ".config", "ccmux", "env")]) {
    if (!existsSync(envFile)) continue;
    const lines = readFileSync(envFile, "utf8").split("\n");
    const kept = lines.filter((l) => !/^\s*(GH_TOKEN|GITHUB_TOKEN|OLLAMA_API_KEY)=/.test(l));
    if (kept.length === lines.length) continue;
    removedToken = true;
    const body = kept.join("\n").trim();
    // writeFileSync mode is ignored on existing files; chmod enforces 0600.
    if (body) { writeFileSync(envFile, body + "\n", { mode: 0o600 }); chmodSync(envFile, 0o600); }
    else rmSync(envFile);
  }
  // VS Code Copilot stores OAuth tokens in apps.json + hosts.json; token.ts
  // reads both. Leaving them means ccmux silently re-auths after logout.
  let removedVscode = false;
  for (const f of ["apps.json", "hosts.json"]) {
    const p = join(GH_COPILOT_DIR, f);
    try { if (existsSync(p)) { rmSync(p); removedVscode = true; } } catch (e) { warn(`ccmux: couldn't remove ${p}: ${e?.message ?? e}`); }
  }
  // -sTCP:LISTEN targets only the listener, not ESTABLISHED client connections.
  let stopped = false;
  const lsofRes = spawnSync("lsof", ["-ti:" + PORT, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (lsofRes.error)
    warn("ccmux: lsof not found; couldn't stop the proxy. Kill it manually if it's still up.");
  const pids = lsofRes.stdout?.trim();
  if (pids) for (const pid of pids.split("\n")) {
    try { process.kill(Number(pid)); stopped = true; } catch {}
  }
  warn(
    `ccmux: logged out. ${removedToken ? "Removed saved tokens" : "No saved tokens on disk"}; ` +
      `${stopped ? "stopped the running proxy" : "proxy was not running"}; ` +
      `${removedVscode ? "removed VS Code Copilot tokens" : "no VS Code Copilot tokens present"}.`,
  );
  // A child process can't unset its parent shell's env; emit the command for
  // `eval "$(ccmux logout)"` to apply. Plain `ccmux logout` just prints it.
  process.stdout.write("unset GH_TOKEN GITHUB_TOKEN OLLAMA_API_KEY\n");
  const shellEnvLeaked = !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.OLLAMA_API_KEY);
  if (shellEnvLeaked)
    warn("ccmux: token(s) are still exported in this shell. Run `eval \"$(ccmux logout)\"` to clear them, then `ccmux login copilot`/`login ollama` to re-auth.");
}

function runClaude(args) {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: BASE,
    ANTHROPIC_AUTH_TOKEN: "sk-dummy",
    // Populate the /model picker from the proxy's /v1/models (incl. gpt/gemini,
    // aliased as claude-* so they survive Claude Code's discovery filter).
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "1",
  };
  registerSession();
  const child = spawn("claude", args, { stdio: "inherit", env });
  child.once("close", (code) => {
    deregisterSession();
    process.exit(code ?? 0);
  });
}

async function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  // Print and exit without starting a proxy (unknown cmds previously fell
  // through to the proxy-up block and booted a stray proxy).
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`ccmux v${VERSION}`);
    process.exit(0);
  }
  const KNOWN = new Set(["claude", undefined, "serve", "login", "logout"]);
  if (!KNOWN.has(cmd)) {
    console.error(`ccmux: unknown command "${cmd ?? ""}"\n\n${USAGE}`);
    process.exit(1);
  }

  if (cmd === "serve") {
    if (await proxyUp()) {
      console.error(`ccmux: proxy already running on ${BASE}`);
      process.exit(0);
    }
    runProxyForeground();
    return;
  }

  // After any successful login, restart the proxy so the new credential is
  // picked up immediately (catalogs load once at startup, not on the fly).
  if (cmd === "login") {
    const sub = rest[0];
    if (sub === "ollama") {
      await loginOllama();
      await restartProxy();
      process.exit(0);
    }
    if (sub === "copilot") {
      const code = await runLogin();
      if (code === 0) await restartProxy();
      process.exit(code);
    }
    console.error(`ccmux login: specify a service: ccmux login copilot | ccmux login ollama`);
    process.exit(1);
  }

  if (cmd === "logout") {
    logout();
    process.exit(0);
  }

  if (!(await proxyUp())) {
    // Require at least one configured backend. Without this guard a machine
    // with no creds would silently fall into the Copilot device flow.
    const copilot = hasCopilotCreds();
    if (!copilot && !hasOllamaKey()) {
      console.error(
        "ccmux: no backend configured. Run `ccmux login copilot` (GitHub Copilot) or `ccmux login ollama` (Ollama Cloud) first.",
      );
      process.exit(1);
    }
    // The proxy starts headless (no TTY), so the device flow can't prompt
    // there. Run interactive login first when in a real terminal so the token
    // is ready before boot. Skip for Ollama-only setups to avoid forcing a
    // GitHub flow. Gates on stdout.isTTY to mirror token.ts behavior.
    if (copilot && (cmd === "claude" || cmd === undefined) && process.stdout.isTTY) {
      const code = await runLogin();
      if (code !== 0) process.exit(code);
    }
    startProxy();
    console.error(`ccmux: starting proxy on ${BASE}`);
    const ok = await waitForProxy();
    if (!ok) {
      console.error(
        "ccmux: proxy did not become ready in 60s. Run `ccmux login` to authenticate, or check ~/.config/ccmux/proxy.log",
      );
      process.exit(1);
    }
  }

  if (cmd === "claude" || cmd === undefined) {
    runClaude(rest);
  } else {
    console.error(`usage: ccmux [claude ...] | login [copilot|ollama] | logout | serve`);
    process.exit(1);
  }
}

main();
