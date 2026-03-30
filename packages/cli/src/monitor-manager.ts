/**
 * monitor-manager — CLI-side lifecycle management for the CDP monitor
 * background process.
 *
 * Provides helpers to start / stop / query the monitor and to forward
 * monitoring commands (network, console, errors, trace) to it.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "@bb-browser/shared";
import { discoverCdpPort } from "./cdp-discovery.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MONITOR_DIR = path.join(os.homedir(), ".bb-browser");
const PID_FILE = path.join(MONITOR_DIR, "monitor.pid");
const PORT_FILE = path.join(MONITOR_DIR, "monitor.port");
const TOKEN_FILE = path.join(MONITOR_DIR, "monitor.token");

const DEFAULT_MONITOR_PORT = 19826;

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

function httpJson<T>(
  method: "GET" | "POST",
  url: string,
  token: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Monitor HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error(`Invalid JSON from monitor: ${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Monitor request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function readPortFile(): Promise<number | null> {
  try {
    const raw = await readFile(PORT_FILE, "utf8");
    const port = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function readTokenFile(): Promise<string | null> {
  try {
    return (await readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function isMonitorRunning(): Promise<boolean> {
  const port = await readPortFile();
  const token = await readTokenFile();
  if (!port || !token) return false;
  try {
    const result = await httpJson<{ running?: boolean }>(
      "GET",
      `http://127.0.0.1:${port}/status`,
      token,
    );
    return result.running === true;
  } catch {
    return false;
  }
}

export async function ensureMonitorRunning(): Promise<{ port: number; token: string }> {
  // Check if already running
  const existingPort = await readPortFile();
  const existingToken = await readTokenFile();
  if (existingPort && existingToken) {
    try {
      const status = await httpJson<{ running?: boolean }>(
        "GET",
        `http://127.0.0.1:${existingPort}/status`,
        existingToken,
      );
      if (status.running) {
        return { port: existingPort, token: existingToken };
      }
    } catch {
      // Not running — fall through to spawn
    }
  }

  // Discover CDP port
  const cdp = await discoverCdpPort();
  if (!cdp) {
    throw new Error("Cannot start monitor: no browser connection found");
  }

  const token = randomBytes(32).toString("hex");
  const monitorPort = DEFAULT_MONITOR_PORT;

  // Locate the monitor script
  const monitorScript = findMonitorScript();

  await mkdir(MONITOR_DIR, { recursive: true });
  // Pre-write token so the CLI can read it immediately after spawn
  await writeFile(TOKEN_FILE, token, { mode: 0o600 });

  const child = spawn(process.execPath, [
    monitorScript,
    "--cdp-host", cdp.host,
    "--cdp-port", String(cdp.port),
    "--monitor-port", String(monitorPort),
    "--token", token,
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for the monitor to become healthy (up to 5 seconds)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const status = await httpJson<{ running?: boolean }>(
        "GET",
        `http://127.0.0.1:${monitorPort}/status`,
        token,
      );
      if (status.running) {
        return { port: monitorPort, token };
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error("Monitor process did not start in time");
}

export async function stopMonitor(): Promise<void> {
  const port = await readPortFile();
  const token = await readTokenFile();
  if (!port || !token) return;
  try {
    await httpJson("POST", `http://127.0.0.1:${port}/shutdown`, token);
  } catch {
    // Already stopped or unreachable — clean up files
  }
  await unlink(PID_FILE).catch(() => {});
  await unlink(PORT_FILE).catch(() => {});
  await unlink(TOKEN_FILE).catch(() => {});
}

export async function monitorCommand(request: Request): Promise<Response> {
  const { port, token } = await ensureMonitorRunning();
  return httpJson<Response>(
    "POST",
    `http://127.0.0.1:${port}/command`,
    token,
    request,
  );
}

// ---------------------------------------------------------------------------
// Locate the built cdp-monitor script
// ---------------------------------------------------------------------------

function findMonitorScript(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const candidates = [
    // Built output (tsup puts it next to cli.js)
    resolve(currentDir, "cdp-monitor.js"),
    // Development: packages/cli/src -> packages/cli/dist
    resolve(currentDir, "../dist/cdp-monitor.js"),
    // Monorepo root dist
    resolve(currentDir, "../../dist/cdp-monitor.js"),
    resolve(currentDir, "../../../dist/cdp-monitor.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Fall back to the first candidate (will fail at spawn with a clear error)
  return candidates[0];
}
