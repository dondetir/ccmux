import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveSessions, startIdleReaper } from "../src/sessions.js";

let dir = "";
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  vi.useRealTimers();
  delete process.env.CCMUX_MANAGED;
  delete process.env.CCMUX_IDLE_GRACE_MS;
});

describe("liveSessions (self-healing session registry)", () => {
  it("counts live pids and prunes dead/garbage files", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-sess-"));
    fs.writeFileSync(path.join(dir, String(process.pid)), ""); // this test process = alive
    fs.writeFileSync(path.join(dir, "999999999"), "");         // unused pid = dead
    fs.writeFileSync(path.join(dir, "not-a-pid"), "");         // garbage

    expect(liveSessions(dir)).toBe(1);
    expect(fs.existsSync(path.join(dir, String(process.pid)))).toBe(true);  // kept
    expect(fs.existsSync(path.join(dir, "999999999"))).toBe(false);          // pruned
    expect(fs.existsSync(path.join(dir, "not-a-pid"))).toBe(false);          // pruned
  });

  it("returns 0 when the sessions dir does not exist", () => {
    dir = path.join(os.tmpdir(), "cp-missing-" + process.pid);
    expect(liveSessions(dir)).toBe(0);
  });

  it("returns 0 for an empty dir (all sessions ended)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-empty-"));
    expect(liveSessions(dir)).toBe(0);
  });
});

describe("startIdleReaper (managed-proxy self-stop)", () => {
  const managed = () => {
    process.env.CCMUX_MANAGED = "1";
    process.env.CCMUX_IDLE_GRACE_MS = "100";
    vi.useFakeTimers();
  };

  it("is a no-op when not MANAGED", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    startIdleReaper(exit, () => 0);
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it("never stops while a session is live", () => {
    managed();
    const exit = vi.fn();
    startIdleReaper(exit, () => 1);
    vi.advanceTimersByTime(1000); // well past 2×grace
    expect(exit).not.toHaveBeenCalled();
  });

  it("stops after ~2×grace once no sessions remain", () => {
    managed();
    const exit = vi.fn();
    startIdleReaper(exit, () => 0);
    vi.advanceTimersByTime(150); // past startup grace, idle window just opened
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // idle window elapses
    expect(exit).toHaveBeenCalledOnce();
  });

  it("resets the idle window when a session reappears", () => {
    managed();
    const exit = vi.fn();
    let live = 0;
    startIdleReaper(exit, () => live);
    vi.advanceTimersByTime(150); // idle window opened
    live = 1;                    // session comes back before it elapses
    vi.advanceTimersByTime(500); // would have stopped if not reset
    expect(exit).not.toHaveBeenCalled();
  });
});
