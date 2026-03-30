/**
 * cdp-monitor — long-running background process that maintains a persistent
 * CDP connection and accumulates network / console / error / trace data.
 *
 * Spawned (detached) by monitor-manager.ts.  Communicates with short-lived
 * CLI invocations via a tiny HTTP API on 127.0.0.1.
 *
 * Usage:
 *   node cdp-monitor.js --cdp-host 127.0.0.1 --cdp-port 19825 \
 *                        --monitor-port 19826 --token <hex>
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { Request, Response, ResponseData, TraceStatus } from "@bb-browser/shared";
import { MonitorState } from "./cdp-monitor-state.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function getArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const CDP_HOST = getArg("--cdp-host", "127.0.0.1");
const CDP_PORT = Number(getArg("--cdp-port", "19825"));
const MONITOR_PORT = Number(getArg("--monitor-port", "19826"));
const AUTH_TOKEN = getArg("--token", "");

if (!AUTH_TOKEN) {
  process.stderr.write("cdp-monitor: --token is required\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MONITOR_DIR = path.join(os.homedir(), ".bb-browser");
const PID_FILE = path.join(MONITOR_DIR, "monitor.pid");
const PORT_FILE = path.join(MONITOR_DIR, "monitor.port");
const TOKEN_FILE = path.join(MONITOR_DIR, "monitor.token");

// ---------------------------------------------------------------------------
// Auto-exit timer (30 minutes without any HTTP request)
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    shutdown("idle timeout");
  }, IDLE_TIMEOUT_MS);
  // Allow Node to exit naturally if nothing else holds it
  if (idleTimer && typeof idleTimer === "object" && "unref" in idleTimer) {
    // Do NOT unref the idle timer — we want it to keep the process alive
  }
}

// ---------------------------------------------------------------------------
// CDP helpers (mirrored from cdp-client.ts — intentionally duplicated to
// avoid coupling / risky refactor of cdp-client.ts in Phase 1)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: string;
}

let browserSocket: WebSocket | null = null;
let nextMessageId = 1;
const browserPending = new Map<number, PendingCommand>();
const sessions = new Map<string, string>(); // targetId -> sessionId
const attachedTargets = new Map<string, string>(); // sessionId -> targetId

const state = new MonitorState();
const startTime = Date.now();

// ---------------------------------------------------------------------------
// CDP connection
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

function browserCommand<T>(method: string, params: JsonObject = {}): Promise<T> {
  if (!browserSocket) throw new Error("CDP not connected");
  const id = nextMessageId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise<T>((resolve, reject) => {
    browserPending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      method,
    });
    browserSocket!.send(payload);
  });
}

function sessionCommand<T>(targetId: string, method: string, params: JsonObject = {}): Promise<T> {
  if (!browserSocket) throw new Error("CDP not connected");
  const sessionId = sessions.get(targetId);
  if (!sessionId) throw new Error(`No session for target ${targetId}`);
  const id = nextMessageId++;
  const payload = JSON.stringify({ id, method, params, sessionId });
  return new Promise<T>((resolve, reject) => {
    const check = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as JsonObject;
      if (msg.id === id && msg.sessionId === sessionId) {
        browserSocket!.off("message", check);
        if (msg.error) {
          reject(new Error(`${method}: ${(msg.error as JsonObject).message ?? "Unknown CDP error"}`));
        } else {
          resolve(msg.result as T);
        }
      }
    };
    browserSocket!.on("message", check);
    browserSocket!.send(payload);
  });
}

async function attachAndEnable(targetId: string): Promise<void> {
  if (sessions.has(targetId)) return;
  const result = await browserCommand<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  sessions.set(targetId, result.sessionId);
  attachedTargets.set(result.sessionId, targetId);

  // Enable domains the monitor cares about
  await sessionCommand(targetId, "Network.enable").catch(() => {});
  await sessionCommand(targetId, "Runtime.enable").catch(() => {});
}

function setupSocketListeners(ws: WebSocket): void {
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as JsonObject;

    // Response to a browser-level command
    if (typeof message.id === "number") {
      const pending = browserPending.get(message.id);
      if (!pending) return;
      browserPending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${pending.method}: ${(message.error as JsonObject).message ?? "Unknown CDP error"}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Flat-mode attach notification
    if (message.method === "Target.attachedToTarget") {
      const params = message.params as JsonObject;
      const sessionId = params.sessionId;
      const targetInfo = params.targetInfo as JsonObject;
      if (typeof sessionId === "string" && typeof targetInfo?.targetId === "string") {
        sessions.set(targetInfo.targetId, sessionId);
        attachedTargets.set(sessionId, targetInfo.targetId);
      }
      return;
    }

    if (message.method === "Target.detachedFromTarget") {
      const params = message.params as JsonObject;
      const sessionId = params.sessionId;
      if (typeof sessionId === "string") {
        const targetId = attachedTargets.get(sessionId);
        if (targetId) {
          sessions.delete(targetId);
          attachedTargets.delete(sessionId);
        }
      }
      return;
    }

    // New targets — auto-attach pages
    if (message.method === "Target.targetCreated") {
      const params = message.params as JsonObject;
      const targetInfo = params.targetInfo as JsonObject;
      if (targetInfo?.type === "page" && typeof targetInfo.targetId === "string") {
        attachAndEnable(targetInfo.targetId).catch(() => {});
      }
      return;
    }

    // Flat protocol: session events carry sessionId directly
    if (typeof message.sessionId === "string" && typeof message.method === "string") {
      state.handleSessionEvent(message.method as string, (message.params ?? {}) as JsonObject);
    }
  });

  ws.on("close", () => {
    log("CDP connection closed — shutting down");
    shutdown("cdp closed");
  });

  ws.on("error", (err) => {
    log(`CDP error: ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function connectCdp(): Promise<void> {
  const versionData = (await fetchJson(`http://${CDP_HOST}:${CDP_PORT}/json/version`)) as JsonObject;
  const wsUrl = versionData.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string" || !wsUrl) {
    throw new Error("CDP endpoint missing webSocketDebuggerUrl");
  }

  const ws = await connectWebSocket(wsUrl);
  browserSocket = ws;
  setupSocketListeners(ws);

  // Discover existing targets
  await browserCommand("Target.setDiscoverTargets", { discover: true });
  const result = await browserCommand<{
    targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
  }>("Target.getTargets");

  const pages = (result.targetInfos || []).filter((t) => t.type === "page");
  for (const page of pages) {
    await attachAndEnable(page.targetId).catch(() => {});
  }

  state.networkEnabled = true;
  state.consoleEnabled = true;
  state.errorsEnabled = true;

  log(`Connected to CDP, monitoring ${pages.length} page(s)`);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function ok(id: string, data?: ResponseData): Response {
  return { id, success: true, data };
}

function fail(id: string, error: unknown): Response {
  const msg = error instanceof Error ? error.message : String(error);
  return { id, success: false, error: msg };
}

function handleCommand(request: Request): Response {
  try {
    switch (request.action) {
      case "network": {
        const sub = request.networkCommand ?? "requests";
        switch (sub) {
          case "requests": {
            const requests = state.getNetworkRequests(request.filter);
            // Note: withBody (fetching response bodies) requires a live
            // session command which we could implement, but for Phase 1 we
            // return what we have.
            return ok(request.id, { networkRequests: requests });
          }
          case "clear":
            state.clearNetwork();
            return ok(request.id, {});
          case "route":
            return ok(request.id, { routeCount: 0 });
          case "unroute":
            return ok(request.id, { routeCount: 0 });
          default:
            return fail(request.id, `Unknown network subcommand: ${sub}`);
        }
      }

      case "console": {
        const sub = request.consoleCommand ?? "get";
        switch (sub) {
          case "get":
            return ok(request.id, {
              consoleMessages: state.getConsoleMessages(request.filter),
            });
          case "clear":
            state.clearConsole();
            return ok(request.id, {});
          default:
            return fail(request.id, `Unknown console subcommand: ${sub}`);
        }
      }

      case "errors": {
        const sub = request.errorsCommand ?? "get";
        switch (sub) {
          case "get":
            return ok(request.id, {
              jsErrors: state.getJsErrors(request.filter),
            });
          case "clear":
            state.clearErrors();
            return ok(request.id, {});
          default:
            return fail(request.id, `Unknown errors subcommand: ${sub}`);
        }
      }

      case "trace": {
        const sub = request.traceCommand ?? "status";
        switch (sub) {
          case "start":
            state.traceRecording = true;
            state.traceEvents.length = 0;
            return ok(request.id, {
              traceStatus: { recording: true, eventCount: 0 } satisfies TraceStatus,
            });
          case "stop": {
            state.traceRecording = false;
            return ok(request.id, {
              traceEvents: [...state.traceEvents],
              traceStatus: {
                recording: false,
                eventCount: state.traceEvents.length,
              } satisfies TraceStatus,
            });
          }
          case "status":
            return ok(request.id, {
              traceStatus: {
                recording: state.traceRecording,
                eventCount: state.traceEvents.length,
              } satisfies TraceStatus,
            });
          default:
            return fail(request.id, `Unknown trace subcommand: ${sub}`);
        }
      }

      default:
        return fail(request.id, `Monitor does not handle action: ${request.action}`);
    }
  } catch (error) {
    return fail(request.id, error);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  resetIdleTimer();

  // Auth check
  const authHeader = req.headers.authorization ?? "";
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/status") {
    jsonResponse(res, 200, {
      running: true,
      cdpConnected: browserSocket !== null && browserSocket.readyState === WebSocket.OPEN,
      uptimeMs: Date.now() - startTime,
      counts: {
        network: state.networkRequests.size,
        console: state.consoleMessages.length,
        errors: state.jsErrors.length,
      },
    });
    return;
  }

  if (req.method === "POST" && url === "/command") {
    readBody(req)
      .then((body) => {
        const request = JSON.parse(body) as Request;
        const response = handleCommand(request);
        jsonResponse(res, 200, response);
      })
      .catch((err) => {
        jsonResponse(res, 400, { error: String(err) });
      });
    return;
  }

  if (req.method === "POST" && url === "/shutdown") {
    jsonResponse(res, 200, { ok: true });
    setTimeout(() => shutdown("shutdown requested"), 100);
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[cdp-monitor] ${msg}\n`);
}

async function writePidFiles(): Promise<void> {
  await mkdir(MONITOR_DIR, { recursive: true });
  await writeFile(PID_FILE, String(process.pid), { mode: 0o644 });
  await writeFile(PORT_FILE, String(MONITOR_PORT), { mode: 0o644 });
  await writeFile(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 });
}

async function cleanupPidFiles(): Promise<void> {
  await unlink(PID_FILE).catch(() => {});
  await unlink(PORT_FILE).catch(() => {});
  await unlink(TOKEN_FILE).catch(() => {});
}

let shuttingDown = false;

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down: ${reason}`);
  if (browserSocket) {
    try {
      browserSocket.close();
    } catch {}
  }
  if (httpServer) {
    httpServer.close();
  }
  cleanupPidFiles().finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

let httpServer: ReturnType<typeof createServer> | null = null;

async function main(): Promise<void> {
  try {
    await connectCdp();
  } catch (error) {
    log(`Failed to connect to CDP: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  httpServer = createServer(handleHttp);
  httpServer.listen(MONITOR_PORT, "127.0.0.1", async () => {
    log(`HTTP server listening on 127.0.0.1:${MONITOR_PORT}`);
    await writePidFiles();
    resetIdleTimer();
  });
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
