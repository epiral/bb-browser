/**
 * HTTP Server for the CDP-direct daemon.
 *
 * Endpoints:
 *   POST /command   — receive Request, dispatch via CDP, return Response
 *   GET  /status    — daemon health + per-tab stats
 *   POST /shutdown  — graceful shutdown
 *
 * Bearer token authentication (optional, but enforced when token is set).
 * Two-phase startup: HTTP server starts immediately, CDP connects async.
 * Commands received before CDP is ready queue and wait.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createWriteStream, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Request } from "@bb-browser/shared";
import { COMMAND_TIMEOUT, DAEMON_PORT } from "@bb-browser/shared";
import { CdpConnection } from "./cdp-connection.js";
import type { CommandHistory } from "./command-history.js";
import { CommandScheduler } from "./command-scheduler.js";
import { SessionManager, type SessionScope } from "./session-state.js";
import { getCatalog, invalidateCatalog, queryCatalog } from "./site-catalog.js";
import { DAEMON_DIR } from "@bb-browser/shared";
import type { AgentRegistry } from "./agent-registry.js";
import type { BindingStore } from "./binding-store.js";
import type { JournalManager } from "./agent-journal.js";
import type { ScratchpadManager } from "./scratchpad-manager.js";
import { dispatchRequest, type DispatchContext } from "./command-dispatch.js";

/** Parse a positive integer env var, falling back to `fallback` if unset/invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Mutable startup status shared between the background CDP bring-up loop and
 * the HTTP server, so /status can report when it's blocked on user consent to
 * close a non-debuggable browser.
 */
export interface DaemonRuntimeStatus {
  /** True while a browser is running without debugging and we lack consent. */
  needsBrowserConsent: boolean;
}

export interface HttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
  cdp: CdpConnection;
  history?: CommandHistory;
  agentRegistry?: AgentRegistry;
  bindingStore?: BindingStore;
  journalManager?: JournalManager;
  scratchpadManager?: ScratchpadManager;
  onShutdown?: () => void;
  runtimeStatus?: DaemonRuntimeStatus;
}

export class HttpServer {
  private server: Server | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly token: string | null;
  private readonly cdp: CdpConnection;
  private readonly history: CommandHistory | null;
  private readonly agentRegistry: AgentRegistry | null;
  private readonly bindingStore: BindingStore | null;
  private readonly journalManager: JournalManager | null;
  private readonly scratchpadManager: ScratchpadManager | null;
  private readonly onShutdown?: () => void;
  private readonly runtimeStatus: DaemonRuntimeStatus;
  private readonly sessions = new SessionManager();
  private readonly scheduler: CommandScheduler;
  private startTime = 0;

  constructor(options: HttpServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? DAEMON_PORT;
    this.token = options.token ?? null;
    this.cdp = options.cdp;
    this.history = options.history ?? null;
    this.agentRegistry = options.agentRegistry ?? null;
    this.bindingStore = options.bindingStore ?? null;
    this.journalManager = options.journalManager ?? null;
    this.scratchpadManager = options.scratchpadManager ?? null;
    this.onShutdown = options.onShutdown;
    this.runtimeStatus = options.runtimeStatus ?? { needsBrowserConsent: false };
    this.scheduler = new CommandScheduler({
      globalLimit: envInt("BB_SCHED_GLOBAL_LIMIT", 12),
      perSessionLimit: envInt("BB_SCHED_SESSION_LIMIT", 4),
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", reject);

      this.server.listen(this.port, this.host, () => {
        this.startTime = Date.now();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  get uptime(): number {
    if (this.startTime === 0) return 0;
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.token) return true;
    const auth = req.headers.authorization ?? "";
    if (auth === `Bearer ${this.token}`) return true;
    this.sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-BB-Session, X-BB-Session-Label, X-BB-Session-Scope");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";

    // /ping 不需要认证（前端连接检测用）。
    // 只对 loopback 调用方回显 token：daemon 现在绑定 0.0.0.0 以便 WSL 访问，
    // 若对 LAN 回显 token 等于把浏览器控制权拱手让人。本机（控制面板 vite-dev
    // 回退路径）仍能拿到 token；WSL / 远程 client 从 daemon.json 取 token。
    if (req.method === "GET" && url === "/ping") {
      this.sendJson(res, 200, {
        pong: true,
        token: isLoopback(req) ? this.token : null,
      });
      return;
    }

    if (!this.checkAuth(req, res)) return;

    if (req.method === "POST" && url === "/command") {
      this.handleCommand(req, res);
    } else if (req.method === "GET" && url === "/status") {
      this.handleStatus(req, res);
    } else if (req.method === "POST" && url === "/shutdown") {
      this.handleShutdown(req, res);
    } else if (req.method === "GET" && url.startsWith("/api/overview")) {
      this.handleOverview(res);
    } else if (req.method === "GET" && url.startsWith("/api/commands")) {
      this.handleCommands(url, res);
    } else if (req.method === "GET" && url.startsWith("/api/logs")) {
      this.handleLogs(url, res);
    } else if (req.method === "GET" && url.startsWith("/api/sites")) {
      this.handleSites(url, res);
    } else if (req.method === "GET" && /^\/api\/agents\/[^/]+\/context/.test(url)) {
      this.handleAgentContext(url, res);
    } else if (req.method === "GET" && url.startsWith("/api/agents")) {
      this.handleAgents(res);
    } else if (req.method === "GET" && url.startsWith("/api/bindings")) {
      this.handleBindings(url, res);
    } else {
      this.sendJson(res, 404, { error: "Not found" });
    }
  }

  // ---------------------------------------------------------------------------
  // POST /command
  // ---------------------------------------------------------------------------

  private async handleCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const request = JSON.parse(body) as Request;

      // resume is pure-state — no CDP needed; handle before the CDP wait
      if (request.action === "resume") {
        const sessionId = (req.headers["x-bb-session"] as string | undefined) ?? "default";
        const sessionLabel = req.headers["x-bb-session-label"] as string | undefined;
        const explicitAgentId = req.headers["x-bb-agent"] as string | undefined;
        const agentRec = this.agentRegistry?.resolveOrCreate({ sessionId, explicitAgentId, label: sessionLabel });
        const session = this.sessions.getOrCreate(sessionId, sessionLabel, undefined, agentRec?.agentId);
        const agentId = session.agentId;
        if (!agentId) {
          this.sendJson(res, 200, { id: request.id, success: false, error: "No stable agent identity — set x-bb-agent header or x-bb-session-label" });
          return;
        }
        const limit = typeof request.limit === "number" ? request.limit : 50;
        const bindings = this.bindingStore?.forAgent(agentId) ?? [];
        const journal = this.journalManager?.getRecent(agentId, limit) ?? [];
        this.sendJson(res, 200, { id: request.id, success: true, agentId, bindings, journal });
        return;
      }

      // Wait for CDP to be ready (two-phase startup)
      if (!this.cdp.connected) {
        try {
          await Promise.race([
            this.cdp.waitUntilReady(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("CDP connection timeout")), COMMAND_TIMEOUT),
            ),
          ]);
        } catch {
          const cdpTarget = `${this.cdp.host}:${this.cdp.port}`;
          const reason = this.cdp.lastError || "unknown";
          this.sendJson(res, 503, {
            id: request.id,
            success: false,
            error: `Chrome not connected (CDP at ${cdpTarget})`,
            reason,
            hint: "Make sure Chrome is running. Try: bb-browser daemon shutdown && bb-browser tab list",
          });
          return;
        }
      }

      // Resolve the calling agent's session (isolates per-session "current tab").
      const sessionId = (req.headers["x-bb-session"] as string | undefined) ?? "default";
      const sessionLabel = req.headers["x-bb-session-label"] as string | undefined;
      const explicitAgentId = req.headers["x-bb-agent"] as string | undefined;
      const rawScope = req.headers["x-bb-session-scope"] as string | undefined;
      const sessionScope = (
        rawScope === "read-only" || rawScope === "no-eval" ? rawScope : undefined
      ) as SessionScope | undefined;
      const agentRec = this.agentRegistry?.resolveOrCreate({
        sessionId,
        explicitAgentId,
        label: sessionLabel,
      });
      const session = this.sessions.getOrCreate(sessionId, sessionLabel, sessionScope, agentRec?.agentId);

      // Admission control: bound global + per-session concurrency and serve
      // waiters fairly before touching the shared CDP connection. Acquired
      // AFTER the CDP-ready wait so a stalled browser never consumes slots.
      const release = await this.scheduler.acquire(session.id);

      // Dispatch with timeout
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Command timeout")), COMMAND_TIMEOUT),
      );
      const finish = this.history?.record(request.action ?? "unknown", request, session.id);
      try {
        const dispatchCtx: DispatchContext = {
          bindingStore: this.bindingStore ?? undefined,
          scratchpadManager: this.scratchpadManager ?? undefined,
        };
        const response = await Promise.race([
          dispatchRequest(this.cdp, request, session, dispatchCtx),
          timeout,
        ]);
        finish?.();
        // Write journal + scratchpad after successful dispatch
        if (session.agentId && this.journalManager) {
          const tab = typeof request.tabId === "string" ? request.tabId : undefined;
          const url = request.action === "open" ? request.url : undefined;
          this.journalManager.record(session.agentId, request.action, tab, url, response.success !== false);
        }
        if (this.scratchpadManager && session.currentTargetId) {
          const tabState = this.cdp.tabManager.getTab(session.currentTargetId);
          if (tabState) {
            this.scratchpadManager.record(tabState.bbTabId, request.action, session.agentId);
          }
        }
        this.sendJson(res, 200, response);
      } catch (err2) {
        finish?.(false);
        throw err2;
      } finally {
        release();
      }
    } catch (error) {
      this.sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : "Invalid request",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // GET /status
  // ---------------------------------------------------------------------------

  private handleStatus(_req: IncomingMessage, res: ServerResponse): void {
    const tabs = this.cdp.tabManager.allTabs().map((tab) => ({
      shortId: tab.shortId,
      targetId: tab.targetId,
      bbTabId: tab.bbTabId,
      networkRequests: tab.networkRequests.size,
      consoleMessages: tab.consoleMessages.size,
      jsErrors: tab.jsErrors.size,
      lastActionSeq: tab.lastActionSeq,
      leaseOwner: tab.leaseOwner,
      leaseMode: tab.leaseMode !== "shared" ? tab.leaseMode : undefined,
    }));

    this.sendJson(res, 200, {
      running: true,
      cdpConnected: this.cdp.connected,
      cdpPort: this.cdp.port,
      needsBrowserConsent: this.runtimeStatus.needsBrowserConsent,
      uptime: this.uptime,
      currentSeq: this.cdp.tabManager.currentSeq(),
      scheduler: this.scheduler.stats(),
      sessions: this.sessions.all().map((s) => ({
        id: s.id,
        label: s.label,
        scope: s.scope !== "full" ? s.scope : undefined,
        currentTargetId: s.currentTargetId,
        lastSeen: s.lastSeen,
      })),
      tabs,
    });
  }

  // ---------------------------------------------------------------------------
  // GET /api/overview
  // ---------------------------------------------------------------------------

  private handleOverview(res: ServerResponse): void {
    const tabs = this.cdp.tabManager.allTabs();
    this.sendJson(res, 200, {
      uptime: this.uptime,
      daemonPort: this.port,
      cdpPort: this.cdp.port,
      cdpConnected: this.cdp.connected,
      tabCount: tabs.length,
      chromeVersion: this.cdp.chromeVersion ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // GET /api/commands?limit=50
  // ---------------------------------------------------------------------------

  private handleCommands(url: string, res: ServerResponse): void {
    const limit = parseIntParam(url, "limit", 50);
    const records = this.history ? this.history.recent(limit) : [];
    this.sendJson(res, 200, { commands: records });
  }

  // ---------------------------------------------------------------------------
  // GET /api/logs?level=&limit=200
  // ---------------------------------------------------------------------------

  private handleLogs(url: string, res: ServerResponse): void {
    const limit = parseIntParam(url, "limit", 200);
    const level = parseStringParam(url, "level", "");
    const since = parseIntParam(url, "since", 0);
    const logs = logStore.recent(limit, level, since);
    this.sendJson(res, 200, { logs });
  }

  // ---------------------------------------------------------------------------
  // GET /api/sites?q=&domain=&invalidate=1
  // ---------------------------------------------------------------------------

  private handleSites(url: string, res: ServerResponse): void {
    if (parseStringParam(url, "invalidate", "") === "1") invalidateCatalog();
    const q = parseStringParam(url, "q", "");
    const domain = parseStringParam(url, "domain", "");
    const { adapters, cacheAge } = getCatalog(DAEMON_DIR);
    const results = queryCatalog(adapters, { q: q || undefined, domain: domain || undefined });
    this.sendJson(res, 200, { adapters: results, total: adapters.length, cacheAge });
  }

  // ---------------------------------------------------------------------------
  // GET /api/agents
  // ---------------------------------------------------------------------------

  private handleAgents(res: ServerResponse): void {
    const agents = this.agentRegistry?.all() ?? [];
    this.sendJson(res, 200, { agents });
  }

  // ---------------------------------------------------------------------------
  // GET /api/agents/:id/context[?limit=N]
  // ---------------------------------------------------------------------------

  private handleAgentContext(url: string, res: ServerResponse): void {
    const parts = url.split("?");
    const segments = parts[0].split("/");
    const agentId = segments[3] ?? "";
    const limit = parseInt(new URL(url, "http://localhost").searchParams.get("limit") ?? "50", 10);
    const bindings = this.bindingStore?.forAgent(agentId) ?? [];
    const journal = this.journalManager?.getRecent(agentId, Number.isFinite(limit) && limit > 0 ? limit : 50) ?? [];
    this.sendJson(res, 200, { agentId, bindings, journal });
  }

  // ---------------------------------------------------------------------------
  // GET /api/bindings[?agentId=<id>]
  // ---------------------------------------------------------------------------

  private handleBindings(url: string, res: ServerResponse): void {
    const agentId = new URL(url, "http://localhost").searchParams.get("agentId");
    const all = this.bindingStore?.all() ?? [];
    const bindings = agentId ? all.filter((b) => b.agentId === agentId) : all;
    this.sendJson(res, 200, { bindings });
  }

  // ---------------------------------------------------------------------------
  // POST /shutdown
  // ---------------------------------------------------------------------------

  private handleShutdown(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, { code: 0, message: "Shutting down" });

    setTimeout(() => {
      try { installLogInterceptor.flush?.(); } catch {}
      if (this.onShutdown) {
        this.onShutdown();
      }
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

// ---------------------------------------------------------------------------
// URL query-string helpers
// ---------------------------------------------------------------------------

function parseIntParam(url: string, name: string, def: number): number {
  const m = new RegExp(`[?&]${name}=(\\d+)`).exec(url);
  if (!m) return def;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function parseStringParam(url: string, name: string, def: string): string {
  const m = new RegExp(`[?&]${name}=([^&]*)`).exec(url);
  return m ? decodeURIComponent(m[1]) : def;
}

// ---------------------------------------------------------------------------
// In-process log store (singleton)
//
// Captures lines written to stderr via a lightweight interceptor so the
// /api/logs endpoint can serve them without touching the filesystem.
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  msg: string;
}

import { RingBuffer } from "./ring-buffer.js";

class LogStore {
  private readonly buf = new RingBuffer<LogEntry>(1000);

  push(entry: LogEntry): void {
    this.buf.push(entry);
  }

  recent(limit: number, level: string, since = 0): LogEntry[] {
    const all = this.buf.toArray();
    const filtered = all.filter(
      (e) => (!level || e.level === level) && e.ts > since,
    );
    return filtered.slice(-limit).reverse();
  }
}

export const logStore = new LogStore();

/**
 * Call once at daemon startup to intercept `console.error` (which the daemon
 * uses for all operational logging) and feed entries into `logStore`.
 *
 * Original write still goes to stderr so nothing is lost. When `logFilePath`
 * is provided, each line is also appended there so startup failures are
 * diagnosable after the fact (the tray's "打开日志文件夹" opens this dir).
 */
/** Map console method name → log level.
 *  This daemon uses console.error as its standard output stream, so
 *  console.error → "info" preserves historical behaviour. */
const METHOD_TO_LEVEL: Record<string, LogEntry["level"]> = {
  error: "info",
  warn: "warn",
  info: "info",
  log: "info",
  debug: "debug",
};

/**
 * True if the request originates from the local loopback interface. Used to
 * decide whether /ping may echo the auth token: the daemon binds 0.0.0.0 (so
 * WSL2 agents can reach it via the Windows host IP), and we must not hand the
 * token to non-local callers on the LAN.
 */
export function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

/** Rotate logFilePath if it exceeds maxSize bytes, keeping up to `keep` archives. */
function rotateLog(filePath: string, maxSize: number, keep: number): void {
  try {
    const st = statSync(filePath);
    if (st.size < maxSize) return;
  } catch {
    return;
  }
  for (let i = keep; i >= 1; i--) {
    const oldPath = i === 1 ? filePath : `${filePath}.${i}`;
    const newPath = `${filePath}.${i + 1}`;
    try {
      if (i === keep) { try { unlinkSync(newPath); } catch {} }
      renameSync(oldPath, newPath);
    } catch {}
  }
}

export function installLogInterceptor(logFilePath?: string): void {
  let fileSink: import("node:fs").WriteStream | null = null;
  if (logFilePath) {
    try {
      mkdirSync(dirname(logFilePath), { recursive: true });
      rotateLog(logFilePath, 10 * 1024 * 1024, 3);
      const stream = createWriteStream(logFilePath, { flags: "a" });
      fileSink = stream;
      stream.write(
        `\n===== bb-browser daemon started ${new Date().toISOString()} (pid ${process.pid}) =====\n`,
      );
    } catch {
      // Best-effort: if we can't open the log file, keep logging to stderr.
    }
  }

  const orig: Record<string, (...args: unknown[]) => void> = {};
  for (const method of ["log", "warn", "error", "debug", "info"] as const) {
    orig[method] = (console[method] as (...a: unknown[]) => void).bind(console);
    (console[method] as (...a: unknown[]) => void) = (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      const trimmed = msg.trimEnd();
      if (trimmed) {
        const level = METHOD_TO_LEVEL[method] ?? "info";
        const entry: LogEntry = { ts: Date.now(), level, msg: trimmed };
        logStore.push(entry);
        if (fileSink) {
          try {
            fileSink.write(`${new Date(entry.ts).toISOString()} [${level}] ${trimmed}\n`);
          } catch {}
        }
      }
      orig[method](...args);
    };
  }

  installLogInterceptor.flush = () => {
    if (fileSink) {
      try { fileSink.end(); } catch {}
      fileSink = null;
    }
  };
}

installLogInterceptor.flush = (): void => {};  // placeholder before first call
