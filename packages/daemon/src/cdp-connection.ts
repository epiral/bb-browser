/**
 * CdpConnection — manages the browser-level WebSocket to Chrome DevTools
 * Protocol. Handles target discovery, auto-attach, session multiplexing,
 * and routes per-target session events to the TabStateManager.
 *
 * Merged from cli/cdp-client.ts (connection management) and
 * cli/cdp-monitor.ts (persistent connection + event listening).
 */

import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import type { TraceEvent } from "@bb-browser/shared";
import { TabStateManager } from "./tab-state.js";
import { TRACE_INJECTION_SCRIPT, TRACE_PREFIX } from "./trace-inject.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: string;
}

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode ?? 500}: ${raw}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

// ---------------------------------------------------------------------------
// CdpConnection
// ---------------------------------------------------------------------------

export class CdpConnection {
  private socket: WebSocket | null = null;
  private pending = new Map<number, PendingCommand>();
  private nextId = 1;

  /** targetId -> sessionId (flat-mode) */
  private sessions = new Map<string, string>();
  /** sessionId -> targetId */
  private attachedTargets = new Map<string, string>();

  readonly host: string;
  readonly port: number;
  readonly tabManager: TabStateManager;

  /** Current (most recently selected) target ID. */
  currentTargetId: string | undefined;

  private connectionPromise: Promise<void> | null = null;
  private _connected = false;

  /** Last connection error (for diagnostics in 503 responses). */
  lastError: string | null = null;

  /** Resolvers for commands queued before CDP is ready. */
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(host: string, port: number, tabManager: TabStateManager) {
    this.host = host;
    this.port = port;
    this.tabManager = tabManager;
  }

  get connected(): boolean {
    return this._connected && this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to Chrome's browser-level WebSocket endpoint.
   * Idempotent — returns immediately if already connected.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = this.doConnect();
    try {
      await this.connectionPromise;
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      const connErr = new Error(this.lastError);
      for (const waiter of this.readyWaiters) {
        waiter.reject(connErr);
      }
      this.readyWaiters = [];
      throw err;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    const versionData = (await fetchJson(
      `http://${this.host}:${this.port}/json/version`,
    )) as JsonObject;
    const wsUrl = versionData.webSocketDebuggerUrl;
    if (typeof wsUrl !== "string" || !wsUrl) {
      throw new Error("CDP endpoint missing webSocketDebuggerUrl");
    }

    const ws = await connectWebSocket(wsUrl);
    this.socket = ws;
    this._connected = true;
    this.setupListeners(ws);

    // Discover + auto-attach existing page targets
    await this.browserCommand("Target.setDiscoverTargets", { discover: true });
    const result = await this.browserCommand<{
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
    }>("Target.getTargets");

    const pages = (result.targetInfos || []).filter((t) => t.type === "page");
    for (const page of pages) {
      await this.attachAndEnable(page.targetId).catch(() => {});
    }

    // Notify any waiters that CDP is ready
    for (const waiter of this.readyWaiters) {
      waiter.resolve();
    }
    this.readyWaiters = [];
  }

  /** Wait until CDP connection is established (for two-phase startup). */
  waitUntilReady(): Promise<void> {
    if (this._connected) return Promise.resolve();
    if (this.lastError) return Promise.reject(new Error(this.lastError));
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /** Gracefully close the CDP connection. */
  disconnect(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
    }
    this.socket = null;
    this._connected = false;

    for (const p of this.pending.values()) {
      p.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();

    // Reject any waiters
    for (const waiter of this.readyWaiters) {
      waiter.reject(new Error("CDP connection closed before ready"));
    }
    this.readyWaiters = [];
  }

  // ---------------------------------------------------------------------------
  // WebSocket message handling
  // ---------------------------------------------------------------------------

  private setupListeners(ws: WebSocket): void {
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as JsonObject;

      // Response to a browser-level command
      if (typeof message.id === "number") {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        if (message.error) {
          p.reject(
            new Error(
              `${p.method}: ${(message.error as JsonObject).message ?? "Unknown CDP error"}`,
            ),
          );
        } else {
          p.resolve(message.result);
        }
        return;
      }


      // Flat-mode attach
      if (message.method === "Target.attachedToTarget") {
        const params = message.params as JsonObject;
        const sessionId = params.sessionId;
        const targetInfo = params.targetInfo as JsonObject;
        if (typeof sessionId === "string" && typeof targetInfo?.targetId === "string") {
          this.sessions.set(targetInfo.targetId, sessionId);
          this.attachedTargets.set(sessionId, targetInfo.targetId);
        }
        return;
      }

      if (message.method === "Target.detachedFromTarget") {
        const params = message.params as JsonObject;
        const sessionId = params.sessionId;
        if (typeof sessionId === "string") {
          const targetId = this.attachedTargets.get(sessionId);
          if (targetId) {
            this.sessions.delete(targetId);
            this.attachedTargets.delete(sessionId);
            this.tabManager.removeTab(targetId);
            if (this.currentTargetId === targetId) {
              this.currentTargetId = undefined;
            }
          }
        }
        return;
      }

      // New target auto-attach
      if (message.method === "Target.targetCreated") {
        const params = message.params as JsonObject;
        const targetInfo = params.targetInfo as JsonObject;
        if (targetInfo?.type === "page" && typeof targetInfo.targetId === "string") {
          this.attachAndEnable(targetInfo.targetId).catch(() => {});
        }
        return;
      }

      if (message.method === "Target.targetDestroyed") {
        const params = message.params as JsonObject;
        const targetId = params.targetId;
        if (typeof targetId === "string") {
          const sessionId = this.sessions.get(targetId);
          if (sessionId) {
            this.sessions.delete(targetId);
            this.attachedTargets.delete(sessionId);
          }
          this.tabManager.removeTab(targetId);
          if (this.currentTargetId === targetId) {
            this.currentTargetId = undefined;
          }
        }
        return;
      }

      // Flat protocol: session events carry sessionId directly
      if (typeof message.sessionId === "string" && typeof message.method === "string") {
        const targetId = this.attachedTargets.get(message.sessionId as string);
        if (targetId) {
          this.handleSessionEvent(targetId, message).catch(() => {});
        }
      }
    });

    ws.on("close", () => {
      this._connected = false;
      this.socket = null;
      this.lastError = "CDP WebSocket closed unexpectedly";
      for (const p of this.pending.values()) {
        p.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();

      const closeErr = new Error(this.lastError);
      for (const waiter of this.readyWaiters) {
        waiter.reject(closeErr);
      }
      this.readyWaiters = [];
    });

    ws.on("error", () => {});
  }

  // ---------------------------------------------------------------------------
  // Session event routing (network, console, errors, dialog)
  // ---------------------------------------------------------------------------

  private async handleSessionEvent(targetId: string, event: JsonObject): Promise<void> {
    const method = event.method;
    const params = (event.params ?? {}) as JsonObject;
    if (typeof method !== "string") return;

    const tab = this.tabManager.getTab(targetId);
    if (!tab) return;

    // Dialog handling
    if (method === "Page.javascriptDialogOpening") {
      if (tab.dialogHandler) {
        await this.sessionCommand(targetId, "Page.handleJavaScriptDialog", {
          accept: tab.dialogHandler.accept,
          ...(tab.dialogHandler.promptText !== undefined
            ? { promptText: tab.dialogHandler.promptText }
            : {}),
        });
      }
      return;
    }

    // Trace: re-inject event listeners after navigation + record main-frame nav
    if (method === "Page.frameNavigated") {
      if (tab.traceRecording) {
        const frame = params.frame as JsonObject | undefined;
        const isMainFrame = !!frame && !frame.parentId;
        const newUrl = typeof frame?.url === "string" ? frame.url : "";
        this.evaluate(targetId, TRACE_INJECTION_SCRIPT, true).catch(() => {});
        if (isMainFrame && newUrl && !newUrl.startsWith("chrome-error://")) {
          tab.addTraceNavigation(newUrl);
        }
      }
      return;
    }


    // Network events
    if (method === "Network.requestWillBeSent") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const request = params.request as JsonObject | undefined;
      if (!requestId || !request) return;
      tab.addNetworkRequest(requestId, {
        url: String(request.url ?? ""),
        method: String(request.method ?? "GET"),
        type: String(params.type ?? "Other"),
        timestamp: Math.round(Number(params.timestamp ?? Date.now()) * 1000),
        requestHeaders: normalizeHeaders(request.headers),
        requestBody: typeof request.postData === "string" ? request.postData : undefined,
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const response = params.response as JsonObject | undefined;
      if (!requestId || !response) return;
      tab.updateNetworkResponse(requestId, {
        status: typeof response.status === "number" ? response.status : undefined,
        statusText: typeof response.statusText === "string" ? response.statusText : undefined,
        responseHeaders: normalizeHeaders(response.headers),
        mimeType: typeof response.mimeType === "string" ? response.mimeType : undefined,
      });
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      if (!requestId) return;
      tab.updateNetworkFailure(
        requestId,
        typeof params.errorText === "string" ? params.errorText : "Unknown error",
      );
      return;
    }

    // Console events
    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type ?? "log");
      const args = Array.isArray(params.args) ? (params.args as JsonObject[]) : [];
      const text = args
        .map((arg) => {
          if (typeof arg.value === "string") return arg.value;
          if (arg.value !== undefined) return String(arg.value);
          if (typeof arg.description === "string") return arg.description;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      const stack = params.stackTrace as JsonObject | undefined;
      const firstCallFrame = Array.isArray(stack?.callFrames)
        ? (stack?.callFrames[0] as JsonObject | undefined)
        : undefined;
      // Chrome CDP sends "warning" for console.warn(); normalize it
      const consoleTypeMap: Record<string, string> = { warning: "warn" };
      const normalizedType = consoleTypeMap[type] || type;
      // Trace: intercept console.log fallback from injected listeners
      if (text.startsWith(TRACE_PREFIX) && tab.traceRecording) {
        try {
          const payload = text.slice(TRACE_PREFIX.length);
          const parsed = JSON.parse(payload) as {
            type: string; timestamp: number; url: string;
            ref?: number; xpath?: string; cssSelector?: string;
            value?: string; key?: string; direction?: string;
            pixels?: number; checked?: boolean;
            elementRole?: string; elementName?: string; elementTag?: string;
          };
          const allowedTypes = new Set(["click", "fill", "select", "press", "scroll", "check", "navigation"]);
          if (!parsed || typeof parsed.type !== "string" || !allowedTypes.has(parsed.type)) {
            return;
          }
          const direction = parsed.direction === "up" || parsed.direction === "down" ? parsed.direction : undefined;
          const pickStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
          const pickNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
          const pickBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
          if (parsed.type === "navigation") {
            tab.addTraceNavigation(pickStr(parsed.url) ?? "");
          } else {
            tab.addTraceEvent({
              type: parsed.type as TraceEvent["type"],
              timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
              url: pickStr(parsed.url) ?? "",
              ref: pickNum(parsed.ref),
              xpath: pickStr(parsed.xpath),
              cssSelector: pickStr(parsed.cssSelector),
              value: pickStr(parsed.value),
              key: pickStr(parsed.key),
              direction,
              pixels: pickNum(parsed.pixels),
              checked: pickBool(parsed.checked),
              elementRole: pickStr(parsed.elementRole),
              elementName: pickStr(parsed.elementName),
              elementTag: pickStr(parsed.elementTag),
            });
          }
          return; // Don't add to regular console messages
        } catch {
          // Parse failed — fall through to regular console handler
        }
      }

      tab.addConsoleMessage({
        type: ["log", "info", "warn", "error", "debug"].includes(normalizedType)
          ? (normalizedType as "log" | "info" | "warn" | "error" | "debug")
          : "log",
        text,
        timestamp: Math.round(Number(params.timestamp ?? Date.now())),
        url:
          typeof firstCallFrame?.url === "string" ? firstCallFrame.url : undefined,
        lineNumber:
          typeof firstCallFrame?.lineNumber === "number"
            ? firstCallFrame.lineNumber
            : undefined,
      });
      return;
    }

    // JS Error events
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as JsonObject | undefined;
      if (!details) return;
      const exception = details.exception as JsonObject | undefined;
      const stackTrace = details.stackTrace as JsonObject | undefined;
      const callFrames = Array.isArray(stackTrace?.callFrames)
        ? (stackTrace.callFrames as JsonObject[])
        : [];
      tab.addJSError({
        message:
          typeof exception?.description === "string"
            ? exception.description
            : String(details.text ?? "JavaScript exception"),
        url:
          typeof details.url === "string"
            ? details.url
            : typeof callFrames[0]?.url === "string"
              ? String(callFrames[0].url)
              : undefined,
        lineNumber:
          typeof details.lineNumber === "number" ? details.lineNumber : undefined,
        columnNumber:
          typeof details.columnNumber === "number" ? details.columnNumber : undefined,
        stackTrace:
          callFrames.length > 0
            ? callFrames
                .map(
                  (frame) =>
                    `${String(frame.functionName ?? "<anonymous>")} (${String(frame.url ?? "")}:${String(frame.lineNumber ?? 0)}:${String(frame.columnNumber ?? 0)})`,
                )
                .join("\n")
            : undefined,
        timestamp: Date.now(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Target management
  // ---------------------------------------------------------------------------

  /** Attach to a target and enable required CDP domains. */
  async attachAndEnable(targetId: string): Promise<string> {
    if (this.sessions.has(targetId)) {
      // Already attached — register tab state if not present
      this.tabManager.addTab(targetId);
      return this.sessions.get(targetId)!;
    }

    const result = await this.browserCommand<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    this.sessions.set(targetId, result.sessionId);
    this.attachedTargets.set(result.sessionId, targetId);

    // Register in tab state manager
    this.tabManager.addTab(targetId);

    // Enable domains
    await this.sessionCommand(targetId, "Page.enable").catch(() => {});
    await this.sessionCommand(targetId, "Runtime.enable").catch(() => {});
    await this.sessionCommand(targetId, "Network.enable").catch(() => {});
    await this.sessionCommand(targetId, "DOM.enable").catch(() => {});
    await this.sessionCommand(targetId, "Accessibility.enable").catch(() => {});

    return result.sessionId;
  }

  /** Get all targets via CDP Target.getTargets. */
  async getTargets(): Promise<CdpTargetInfo[]> {
    const result = await this.browserCommand<{
      targetInfos: Array<{
        targetId: string;
        type: string;
        title: string;
        url: string;
      }>;
    }>("Target.getTargets");

    return (result.targetInfos || []).map((t) => ({
      id: t.targetId,
      type: t.type,
      title: t.title,
      url: t.url,
    }));
  }

  /**
   * Ensure we have a valid page target and return it. Supports resolution by:
   *   - short ID string
   *   - full target ID string
   *   - numeric index
   *   - undefined (use currentTargetId or first page)
   */
  async ensurePageTarget(tabRef?: string | number): Promise<CdpTargetInfo> {
    const targets = (await this.getTargets()).filter((t) => t.type === "page");
    if (targets.length === 0) throw new Error("No page target found");

    let target: CdpTargetInfo | undefined;

    if (typeof tabRef === "string") {
      // Try short ID first
      const resolvedTargetId = this.tabManager.resolveShortId(tabRef);
      if (resolvedTargetId) {
        target = targets.find((t) => t.id === resolvedTargetId);
      }
      // Then try full target ID
      if (!target) {
        target = targets.find((t) => t.id === tabRef);
      }
      // Then try as numeric index
      if (!target) {
        const num = Number(tabRef);
        if (!Number.isNaN(num)) {
          target = targets[num];
        }
      }
    } else if (typeof tabRef === "number") {
      target = targets[tabRef];
    } else if (this.currentTargetId) {
      target = targets.find((t) => t.id === this.currentTargetId);
    }

    if (typeof tabRef === "string" && !target) {
      throw new Error(`Tab not found: ${tabRef}`);
    }

    target ??= targets[0];
    this.currentTargetId = target.id;
    await this.attachAndEnable(target.id);
    return target;
  }

  /** Check if a session exists for a given targetId. */
  hasSession(targetId: string): boolean {
    return this.sessions.has(targetId);
  }

  // ---------------------------------------------------------------------------
  // CDP command sending
  // ---------------------------------------------------------------------------

  /** Send a browser-level CDP command. */
  async browserCommand<T = unknown>(method: string, params: JsonObject = {}): Promise<T> {
    if (!this.socket) throw new Error("CDP not connected");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
      });
      this.socket!.send(payload);
    });
  }

  /** Send a session-level CDP command (flat protocol). */
  async sessionCommand<T = unknown>(
    targetId: string,
    method: string,
    params: JsonObject = {},
  ): Promise<T> {
    if (!this.socket) throw new Error("CDP not connected");
    const sessionId =
      this.sessions.get(targetId) ?? (await this.attachAndEnable(targetId));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, sessionId });
    return new Promise<T>((resolve, reject) => {
      const check = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString()) as JsonObject;
        if (msg.id === id && msg.sessionId === sessionId) {
          this.socket!.off("message", check);
          if (msg.error) {
            reject(
              new Error(
                `${method}: ${(msg.error as JsonObject).message ?? "Unknown CDP error"}`,
              ),
            );
          } else {
            resolve(msg.result as T);
          }
        }
      };
      this.socket!.on("message", check);
      this.socket!.send(payload);
    });
  }

  /**
   * Send a page-scoped command. If the tab has an active iframe,
   * the frameId is injected into the params.
   */
  async pageCommand<T = unknown>(
    targetId: string,
    method: string,
    params: JsonObject = {},
  ): Promise<T> {
    const tab = this.tabManager.getTab(targetId);
    const frameId = tab?.activeFrameId;
    return this.sessionCommand<T>(
      targetId,
      method,
      frameId ? { ...params, frameId } : params,
    );
  }

  /** Inject trace event listeners into a page (start recording). */
  async startTraceInjection(targetId: string): Promise<void> {
    // Order matters: set the recording flag BEFORE running the injection script,
    // so that when the script walks frames and copies `__bbBrowserTraceRecording`
    // into each same-origin frame, the value being copied is already `true`.
    await this.evaluate(targetId, "window.__bbBrowserTraceRecording = true", true);
    await this.evaluate(targetId, TRACE_INJECTION_SCRIPT, true);
    // Defensive: force-sync recording state into all accessible frames.
    // Covers (a) frames whose contentWindow was unreadable during initial walk
    // and (b) frames injected by a previous start() with recording=false.
    await this.evaluate(
      targetId,
      `(function(){
        Array.from(document.querySelectorAll('frame, iframe')).forEach(function(el){
          try {
            var fw = el.contentWindow;
            if (fw) fw.__bbBrowserTraceRecording = true;
          } catch(e) {}
        });
      })()`,
      true,
    );
    // Health check: verify the injection actually took effect (e.g. console.log
    // wasn't overridden, no CSP/sandbox blocking the script).
    const injected = await this.evaluate<boolean>(
      targetId,
      "!!window.__bbBrowserTraceInjected",
      true,
    );
    if (!injected) {
      throw new Error(
        "Trace injection failed: __bbBrowserTraceInjected flag not set (page may override console or block script execution)",
      );
    }
  }

  /** Remove trace recording flag from a page (stop recording). */
  async stopTraceInjection(targetId: string): Promise<void> {
    await this.evaluate(
      targetId,
      `window.__bbBrowserTraceRecording = false;
       Array.from(document.querySelectorAll('frame,iframe')).forEach(function(el){
         try{ if(el.contentWindow) el.contentWindow.__bbBrowserTraceRecording=false; }catch(e){}
       });`,
      true,
    );
  }

  /**
   * Evaluate JavaScript expression on a target.
   */
  async evaluate<T>(
    targetId: string,
    expression: string,
    returnByValue = true,
  ): Promise<T> {
    const result = await this.sessionCommand<{
      result: { type?: string; value?: T; objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(targetId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Runtime.evaluate failed",
      );
    }
    return (result.result.value ?? result.result) as T;
  }
}
