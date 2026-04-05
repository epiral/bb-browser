/**
 * Shared daemon HTTP client utilities.
 *
 * Used by CLI (daemon-manager), MCP server, and Edge Clip provider
 * to communicate with the bb-browser daemon process.
 */

import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DAEMON_DIR = process.env.BB_BROWSER_HOME || join(homedir(), ".bb-browser");
export const DAEMON_JSON = join(DAEMON_DIR, "daemon.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
}

// ---------------------------------------------------------------------------
// daemon.json
// ---------------------------------------------------------------------------

export async function readDaemonJson(): Promise<DaemonInfo | null> {
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

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export function httpJson<T>(
  method: "GET" | "POST",
  urlPath: string,
  info: { host: string; port: number; token: string },
  body?: unknown,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolveP, reject) => {
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
            resolveP(JSON.parse(raw) as T);
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
