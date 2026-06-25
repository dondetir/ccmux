import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR } from "./env.js";
import { TOKEN_EXCHANGE_URL, COPILOT_HEADERS } from "./upstream.js";

// Copilot plugin OAuth app id used for device flow. Unofficial; community-standard.
const DEVICE_CLIENT_ID = "Iv1.b507a08c87ecfe98";

let copilotToken: string | null = null;
let expEpoch = 0;
let ghToken: string | null = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;

// Exchange a GitHub token for a short-lived Copilot bearer.
// Returns null on 401/403/404 so the caller can try the next candidate.
async function exchange(gh: string): Promise<{ token: string; expires_at: number } | null> {
  const res = await fetch(TOKEN_EXCHANGE_URL, {
    headers: { Authorization: `token ${gh}`, "User-Agent": COPILOT_HEADERS["User-Agent"] },
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()) as { token: string; expires_at: number };
}

// Returns GitHub tokens previously stored by VS Code's Copilot sign-in.
function appsJsonTokens(): string[] {
  const tokens: string[] = [];
  for (const file of ["apps.json", "hosts.json"]) {
    try {
      const p = path.join(os.homedir(), ".config", "github-copilot", file);
      const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, any>;
      for (const v of Object.values(data)) if (v?.oauth_token) tokens.push(v.oauth_token);
    } catch {
      /* file missing — fine */
    }
  }
  return tokens;
}

async function deviceFlow(): Promise<string> {
  const dc = (await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: DEVICE_CLIENT_ID, scope: "read:user" }),
  }).then((r) => r.json())) as any;
  if (!dc.device_code) throw new Error(`device flow start failed: ${JSON.stringify(dc)}`);

  console.log(`\n  Copilot login required: open ${dc.verification_uri} and enter code ${dc.user_code}\n`);
  let interval = (dc.interval ?? 5) * 1000;
  while (true) {
    await new Promise((r) => setTimeout(r, interval));
    const res = (await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: DEVICE_CLIENT_ID,
        device_code: dc.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }).then((r) => r.json())) as any;
    if (res.access_token) return res.access_token;
    if (res.error === "slow_down") interval += 5000;
    else if (res.error && res.error !== "authorization_pending")
      throw new Error(`device flow: ${res.error}`);
  }
}

function persistToken(gh: string): void {
  try {
    // 0o700 on the dir prevents a first-create race from leaving it world-readable.
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* fs ignores mode */ }
    const p = path.join(CONFIG_DIR, "env");
    fs.appendFileSync(p, `\nGH_TOKEN=${gh}\n`, { mode: 0o600 });
    // appendFileSync mode only applies on creation; chmod enforces it on existing files.
    try { fs.chmodSync(p, 0o600); } catch { /* non-posix fs */ }
    console.log(`ccmux: saved GH_TOKEN to ${p} (one-time login)`);
  } catch {
    console.warn("could not persist GH_TOKEN; device flow will rerun next start");
  }
}

// Fallback chain: env token -> apps.json -> device flow.
// Caches the Copilot bearer and refreshes ~2 minutes before expiry.
export async function getCopilotToken(): Promise<string> {
  if (copilotToken && Date.now() / 1000 < expEpoch - 120) return copilotToken;

  const candidates = [ghToken, ...appsJsonTokens()].filter(Boolean) as string[];
  for (const gh of candidates) {
    const data = await exchange(gh);
    if (data) {
      ghToken = gh;
      copilotToken = data.token;
      expEpoch = data.expires_at;
      return copilotToken;
    }
  }

  if (!process.stdout.isTTY) {
    throw new Error(
      "no usable GitHub token (env GH_TOKEN rejected or missing, no apps.json) " +
        "and cannot run device flow without a terminal — run `ccmux login` in a terminal once",
    );
  }
  const gh = await deviceFlow();
  const data = await exchange(gh);
  if (!data) throw new Error("device-flow token failed the Copilot exchange; is Copilot enabled on this account?");
  ghToken = gh;
  copilotToken = data.token;
  expEpoch = data.expires_at;
  persistToken(gh);
  return copilotToken;
}

// Returns the GitHub OAuth token after running the exchange chain (for api.github.com calls).
export async function getGitHubToken(): Promise<string | null> {
  await getCopilotToken().catch(() => {});
  return ghToken;
}

// Startup hint only; never throws. Device flow may still succeed on first request.
export function tokenStartupCheck(): void {
  if (!ghToken && appsJsonTokens().length === 0) {
    console.warn(
      process.stdout.isTTY
        ? "no GitHub token found (env/apps.json) — device flow will start on first request"
        : "no GitHub token found (env/apps.json) — run `ccmux login` in a terminal to authenticate",
    );
  }
}
