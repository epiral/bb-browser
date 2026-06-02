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
import { TabStateManager } from "./tab-state.js";

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
// Stealth — hide headless/automation fingerprints
// ---------------------------------------------------------------------------

const STEALTH_SCRIPT = `
(() => {
  if (window.__bbStealthApplied) return;
  try { Object.defineProperty(window, '__bbStealthApplied', { value: true, configurable: false }); }
  catch (e) { window.__bbStealthApplied = true; }

  const define = (obj, name, value) => {
    try {
      Object.defineProperty(obj, name, { get: () => value, configurable: true });
    } catch (e) {}
  };

  try {
    define(Navigator.prototype, 'webdriver', false);
  } catch (e) {}
  define(navigator, 'webdriver', false);
  define(navigator, 'languages', ['zh-CN', 'zh', 'en-US', 'en']);
  define(navigator, 'language', 'zh-CN');
  define(navigator, 'platform', 'MacIntel');
  define(navigator, 'hardwareConcurrency', 8);
  define(navigator, 'deviceMemory', 8);

  const fakePlugin = (name, filename, description) => {
    const plugin = { name, filename, description, length: 1 };
    plugin[0] = { type: 'application/pdf', suffixes: 'pdf', description, enabledPlugin: plugin };
    return plugin;
  };
  try {
    const plugins = [
      fakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    plugins.item = (i) => plugins[i] || null;
    plugins.namedItem = (name) => plugins.find((p) => p.name === name) || null;
    plugins.refresh = () => {};
    Object.setPrototypeOf(plugins, PluginArray.prototype);
    define(navigator, 'plugins', plugins);

    const mimeTypes = [{
      type: 'application/pdf',
      suffixes: 'pdf',
      description: 'Portable Document Format',
      enabledPlugin: plugins[0],
    }];
    mimeTypes.item = (i) => mimeTypes[i] || null;
    mimeTypes.namedItem = (name) => mimeTypes.find((m) => m.type === name) || null;
    Object.setPrototypeOf(mimeTypes, MimeTypeArray.prototype);
    define(navigator, 'mimeTypes', mimeTypes);
  } catch (e) {}

  try {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    window.chrome.app = window.chrome.app || {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
    window.chrome.csi = window.chrome.csi || function () { return { onloadT: Date.now(), startE: Date.now() }; };
    window.chrome.loadTimes = window.chrome.loadTimes || function () { return {}; };
  } catch (e) {}

  try {
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission || 'prompt', onchange: null })
          : origQuery.call(navigator.permissions, params);
    }
  } catch (e) {}

  const overrideGetParameter = (proto) => {
    if (!proto || !proto.getParameter) return;
    const original = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return original.apply(this, [param]);
    };
  };
  try { overrideGetParameter(WebGLRenderingContext.prototype); } catch (e) {}
  try { overrideGetParameter(WebGL2RenderingContext.prototype); } catch (e) {}

  try {
    if (typeof Notification !== 'undefined') {
      define(Notification, 'permission', 'default');
      Notification.requestPermission = function () {
        return new Promise((resolve) => setTimeout(() => resolve('default'), 120));
      };
    }
  } catch (e) {}

  // Per-session stable seed for canvas/WebGL/audio fingerprint noise
  const seed = (() => {
    if (window.__bbSeed !== undefined) return window.__bbSeed;
    const value = Math.floor(Math.random() * 251) + 1;
    try { Object.defineProperty(window, '__bbSeed', { value, configurable: false }); } catch (e) { window.__bbSeed = value; }
    return value;
  })();

  try {
    const stamped = new WeakSet();
    const stampNoise = (canvas) => {
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
      if (stamped.has(canvas)) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      try {
        const x = canvas.width - 1;
        const y = canvas.height - 1;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(' + seed + ',' + ((seed * 37) & 255) + ',' + ((seed * 53) & 255) + ',0.005)';
        ctx.fillRect(x, y, 1, 1);
        ctx.restore();
        stamped.add(canvas);
      } catch (e) {}
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      stampNoise(this);
      return origToDataURL.apply(this, arguments);
    };
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    if (origToBlob) {
      HTMLCanvasElement.prototype.toBlob = function () {
        stampNoise(this);
        return origToBlob.apply(this, arguments);
      };
    }
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      const data = origGetImageData.apply(this, arguments);
      if (data && data.data && data.data.length >= 4) {
        const i = data.data.length - 4;
        data.data[i] = (data.data[i] + seed) & 0xff;
        data.data[i + 1] = (data.data[i + 1] + ((seed * 37) & 0xff)) & 0xff;
        data.data[i + 2] = (data.data[i + 2] + ((seed * 53) & 0xff)) & 0xff;
      }
      return data;
    };
  } catch (e) {}

  try {
    const audioMutated = new WeakSet();
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (channel) {
      const data = origGetChannelData.call(this, channel);
      if (data && data.length >= 1 && !audioMutated.has(this)) {
        data[0] = data[0] + ((seed - 128) * 1e-7);
        audioMutated.add(this);
      }
      return data;
    };
  } catch (e) {}

  try {
    const wrapReadPixels = (proto) => {
      if (!proto || !proto.readPixels) return;
      const original = proto.readPixels;
      proto.readPixels = function () {
        original.apply(this, arguments);
        const pixels = arguments[6];
        if (pixels && pixels.length >= 4) {
          pixels[0] = (pixels[0] + seed) & 0xff;
          pixels[1] = (pixels[1] + ((seed * 37) & 0xff)) & 0xff;
          pixels[2] = (pixels[2] + ((seed * 53) & 0xff)) & 0xff;
        }
      };
    };
    wrapReadPixels(WebGLRenderingContext.prototype);
    wrapReadPixels(WebGL2RenderingContext.prototype);
  } catch (e) {}
})();
`;

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
          const targetId = targetInfo.targetId;
          this.sessions.set(targetId, sessionId);
          this.attachedTargets.set(sessionId, targetId);

          // Re-enable CDP domains on the new session. This handles same-tab
          // navigation where Chrome detaches the old session and creates a new
          // one — CDP domains (Network, Runtime, etc.) must be re-enabled.
          const existingTab = this.tabManager.getTab(targetId);
          if (existingTab) {
            this.sessionCommand(targetId, "Page.enable").catch(() => {});
            this.sessionCommand(targetId, "Runtime.enable").catch(() => {});
            this.sessionCommand(targetId, "Network.enable").catch(() => {});
            this.sessionCommand(targetId, "DOM.enable").catch(() => {});
            this.sessionCommand(targetId, "Accessibility.enable").catch(() => {});

            // Re-inject human capture if this tab is being traced
            if (this.tabManager.isTraced(targetId)) {
              this.enableHumanCapture(targetId).catch(() => {});
            }
          } else {
            // New target — register tab state
            this.tabManager.addTab(targetId);
          }
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
            // Do NOT call tabManager.removeTab() here — detach can happen
            // during same-tab navigation (cross-origin). The tab target still
            // exists; only Target.targetDestroyed should remove tab state.
            // Session maps are cleaned so the old sessionId won't route events,
            // but the tab's event buffers (network, console, etc.) are preserved.
          }
        }
        return;
      }

      // New target auto-attach
      if (message.method === "Target.targetCreated") {
        const params = message.params as JsonObject;
        const targetInfo = params.targetInfo as JsonObject;
        if (targetInfo?.type === "page" && typeof targetInfo.targetId === "string") {
          const newTargetId = targetInfo.targetId;
          const openerId = typeof targetInfo.openerId === "string" ? targetInfo.openerId : undefined;
          this.attachAndEnable(newTargetId).catch(() => {});

          // Auto-join trace session if opener is being traced
          const session = this.tabManager.traceSession;
          if (session?.active && openerId && session.tracedTabs.has(openerId)) {
            session.tracedTabs.add(newTargetId);
            // Enable human capture on the new tab (delay to let attach complete)
            setTimeout(() => {
              this.enableHumanCapture(newTargetId).catch(() => {});
            }, 500);
          }
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

    // Network events
    if (method === "Network.requestWillBeSent") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const request = params.request as JsonObject | undefined;
      if (!requestId || !request) return;
      const url = String(request.url ?? "");
      const reqMethod = String(request.method ?? "GET");
      const resourceType = String(params.type ?? "Other");
      const headers = normalizeHeaders(request.headers);
      const body = typeof request.postData === "string" ? request.postData : undefined;
      tab.addNetworkRequest(requestId, {
        url,
        method: reqMethod,
        type: resourceType,
        timestamp: Math.round(Number(params.timestamp ?? Date.now()) * 1000),
        requestHeaders: headers,
        requestBody: body,
      });
      // Push to trace timeline
      if (this.tabManager.isTraced(targetId)) {
        const now = Date.now();
        this.tabManager.tracePush({
          seq: this.tabManager.nextSeq(),
          ts: now,
          tab: tab.shortId,
          type: 'request',
          requestId,
          method: reqMethod,
          url,
          resourceType,
          headers,
          body,
          triggerSeq: this.tabManager.inferTriggerSeq(now),
        });
      }
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const response = params.response as JsonObject | undefined;
      if (!requestId || !response) return;
      const status = typeof response.status === "number" ? response.status : 0;
      const mimeType = typeof response.mimeType === "string" ? response.mimeType : undefined;
      tab.updateNetworkResponse(requestId, {
        status: typeof response.status === "number" ? response.status : undefined,
        statusText: typeof response.statusText === "string" ? response.statusText : undefined,
        responseHeaders: normalizeHeaders(response.headers),
        mimeType,
      });
      // Push to trace timeline
      if (this.tabManager.isTraced(targetId)) {
        this.tabManager.tracePush({
          seq: this.tabManager.nextSeq(),
          ts: Date.now(),
          tab: tab.shortId,
          type: 'response',
          requestId,
          status,
          mimeType,
        });
      }
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

    // Human action capture via Runtime.bindingCalled
    if (method === "Runtime.bindingCalled") {
      const name = params.name;
      const payload = params.payload;
      if (name === "__bb_trace" && typeof payload === "string" && this.tabManager.isTraced(targetId)) {
        try {
          const data = JSON.parse(payload) as Record<string, unknown>;
          this.tabManager.tracePush({
            seq: this.tabManager.nextSeq(),
            ts: Date.now(),
            tab: tab.shortId,
            type: 'action',
            source: 'human',
            action: String(data.action ?? 'unknown'),
            selector: typeof data.selector === 'string' ? data.selector : undefined,
            text: typeof data.text === 'string' ? data.text : undefined,
            role: typeof data.role === 'string' ? data.role : undefined,
            tag: typeof data.tag === 'string' ? data.tag : undefined,
            value: typeof data.value === 'string' ? data.value : undefined,
            key: typeof data.key === 'string' ? data.key : undefined,
          });
        } catch {}
      }
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

    // Stealth: only apply to headless Chrome.
    // Full Chrome (headed or --headless=new with system Chrome) should NOT have
    // stealth injected — Emulation overrides and addScriptToEvaluateOnNewDocument
    // are themselves detectable by Google and other anti-bot systems.
    // CDP alone (without stealth) is fine for Google login.
    {
      const versionInfo = await this.browserCommand<{ product?: string; userAgent?: string }>(
        "Browser.getVersion",
      ).catch(() => null);
      const product = String((versionInfo as any)?.product ?? "");
      // Stealth injection disabled: Emulation overrides and addScriptToEvaluateOnNewDocument
      // are themselves detectable by anti-bot systems (Google, Cloudflare).
      // Full Chrome with --headless=new works without stealth.
      // headless-shell is inherently detectable (missing browser APIs) regardless of stealth.
      const isHeadlessShell = false;

      if (isHeadlessShell) {
        // headless-shell exposes "HeadlessChrome" in UA and has 800x600 screen —
        // these need to be fixed.
        const versionMatch = product.match(/(\d+\.\d+\.\d+\.\d+)/);
        const fullVersion = versionMatch ? versionMatch[1] : "149.0.7827.22";
        const majorVersion = fullVersion.split(".")[0];

        const cleanUA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;
        await this.sessionCommand(targetId, "Emulation.setUserAgentOverride", {
          userAgent: cleanUA,
          acceptLanguage: "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          platform: "MacIntel",
          userAgentMetadata: {
            brands: [
              { brand: "Chromium", version: majorVersion },
              { brand: "Google Chrome", version: majorVersion },
              { brand: "Not.A/Brand", version: "24" },
            ],
            fullVersionList: [
              { brand: "Chromium", version: fullVersion },
              { brand: "Google Chrome", version: fullVersion },
              { brand: "Not.A/Brand", version: "24.0.0.0" },
            ],
            platform: "macOS",
            platformVersion: "10.15.7",
            architecture: "x86",
            bitness: "64",
            model: "",
            mobile: false,
            wow64: false,
          },
        }).catch(() => {});

        await this.sessionCommand(targetId, "Emulation.setDeviceMetricsOverride", {
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: 1920,
          screenHeight: 1080,
        }).catch(() => {});

        await this.sessionCommand(targetId, "Page.addScriptToEvaluateOnNewDocument", {
          source: STEALTH_SCRIPT,
        }).catch(() => {});
        await this.evaluate(targetId, STEALTH_SCRIPT, false).catch(() => {});
      }
    }

    return result.sessionId;
  }

  // ---------------------------------------------------------------------------
  // Human action capture for trace
  // ---------------------------------------------------------------------------

  private static readonly HUMAN_CAPTURE_SCRIPT = `(function() {
    if (window.__bb_trace_installed) return;
    window.__bb_trace_installed = true;
    function report(data) {
      try { window.__bb_trace(JSON.stringify(data)); } catch(e) {}
    }
    function meta(el) {
      if (!el || !el.tagName) return {};
      return {
        tag: el.tagName,
        text: (el.innerText || '').slice(0, 80).trim(),
        role: el.getAttribute ? el.getAttribute('role') : undefined,
        selector: el.id ? '#' + el.id
          : el.className && typeof el.className === 'string' ? el.tagName.toLowerCase() + '.' + el.className.split(' ')[0]
          : el.tagName.toLowerCase(),
      };
    }
    document.addEventListener('click', function(e) {
      report({ action: 'click', ...meta(e.target), x: e.clientX, y: e.clientY });
    }, true);
    document.addEventListener('input', function(e) {
      report({ action: 'input', ...meta(e.target), value: e.target.value });
    }, true);
    document.addEventListener('keydown', function(e) {
      if (['Enter','Tab','Escape','Backspace','Delete'].indexOf(e.key) >= 0 || e.ctrlKey || e.metaKey) {
        report({ action: 'press', key: e.key, ...meta(e.target) });
      }
    }, true);
    document.addEventListener('submit', function(e) {
      report({ action: 'submit', ...meta(e.target) });
    }, true);
  })();`;

  /** Inject human action capture listeners into a tab via CDP binding. */
  async enableHumanCapture(targetId: string): Promise<void> {
    try {
      await this.sessionCommand(targetId, "Runtime.addBinding", { name: "__bb_trace" });
    } catch {
      // Binding may already exist
    }
    await this.sessionCommand(targetId, "Page.addScriptToEvaluateOnNewDocument", {
      source: CdpConnection.HUMAN_CAPTURE_SCRIPT,
    }).catch(() => {});
    // Also evaluate immediately for the current page
    await this.evaluate(targetId, CdpConnection.HUMAN_CAPTURE_SCRIPT, false).catch(() => {});
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
  async ensurePageTarget(
    tabRef?: string | number,
    options: { activate?: boolean } = {},
  ): Promise<CdpTargetInfo> {
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
    if (options.activate) {
      await this.browserCommand("Target.activateTarget", { targetId: target.id });
    }
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
