/**
 * Debug logger. When `debug` is true, writes per-session context snapshots and
 * structured messages under `~/.omp/agent/logs/dcp/`. Otherwise it is a no-op
 * shell so call sites stay unconditional.
 */

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export class Logger {
  private readonly enabled: boolean;
  private readonly dir: string;

  constructor(debug: boolean) {
    this.enabled = debug;
    this.dir = join(homedir(), ".omp", "agent", "logs", "dcp");
    if (debug) {
      try {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      } catch {
        // best-effort; logging must never break the session
      }
    }
  }

  private write(level: string, message: string, extra?: unknown): void {
    if (!this.enabled) return;
    const stamp = new Date().toISOString();
    const line = extra !== undefined ? `[${stamp}] ${level} ${message} ${safeJson(extra)}` : `[${stamp}] ${level} ${message}`;
    try {
      appendFileSync(join(this.dir, "dcp.log"), line + "\n");
    } catch {
      /* ignore */
    }
  }

  debug(message: string, extra?: unknown): void {
    this.write("DEBUG", message, extra);
  }
  info(message: string, extra?: unknown): void {
    this.write("INFO", message, extra);
  }
  warn(message: string, extra?: unknown): void {
    this.write("WARN", message, extra);
  }
  error(message: string, extra?: unknown): void {
    this.write("ERROR", message, extra);
  }

  /** Persist a snapshot of the transformed messages for offline inspection. */
  saveContext(sessionId: string, messages: unknown[]): void {
    if (!this.enabled) return;
    try {
      const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "session";
      appendFileSync(join(this.dir, `context-${safe}.jsonl`), JSON.stringify(messages) + "\n");
    } catch {
      /* ignore */
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
