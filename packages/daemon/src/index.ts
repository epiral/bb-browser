/**
 * bb-browser Daemon — CDP-direct backend
 *
 * Unified daemon that handles ALL browser commands (operations + observation)
 * via direct Chrome DevTools Protocol connection.
 *
 * Two-phase startup:
 *   1. HTTP server starts immediately (commands queue until CDP is ready)
 *   2. CDP connection established asynchronously
 */

import { parseArgs } from "node:util";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { DAEMON_PORT, DAEMON_HOST } from "@bb-browser/shared";
import { HttpServer } from "./http-server.js";
import { CdpConnection } from "./cdp-connection.js";
import { TabStateManager } from "./tab-state.js";
import { HubBridge } from "./hub-bridge.js";
import { createChromeManager } from "./chrome.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAEMON_DIR = process.env.BB_BROWSER_HOME || path.join(os.homedir(), ".bb-browser");
const DAEMON_JSON = path.join(DAEMON_DIR, "daemon.json");
const DEFAULT_CDP_PORT = 9222;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface DaemonOptions {
  host: string;
  port: number;
  cdpHost: string;
  cdpPort: number;
  token: string;
  hubUrl?: string;
  hubToken?: string;
  noChrome: boolean;
}

function parseOptions(): DaemonOptions {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      host: {
        type: "string",
        short: "H",
        default: DAEMON_HOST,
      },
      port: {
        type: "string",
        short: "p",
        default: String(DAEMON_PORT),
      },
      "cdp-host": {
        type: "string",
        default: "127.0.0.1",
      },
      "cdp-port": {
        type: "string",
        default: String(DEFAULT_CDP_PORT),
      },
      token: {
        type: "string",
        default: "",
      },
      hub: {
        type: "string",
        default: "",
      },
      "hub-token": {
        type: "string",
        default: "",
      },
      "no-chrome": {
        type: "boolean",
        default: false,
      },
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
    },
  });

  if (values.help) {
    console.error(`
bb-browser-daemon — CDP-direct backend for bb-browser

Usage:
  bb-browser-daemon [options]

Options:
  -H, --host <host>          HTTP server host (default: ${DAEMON_HOST})
  -p, --port <port>          HTTP server port (default: ${DAEMON_PORT})
      --cdp-host <host>      Chrome CDP host (default: 127.0.0.1)
      --cdp-port <port>      Chrome CDP port (default: ${DEFAULT_CDP_PORT})
      --token <token>        Bearer auth token (auto-generated if empty)
      --hub <url>            Pinix Hub gRPC URL (enables Hub mode)
      --hub-token <token>    Pinix Hub auth token
      --no-chrome            Skip auto Chrome management (use external Chrome)
  -h, --help                 Show this help message

Endpoints:
  POST /command      Send command and get result (via CDP)
  GET  /status       Daemon health + per-tab stats
  POST /shutdown     Graceful shutdown

Hub mode:
  When --hub is set, the daemon connects to Pinix Hub as an Edge Clip
  provider, registering browser and site commands. Invokes are handled
  directly via CDP without HTTP round-trips.
`);
    process.exit(0);
  }

  // Auto-generate token if not provided
  let token = values.token ?? "";
  if (!token) {
    token = randomBytes(16).toString("hex");
  }

  // Normalize hub URL if provided
  let hubUrl = values.hub?.trim() || undefined;
  if (hubUrl) {
    hubUrl = hubUrl
      .replace(/^ws:\/\//i, "http://")
      .replace(/^wss:\/\//i, "https://");
    const url = new URL(hubUrl);
    if (url.pathname === "/ws/provider" || url.pathname === "/ws/capability") url.pathname = "";
    url.search = ""; url.hash = "";
    hubUrl = url.toString().replace(/\/$/, "");
  }

  return {
    host: values.host ?? DAEMON_HOST,
    port: parseInt(values.port ?? String(DAEMON_PORT), 10),
    cdpHost: values["cdp-host"] ?? "127.0.0.1",
    cdpPort: parseInt(values["cdp-port"] ?? String(DEFAULT_CDP_PORT), 10),
    token,
    hubUrl,
    hubToken: values["hub-token"]?.trim() || undefined,
    noChrome: values["no-chrome"] ?? false,
  };
}

// ---------------------------------------------------------------------------
// daemon.json management
// ---------------------------------------------------------------------------

interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
  cdpHost: string;
  cdpPort: number;
}

function writeDaemonJson(info: DaemonInfo): void {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true });
    writeFileSync(DAEMON_JSON, JSON.stringify(info), { mode: 0o600 });
  } catch {}
}

function cleanupDaemonJson(): void {
  if (existsSync(DAEMON_JSON)) {
    try {
      unlinkSync(DAEMON_JSON);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// CDP port discovery (simplified — daemon is told the port)
// ---------------------------------------------------------------------------

async function discoverCdpPort(host: string, port: number): Promise<{ host: string; port: number }> {
  // Try connecting to the specified port first
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`http://${host}:${port}/json/version`, {
        signal: controller.signal,
      });
      if (response.ok) {
        return { host, port };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {}

  // Try reading managed browser port file
  const managedPortFile = path.join(DAEMON_DIR, "browser", "cdp-port");
  try {
    const rawPort = readFileSync(managedPortFile, "utf8").trim();
    const managedPort = parseInt(rawPort, 10);
    if (Number.isInteger(managedPort) && managedPort > 0) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const response = await fetch(`http://127.0.0.1:${managedPort}/json/version`, {
            signal: controller.signal,
          });
          if (response.ok) {
            return { host: "127.0.0.1", port: managedPort };
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {}
    }
  } catch {}

  throw new Error(
    `Cannot connect to Chrome CDP at ${host}:${port}. ` +
    `Make sure Chrome is running with --remote-debugging-port=${port}`,
  );
}

// ---------------------------------------------------------------------------
// Stale daemon cleanup
// ---------------------------------------------------------------------------

function readStaleDaemonJson(): DaemonInfo | null {
  try {
    const raw = readFileSync(DAEMON_JSON, "utf8");
    const info = JSON.parse(raw) as DaemonInfo;
    if (typeof info.pid === "number" && typeof info.host === "string" && typeof info.port === "number" && typeof info.token === "string") {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shut down any existing stale daemon before we start.
 * If daemon.json exists and the PID is alive (and it's not us), ask it to
 * shut down via HTTP, then wait for it to exit. Force-kill as last resort.
 */
async function cleanupStaleDaemon(): Promise<void> {
  const info = readStaleDaemonJson();
  if (!info) return;

  // If the PID is us, ignore (shouldn't happen, but be safe)
  if (info.pid === process.pid) return;

  // If the process is dead, just clean up the stale file
  if (!isProcessAlive(info.pid)) {
    cleanupDaemonJson();
    return;
  }

  console.error(`[Daemon] Found stale daemon (pid ${info.pid}), requesting shutdown...`);

  // Try graceful shutdown via HTTP POST /shutdown
  try {
    await new Promise<void>((resolve, _reject) => {
      const req = httpRequest(
        {
          hostname: info.host,
          port: info.port,
          path: "/shutdown",
          method: "POST",
          headers: { Authorization: `Bearer ${info.token}` },
          timeout: 3000,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", () => resolve()); // Ignore errors, we'll force-kill if needed
      req.on("timeout", () => { req.destroy(); resolve(); });
      req.end();
    });
  } catch {}

  // Wait for old daemon to exit (up to 5 seconds)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(info.pid)) {
      cleanupDaemonJson();
      console.error("[Daemon] Old daemon exited cleanly");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Force kill
  console.error(`[Daemon] Force-killing stale daemon (pid ${info.pid})`);
  try {
    process.kill(info.pid, "SIGKILL");
  } catch {}
  cleanupDaemonJson();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions();

  // Clean up any stale daemon before starting
  await cleanupStaleDaemon();

  // Prefer an already-available CDP endpoint (explicit port or managed port
  // file). Only launch Chrome if nothing is reachable.
  let chromeProcess: ChildProcess | null = null;
  let cdpEndpoint: { host: string; port: number } | null = null;

  try {
    cdpEndpoint = await discoverCdpPort(options.cdpHost, options.cdpPort);
  } catch {}

  // Auto-manage Chrome headless-shell (unless --no-chrome)
  if (!cdpEndpoint && !options.noChrome) {
    const chrome = createChromeManager();

    // Ensure headless-shell binary is available (download if needed)
    try {
      await chrome.ensureBinary();
    } catch (error) {
      console.error(`[Daemon] Failed to get headless-shell: ${error instanceof Error ? error.message : String(error)}`);
      console.error("[Daemon] Falling back to external Chrome. Use --no-chrome to suppress this.");
    }

    // Check if Chrome is already running on the target port
    let chromeAlreadyRunning = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const resp = await fetch(`http://${options.cdpHost}:${options.cdpPort}/json/version`, { signal: controller.signal });
        chromeAlreadyRunning = resp.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {}

    if (!chromeAlreadyRunning) {
      try {
        chromeProcess = chrome.launch(options.cdpPort);
        await chrome.waitForCdp(options.cdpHost, options.cdpPort);
        cdpEndpoint = { host: options.cdpHost, port: options.cdpPort };
      } catch (error) {
        console.error(`[Daemon] Failed to launch Chrome: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.error(`[Daemon] Chrome already running on port ${options.cdpPort}`);
      cdpEndpoint = { host: options.cdpHost, port: options.cdpPort };
    }
  }

  // Create tab state manager and CDP connection
  const tabManager = new TabStateManager();

  if (!cdpEndpoint) {
    console.error(
      `[Daemon] Cannot connect to Chrome CDP at ${options.cdpHost}:${options.cdpPort}. ` +
      `Make sure Chrome is running with --remote-debugging-port=${options.cdpPort}`,
    );
    process.exit(1);
  }

  const cdp = new CdpConnection(cdpEndpoint.host, cdpEndpoint.port, tabManager);

  // Hub bridge (created after CDP, started after CDP connects)
  let hubBridge: HubBridge | null = null;

  // Graceful shutdown handler (guarded against double-call)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[Daemon] Shutting down...");
    if (hubBridge) {
      hubBridge.stop();
      hubBridge = null;
    }
    cdp.disconnect();
    await httpServer.stop();
    // Kill managed Chrome process
    if (chromeProcess && !chromeProcess.killed) {
      console.error("[Daemon] Stopping managed Chrome");
      chromeProcess.kill("SIGTERM");
    }
    cleanupDaemonJson();
    process.exit(0);
  };

  // Phase 1: Start HTTP server immediately
  const httpServer = new HttpServer({
    host: options.host,
    port: options.port,
    token: options.token,
    cdp,
    cdpHost: cdpEndpoint.host,
    cdpPort: cdpEndpoint.port,
    onShutdown: shutdown,
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await httpServer.start();
  writeDaemonJson({
    pid: process.pid,
    host: options.host,
    port: options.port,
    token: options.token,
    cdpHost: cdpEndpoint.host,
    cdpPort: cdpEndpoint.port,
  });

  console.error(
    `[Daemon] HTTP server listening on http://${options.host}:${options.port}`,
  );
  console.error(`[Daemon] Auth token: ${options.token}`);

  // Phase 2: Connect to CDP asynchronously
  console.error(
    `[Daemon] Connecting to Chrome CDP at ${cdpEndpoint.host}:${cdpEndpoint.port}...`,
  );

  try {
    await cdp.connect();
    const tabCount = tabManager.tabCount;
    console.error(
      `[Daemon] CDP connected, monitoring ${tabCount} tab(s)`,
    );
  } catch (error) {
    console.error(
      `[Daemon] Failed to connect to CDP: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("[Daemon] HTTP server is running, but commands will fail until CDP connects.");
  }

  // Phase 3: Start Hub bridge if --hub is set
  if (options.hubUrl) {
    hubBridge = new HubBridge({
      hubUrl: options.hubUrl,
      hubToken: options.hubToken,
      cdp,
      cdpPort: cdpEndpoint.port,
    });
    console.error(`[Daemon] Starting Hub bridge to ${options.hubUrl}`);
    hubBridge.start();
  }
}

main().catch((error) => {
  console.error("[Daemon] Fatal error:", error);
  cleanupDaemonJson();
  process.exit(1);
});
