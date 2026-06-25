import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "ccmux");

// Minimal .env loader. Precedence: real env > ./.env > config dir.
function loadFile(p: string): void {
  try {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* missing — fine */
  }
}

loadFile(path.join(process.cwd(), ".env"));
loadFile(path.join(CONFIG_DIR, "env"));
