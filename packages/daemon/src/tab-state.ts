/**
 * TabState — per-tab event state with global seq counter.
 *
 * Each tab maintains its own ring-buffered event collections:
 *   - networkRequests (max 500)
 *   - consoleMessages (max 200)
 *   - jsErrors (max 100)
 *
 * A global monotonic `seq` counter is shared across all events and
 * operations. Each event or action increments seq so that callers can
 * use the `since` mechanism for incremental queries.
 */

import type {
  NetworkRequestInfo,
  ConsoleMessageInfo,
  JSErrorInfo,
  RefInfo,
} from "@bb-browser/shared";
import { RingBuffer } from "./ring-buffer.js";

// ---------------------------------------------------------------------------
// Seq-tagged event wrappers
// ---------------------------------------------------------------------------

export type SeqNetworkRequest = NetworkRequestInfo & { seq: number };
export type SeqConsoleMessage = ConsoleMessageInfo & { seq: number };
export type SeqJSError = JSErrorInfo & { seq: number };

// ---------------------------------------------------------------------------
// Per-tab state
// ---------------------------------------------------------------------------

const NETWORK_CAPACITY = 500;
const CONSOLE_CAPACITY = 200;
const ERRORS_CAPACITY = 100;

export class TabState {
  readonly targetId: string;
  shortId: string;

  networkRequests = new RingBuffer<SeqNetworkRequest>(NETWORK_CAPACITY);
  consoleMessages = new RingBuffer<SeqConsoleMessage>(CONSOLE_CAPACITY);
  jsErrors = new RingBuffer<SeqJSError>(ERRORS_CAPACITY);

  /** Lookup in-flight network requests by requestId for response/failure updates. */
  private networkByRequestId = new Map<string, SeqNetworkRequest>();

  /** seq of the last user-initiated action on this tab. */
  lastActionSeq = 0;

  /** Element refs from the most recent snapshot. */
  refs: Record<string, RefInfo> = {};

  /** Active frame ID for iframe navigation, null = main frame. */
  activeFrameId: string | null = null;

  /** Dialog auto-handler config. */
  dialogHandler: { accept: boolean; promptText?: string } | null = null;

  constructor(
    targetId: string,
    shortId: string,
    private readonly nextSeq: () => number,
  ) {
    this.targetId = targetId;
    this.shortId = shortId;
  }

  // --------------- Action seq ---------------

  /** Increment global seq and record it as this tab's last action. */
  recordAction(): number {
    const seq = this.nextSeq();
    this.lastActionSeq = seq;
    return seq;
  }

  // --------------- Network events ---------------

  addNetworkRequest(requestId: string, info: Omit<NetworkRequestInfo, "requestId">): void {
    const seq = this.nextSeq();
    const entry: SeqNetworkRequest = { ...info, requestId, seq };
    this.networkRequests.push(entry);
    this.networkByRequestId.set(requestId, entry);
  }

  updateNetworkResponse(
    requestId: string,
    data: {
      status?: number;
      statusText?: string;
      responseHeaders?: Record<string, string>;
      mimeType?: string;
    },
  ): void {
    const existing = this.networkByRequestId.get(requestId);
    if (!existing) return;
    if (data.status !== undefined) existing.status = data.status;
    if (data.statusText !== undefined) existing.statusText = data.statusText;
    if (data.responseHeaders !== undefined) existing.responseHeaders = data.responseHeaders;
    if (data.mimeType !== undefined) existing.mimeType = data.mimeType;
  }

  updateNetworkFailure(requestId: string, reason: string): void {
    const existing = this.networkByRequestId.get(requestId);
    if (!existing) return;
    existing.failed = true;
    existing.failureReason = reason;
  }

  // --------------- Console events ---------------

  addConsoleMessage(info: Omit<ConsoleMessageInfo, never>): void {
    const seq = this.nextSeq();
    this.consoleMessages.push({ ...info, seq });
  }

  // --------------- JS Error events ---------------

  addJSError(info: Omit<JSErrorInfo, never>): void {
    const seq = this.nextSeq();
    this.jsErrors.push({ ...info, seq });
  }

  // --------------- Query helpers ---------------

  getNetworkRequests(options?: {
    since?: number | "last_action";
    filter?: string;
    method?: string;
    status?: string;
    limit?: number;
  }): { items: SeqNetworkRequest[]; cursor: number } {
    let items = this.networkRequests.toArray();

    // since
    if (options?.since !== undefined) {
      const threshold =
        options.since === "last_action" ? this.lastActionSeq : options.since;
      items = items.filter((item) => item.seq > threshold);
    }

    // filter (URL substring)
    if (options?.filter) {
      const f = options.filter;
      items = items.filter((item) => item.url.includes(f));
    }

    // method
    if (options?.method) {
      const m = options.method.toUpperCase();
      items = items.filter((item) => item.method === m);
    }

    // status
    if (options?.status) {
      const s = options.status;
      if (s === "4xx") {
        items = items.filter((item) => item.status !== undefined && item.status >= 400 && item.status < 500);
      } else if (s === "5xx") {
        items = items.filter((item) => item.status !== undefined && item.status >= 500 && item.status < 600);
      } else {
        const code = Number(s);
        if (!Number.isNaN(code)) {
          items = items.filter((item) => item.status === code);
        }
      }
    }

    // limit
    if (options?.limit !== undefined && options.limit > 0 && items.length > options.limit) {
      items = items.slice(-options.limit);
    }

    const sinceThreshold = options?.since !== undefined
      ? (options.since === "last_action" ? this.lastActionSeq : options.since)
      : 0;
    const cursor = items.length > 0 ? Math.max(...items.map((i) => i.seq)) : sinceThreshold;
    return { items, cursor };
  }

  getConsoleMessages(options?: {
    since?: number | "last_action";
    filter?: string;
    limit?: number;
  }): { items: SeqConsoleMessage[]; cursor: number } {
    let items = this.consoleMessages.toArray();

    if (options?.since !== undefined) {
      const threshold =
        options.since === "last_action" ? this.lastActionSeq : options.since;
      items = items.filter((item) => item.seq > threshold);
    }

    if (options?.filter) {
      const f = options.filter;
      items = items.filter((item) => item.text.includes(f));
    }

    if (options?.limit !== undefined && options.limit > 0 && items.length > options.limit) {
      items = items.slice(-options.limit);
    }

    const sinceThreshold = options?.since !== undefined
      ? (options.since === "last_action" ? this.lastActionSeq : options.since)
      : 0;
    const cursor = items.length > 0 ? Math.max(...items.map((i) => i.seq)) : sinceThreshold;
    return { items, cursor };
  }

  getJSErrors(options?: {
    since?: number | "last_action";
    filter?: string;
    limit?: number;
  }): { items: SeqJSError[]; cursor: number } {
    let items = this.jsErrors.toArray();

    if (options?.since !== undefined) {
      const threshold =
        options.since === "last_action" ? this.lastActionSeq : options.since;
      items = items.filter((item) => item.seq > threshold);
    }

    if (options?.filter) {
      const f = options.filter;
      items = items.filter(
        (item) => item.message.includes(f) || (item.url?.includes(f) ?? false),
      );
    }

    if (options?.limit !== undefined && options.limit > 0 && items.length > options.limit) {
      items = items.slice(-options.limit);
    }

    const sinceThreshold = options?.since !== undefined
      ? (options.since === "last_action" ? this.lastActionSeq : options.since)
      : 0;
    const cursor = items.length > 0 ? Math.max(...items.map((i) => i.seq)) : sinceThreshold;
    return { items, cursor };
  }

  // --------------- Clear helpers ---------------

  clearNetwork(): void {
    this.networkRequests.clear();
    this.networkByRequestId.clear();
  }

  clearConsole(): void {
    this.consoleMessages.clear();
  }

  clearErrors(): void {
    this.jsErrors.clear();
  }
}

// ---------------------------------------------------------------------------
// TabStateManager — manages all tabs + global seq
// ---------------------------------------------------------------------------

export class TabStateManager {
  private seq = 0;
  private tabs = new Map<string, TabState>(); // targetId -> TabState
  private shortToTarget = new Map<string, string>(); // shortId -> targetId
  private targetToShort = new Map<string, string>(); // targetId -> shortId

  /** Generate a globally unique short ID for a target. */
  private generateShortId(targetId: string): string {
    for (let len = 4; len <= targetId.length; len++) {
      const candidate = targetId.slice(-len).toLowerCase();
      if (!this.shortToTarget.has(candidate)) {
        return candidate;
      }
    }
    // Extremely unlikely fallback
    return targetId.toLowerCase();
  }

  /** Get next seq (globally monotonic). */
  nextSeq(): number {
    return ++this.seq;
  }

  /** Get current seq without incrementing. */
  currentSeq(): number {
    return this.seq;
  }

  /** Register a new tab. Returns the TabState. */
  addTab(targetId: string): TabState {
    const existing = this.tabs.get(targetId);
    if (existing) return existing;

    const shortId = this.generateShortId(targetId);
    const tab = new TabState(targetId, shortId, () => this.nextSeq());
    this.tabs.set(targetId, tab);
    this.shortToTarget.set(shortId, targetId);
    this.targetToShort.set(targetId, shortId);
    return tab;
  }

  /** Remove a tab (on targetDestroyed / detach). */
  removeTab(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    this.shortToTarget.delete(tab.shortId);
    this.targetToShort.delete(targetId);
    this.tabs.delete(targetId);
  }

  /** Get tab by targetId. */
  getTab(targetId: string): TabState | undefined {
    return this.tabs.get(targetId);
  }

  /** Resolve a short ID to a targetId. */
  resolveShortId(shortId: string): string | undefined {
    return this.shortToTarget.get(shortId);
  }

  /** Get the short ID for a targetId. */
  getShortId(targetId: string): string | undefined {
    return this.targetToShort.get(targetId);
  }

  /** Get all active tabs. */
  allTabs(): TabState[] {
    return Array.from(this.tabs.values());
  }

  /** Get tab count. */
  get tabCount(): number {
    return this.tabs.size;
  }
}
