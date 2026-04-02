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
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DAEMON_PORT, DAEMON_HOST } from "@bb-browser/shared";
import { HttpServer } from "./http-server.js";
import { CdpConnection } from "./cdp-connection.js";
import { TabStateManager } from "./tab-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAEMON_DIR = path.join(os.homedir(), ".bb-browser");
const DAEMON_JSON = path.join(DAEMON_DIR, "daemon.json");
const DEFAULT_CDP_PORT = 19825;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface DaemonOptions {
  host: string;
  port: number;
  cdpHost: string;
  cdpPort: number;
  token: string;
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
  -h, --help                 Show this help message

Endpoints:
  POST /command      Send command and get result (via CDP)
  GET  /status       Daemon health + per-tab stats
  POST /shutdown     Graceful shutdown
`);
    process.exit(0);
  }

  // Auto-generate token if not provided
  let token = values.token ?? "";
  if (!token) {
    token = randomBytes(16).toString("hex");
  }

  return {
    host: values.host ?? DAEMON_HOST,
    port: parseInt(values.port ?? String(DAEMON_PORT), 10),
    cdpHost: values["cdp-host"] ?? "127.0.0.1",
    cdpPort: parseInt(values["cdp-port"] ?? String(DEFAULT_CDP_PORT), 10),
    token,
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
  const managedPortFile = path.join(os.homedir(), ".bb-browser", "browser", "cdp-port");
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions();

  // Create tab state manager and CDP connection
  const tabManager = new TabStateManager();
  let cdpEndpoint: { host: string; port: number };

  try {
    cdpEndpoint = await discoverCdpPort(options.cdpHost, options.cdpPort);
  } catch (error) {
    console.error(
      `[Daemon] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const cdp = new CdpConnection(cdpEndpoint.host, cdpEndpoint.port, tabManager);

  // Graceful shutdown handler (guarded against double-call)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[Daemon] Shutting down...");
    cdp.disconnect();
    await httpServer.stop();
    cleanupDaemonJson();
    process.exit(0);
  };

  // Phase 1: Start HTTP server immediately
  const httpServer = new HttpServer({
    host: options.host,
    port: options.port,
    token: options.token,
    cdp,
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
}

main().catch((error) => {
  console.error("[Daemon] Fatal error:", error);
  cleanupDaemonJson();
  process.exit(1);
});
