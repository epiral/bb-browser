/**
 * Daemon manager - spawn, health-check, and communicate with the daemon process
 */

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "@bb-browser/shared";
import { COMMAND_TIMEOUT } from "@bb-browser/shared";

// ---------------------------------------------------------------------------
// Paths & types
// ---------------------------------------------------------------------------

const DAEMON_DIR = path.join(os.homedir(), ".bb-browser");
const DAEMON_JSON = path.join(DAEMON_DIR, "daemon.json");

interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
}

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedInfo: DaemonInfo | null = null;
let daemonReady = false;

// ---------------------------------------------------------------------------
// PID liveness check
// ---------------------------------------------------------------------------

/**
 * Check whether a process with the given PID is alive.
 * Uses signal 0 which doesn't actually send a signal — it just checks existence.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

function httpJson<T>(
  method: "GET" | "POST",
  urlPath: string,
  info: { host: string; port: number; token: string },
  body?: unknown,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: info.host,
        port: info.port,
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${info.token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Daemon HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error(`Invalid JSON from daemon: ${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Daemon request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// daemon.json
// ---------------------------------------------------------------------------

async function readDaemonJson(): Promise<DaemonInfo | null> {
  try {
    const raw = await readFile(DAEMON_JSON, "utf8");
    const info = JSON.parse(raw) as DaemonInfo;
    if (
      typeof info.pid === "number" &&
      typeof info.host === "string" &&
      typeof info.port === "number" &&
      typeof info.token === "string"
    ) {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

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
    // Quick re-check: is it still alive?
    try {
      await httpJson<{ running: boolean }>("GET", "/status", cachedInfo, undefined, 2000);
      return;
    } catch {
      daemonReady = false;
      cachedInfo = null;
    }
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
        const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
        if (status.running) {
          cachedInfo = info;
          daemonReady = true;
          return;
        }
      } catch {
        // Daemon process exists but HTTP not responding — fall through to spawn
      }
    }
  }

  // Spawn daemon process
  const daemonPath = getDaemonPath();
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for daemon to become healthy (up to 5 seconds)
  const deadline = Date.now() + 5000;
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
    "bb-browser: Daemon did not start in time.\n\nMake sure Chrome is installed, then try again.",
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
