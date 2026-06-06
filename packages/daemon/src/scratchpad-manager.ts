export interface ScratchpadEntry {
  ts: number;
  agentId?: string;
  action: string;
}

const SCRATCHPAD_CAPACITY = 10;
const SCRATCHPAD_TTL_MS = (() => {
  const raw = process.env.BB_SCRATCHPAD_TTL_SECS;
  if (!raw) return 5 * 60 * 1000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 5 * 60 * 1000;
})();

/** Actions that mutate page state — worth surfacing to other agents. */
const WRITE_ACTIONS = new Set([
  "open", "back", "forward", "refresh",
  "click", "hover", "fill", "type", "check", "uncheck", "select", "press", "scroll",
  "eval", "dialog", "frame", "frame_main",
  "tab_claim", "tab_release", "task_update",
]);

export class ScratchpadManager {
  private entries = new Map<string, ScratchpadEntry[]>(); // bbTabId → entries
  private updatedAt = new Map<string, number>();          // bbTabId → last write ts

  isWriteAction(action: string): boolean {
    return WRITE_ACTIONS.has(action);
  }

  record(bbTabId: string, action: string, agentId?: string): void {
    if (!WRITE_ACTIONS.has(action)) return;
    let list = this.entries.get(bbTabId);
    if (!list) {
      list = [];
      this.entries.set(bbTabId, list);
    }
    if (list.length >= SCRATCHPAD_CAPACITY) list.shift();
    list.push({ ts: Date.now(), agentId, action });
    this.updatedAt.set(bbTabId, Date.now());
  }

  /** Returns entries for a tab, or null if none / TTL expired. */
  getRecent(bbTabId: string): ScratchpadEntry[] | null {
    const updated = this.updatedAt.get(bbTabId);
    if (!updated || Date.now() - updated > SCRATCHPAD_TTL_MS) return null;
    return this.entries.get(bbTabId) ?? null;
  }

  /** Evict tabs whose last write is older than TTL. Call periodically. */
  gc(): void {
    const cutoff = Date.now() - SCRATCHPAD_TTL_MS;
    for (const [bbTabId, ts] of this.updatedAt) {
      if (ts < cutoff) {
        this.entries.delete(bbTabId);
        this.updatedAt.delete(bbTabId);
      }
    }
  }
}
