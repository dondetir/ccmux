import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./env.js";

// Each `ccmux claude` launcher writes an empty file named by its PID here
// while its Claude Code session is alive, and removes it on exit. Launcher
// lifetime equals session lifetime, so PID liveness is session liveness.
export const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

// Count live sessions, pruning stale PID files via kill(pid, 0).
export function liveSessions(dir = SESSIONS_DIR): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0; // dir not created yet = no sessions
  }
  let live = 0;
  for (const f of files) {
    const pid = Number(f);
    let alive = false;
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        /* dead */
      }
    }
    if (alive) live++;
    else {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* race with another reaper — fine */
      }
    }
  }
  return live;
}

// Managed mode (`ccmux claude`): self-exit after the grace window with no live
// sessions. A session restarting within the window reuses the warm proxy.
// `ccmux serve` / hook-started proxies don't set CCMUX_MANAGED and stay up.
export function startIdleReaper(
  exit: () => void = () => process.exit(0),
  count: () => number = liveSessions, // injectable for tests
): void {
  if (process.env.CCMUX_MANAGED !== "1") return;
  const grace = Number(process.env.CCMUX_IDLE_GRACE_MS ?? 120_000);
  const boot = Date.now();
  let emptySince = 0;
  const t = setInterval(() => {
    if (count() > 0) {
      emptySince = 0;
      return;
    }
    if (Date.now() - boot < grace) return; // startup grace window
    if (!emptySince) emptySince = Date.now();
    if (Date.now() - emptySince >= grace) {
      console.log("ccmux: no active sessions; stopping idle proxy");
      exit();
    }
  }, Math.min(30_000, grace)); // cap tick at 30s so small grace values (tests) tick faster
  t.unref();
}
