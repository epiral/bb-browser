/**
 * CommandHistory — bounded ring buffer for MCP command records.
 *
 * Stored in-process (no file I/O). Capacity defaults to 200 entries,
 * enough to cover the last ~50 MCP commands displayed in the control panel
 * Overview tab plus room to spare.
 */

import { RingBuffer } from "./ring-buffer.js";

export interface CommandRecord {
  /** Tool name, e.g. "browser_click". */
  tool: string;
  /** Short human-readable argument summary (≤ 80 chars). */
  argsSummary: string;
  /** Unix ms timestamp when the command was received. */
  ts: number;
  /** Total round-trip duration in ms (0 while still in-flight). */
  durationMs: number;
  /** "ok" | "error" | "inflight" */
  status: "ok" | "error" | "inflight";
  /** Session ID of the calling agent (undefined for unauthenticated calls). */
  sessionId?: string;
}

const CAPACITY = 200;

export class CommandHistory {
  private readonly buf = new RingBuffer<CommandRecord>(CAPACITY);

  /**
   * Record the start of a command and return a finish callback.
   * Call `finish(ok)` when the command completes (or errors).
   */
  record(tool: string, args: unknown, sessionId?: string): (ok?: boolean) => void {
    const rec: CommandRecord = {
      tool,
      argsSummary: summarise(args),
      ts: Date.now(),
      durationMs: 0,
      status: "inflight",
      sessionId,
    };
    this.buf.push(rec);
    const start = rec.ts;
    return (ok = true) => {
      rec.durationMs = Date.now() - start;
      rec.status = ok ? "ok" : "error";
    };
  }

  /**
   * Return up to `limit` most-recent records, newest first.
   */
  recent(limit = 50): CommandRecord[] {
    const all = this.buf.toArray();
    return all.slice(-limit).reverse();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a short summary string from the args object (≤ 80 chars). */
function summarise(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return String(args).slice(0, 80);

  const obj = args as Record<string, unknown>;
  const parts: string[] = [];

  // Prioritised keys: ref, selector, url, text, value, key
  for (const k of ["ref", "selector", "url", "text", "value", "key"]) {
    if (k in obj && obj[k] != null) {
      const v = String(obj[k]);
      parts.push(`${k}=${JSON.stringify(v.length > 30 ? v.slice(0, 30) + "…" : v)}`);
    }
  }

  if (parts.length === 0) {
    // Fallback: first 2 keys
    const keys = Object.keys(obj).slice(0, 2);
    for (const k of keys) {
      const v = String(obj[k]);
      parts.push(`${k}=${JSON.stringify(v.length > 20 ? v.slice(0, 20) + "…" : v)}`);
    }
  }

  const raw = parts.join(", ");
  return raw.length > 80 ? raw.slice(0, 79) + "…" : raw;
}
