import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Enable debug BEFORE importing the module so the DEBUG const is true here.
process.env.CCMUX_DEBUG = "1";
const LOG = path.join(os.homedir(), ".config", "ccmux", "debug.log");
const { debugUpstreamRequest, debugUpstreamResponse, debugTeeStream, debugInbound } =
  await import("../src/debug.js");

describe("debug logging", () => {
  beforeEach(() => {
    try { fs.rmSync(LOG, { force: true }); } catch { /* */ }
  });
  afterEach(() => {
    try { fs.rmSync(LOG, { force: true }); } catch { /* */ }
  });

  it("writes inbound + upstream request + response to the debug log", () => {
    debugInbound("/v1/messages", { model: "gpt-5.6", messages: [{ role: "user", content: "hi" }] });
    debugUpstreamRequest("POST", "https://x/responses", { Authorization: "Bearer secret123" }, { model: "gpt-5.6" });
    debugUpstreamResponse(200, '{"ok":true}');
    const log = fs.readFileSync(LOG, "utf8");
    expect(log).toContain("INBOUND /v1/messages");
    expect(log).toContain("UPSTREAM POST https://x/responses");
    expect(log).toContain("status 200");
    expect(log).toContain("gpt-5.6");
  });

  it("redacts Authorization bearer tokens", () => {
    debugUpstreamRequest("POST", "https://x/responses", { Authorization: "Bearer supersecret" }, {});
    const log = fs.readFileSync(LOG, "utf8");
    expect(log).toContain("<redacted>");
    expect(log).not.toContain("supersecret");
  });

  it("tee passes bytes through unchanged while logging", async () => {
    const data = new TextEncoder().encode("event: ping\ndata: {}\n\n");
    const src = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(data); c.close(); },
    });
    const teed = debugTeeStream(src, "<<< test stream");
    const reader = teed.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value!)).toBe("event: ping\ndata: {}\n\n");
    const log = fs.readFileSync(LOG, "utf8");
    expect(log).toContain("test stream");
  });
});
