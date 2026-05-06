/**
 * Daemon manager - spawn, health-check, and communicate with the daemon process
 */

import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Request, Response } from "@bb-browser/shared";
import {
  COMMAND_TIMEOUT,
  DAEMON_JSON,
  type DaemonInfo,
  readDaemonJson,
  isProcessAlive,
  httpJson,
} from "@bb-browser/shared";
import { discoverCdpPort } from "./cdp-discovery.js";

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedInfo: DaemonInfo | null = null;
let daemonReady = false;

// ---------------------------------------------------------------------------
// daemon.json helpers
// ---------------------------------------------------------------------------

async function deleteDaemonJson(): Promise<void> {
  try {
    await unlink(DAEMON_JSON);
  } catch {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getDaemonPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const sameDirPath = resolve(currentDir, "daemon.js");
  if (existsSync(sameDirPath)) {
    return sameDirPath;
  }
  return resolve(currentDir, "../../daemon/dist/index.js");
}

/**
 * Ensure the daemon is running and ready to accept commands.
 * - Reads ~/.bb-browser/daemon.json for pid, host, port, token
 * - Checks if pid is alive via signal 0
 * - If pid dead, deletes stale daemon.json and spawns new daemon
 * - Checks health via GET /status
 * - If not running, spawns daemon process (detached) and waits for health
 */
export async function ensureDaemon(): Promise<void> {
  if (daemonReady && cachedInfo) {
    // Quick re-check: is it still alive and CDP connected?
    try {
      const status = await httpJson<{ running?: boolean; cdpConnected?: boolean }>("GET", "/status", cachedInfo, undefined, 2000);
      if (status.running && status.cdpConnected !== false) {
        return;
      }
    } catch {}
    daemonReady = false;
    cachedInfo = null;
  }

  // Try reading existing daemon.json and checking if daemon is alive
  let info = await readDaemonJson();
  if (info) {
    // PID liveness check — detect stale daemon.json from crashed daemon
    if (!isProcessAlive(info.pid)) {
      await deleteDaemonJson();
      info = null;
    } else {
      try {
        const status = await httpJson<{ running?: boolean; cdpConnected?: boolean }>("GET", "/status", info, undefined, 2000);
        if (status.running && status.cdpConnected !== false) {
          cachedInfo = info;
          daemonReady = true;
          return;
        }
        if (status.running && status.cdpConnected === false) {
          await stopDaemon();
          await deleteDaemonJson();
          info = null;
        }
      } catch {
        // Daemon process exists but HTTP not responding — fall through to spawn
      }
    }
  }

  // Discover CDP port (auto-launches Chrome if needed)
  const cdpInfo = await discoverCdpPort();
  if (!cdpInfo) {
    throw new Error(
      "bb-browser: Cannot find a Chromium-based browser.\n\n" +
      "Please do one of the following:\n" +
      "  1. Install Google Chrome, Edge, or Brave\n" +
      "  2. Start Chrome with: google-chrome --remote-debugging-port=19825\n" +
      "  3. Set BB_BROWSER_CDP_URL=http://host:port",
    );
  }

  // Spawn daemon process with discovered CDP endpoint
  const daemonPath = getDaemonPath();
  const child = spawn(process.execPath, [daemonPath, "--cdp-host", cdpInfo.host, "--cdp-port", String(cdpInfo.port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for daemon to become healthy (up to 10 seconds — includes Chrome launch time)
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    // Re-read daemon.json each iteration (daemon writes it on startup)
    info = await readDaemonJson();
    if (!info) continue;
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (status.running) {
        cachedInfo = info;
        daemonReady = true;
        return;
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error(
    "bb-browser: Daemon did not start in time.\n\n" +
    "Chrome CDP is reachable, but the daemon process failed to initialize.\n" +
    "Try: bb-browser daemon status",
  );
}

/**
 * Send a command to the daemon via POST /command.
 */
export async function daemonCommand(request: Request): Promise<Response> {
  if (!cachedInfo) {
    cachedInfo = await readDaemonJson();
  }
  if (!cachedInfo) {
    throw new Error("No daemon.json found. Is the daemon running?");
  }
  return httpJson<Response>("POST", "/command", cachedInfo, request, COMMAND_TIMEOUT);
}

/**
 * Stop the daemon via POST /shutdown.
 */
export async function stopDaemon(): Promise<boolean> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) return false;
  try {
    await httpJson("POST", "/shutdown", info);
    daemonReady = false;
    cachedInfo = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is running by querying GET /status.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) return false;
  try {
    const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
    return status.running === true;
  } catch {
    return false;
  }
}

/**
 * Get full daemon status (for the status command).
 */
export async function getDaemonStatus(): Promise<Record<string, unknown> | null> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) return null;
  try {
    return await httpJson<Record<string, unknown>>("GET", "/status", info, undefined, 2000);
  } catch {
    return null;
  }
}

/**
 * Legacy alias for backward compatibility.
 * Commands that import ensureDaemonRunning will continue to work.
 */
export const ensureDaemonRunning = ensureDaemon;
