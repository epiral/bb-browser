import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request as DaemonRequest, Response as DaemonResponse } from "@bb-browser/shared";

const DAEMON_DIR = path.join(os.homedir(), ".bb-browser");
const DAEMON_JSON = path.join(DAEMON_DIR, "daemon.json");
const COMMAND_TIMEOUT = 30000;

export interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
}

let cachedInfo: DaemonInfo | null = null;
let daemonReady = false;

export function normalizeDaemonHost(host: string): string {
  return host === "localhost" ? "127.0.0.1" : host;
}

export function daemonBaseUrl(info: Pick<DaemonInfo, "host" | "port">): string {
  return `http://${normalizeDaemonHost(info.host)}:${info.port}`;
}

export function mergeDaemonHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  return {
    ...headers,
    Authorization: `Bearer ${token}`,
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpJson<T>(
  method: "GET" | "POST",
  urlPath: string,
  info: Pick<DaemonInfo, "host" | "port" | "token">,
  body?: unknown,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: normalizeDaemonHost(info.host),
        port: info.port,
        path: urlPath,
        method,
        headers: mergeDaemonHeaders(
          payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {},
          info.token,
        ),
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
            resolvePromise(JSON.parse(raw) as T);
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

export function getDaemonPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sameDirPath = resolve(currentDir, "daemon.js");
  if (existsSync(sameDirPath)) return sameDirPath;
  return resolve(currentDir, "../../daemon/dist/index.js");
}

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

export async function ensureDaemon(): Promise<void> {
  if (daemonReady && cachedInfo) {
    try {
      await httpJson<{ running?: boolean }>("GET", "/status", cachedInfo, undefined, 2000);
      return;
    } catch {
      daemonReady = false;
      cachedInfo = null;
    }
  }

  let info = await readDaemonJson();
  if (info) {
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
        cachedInfo = null;
      }
    }
  }

  const child = spawn(process.execPath, [getDaemonPath()], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    info = await readDaemonJson();
    if (!info) continue;
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (status.running) {
        cachedInfo = info;
        daemonReady = true;
        return;
      }
    } catch {}
  }

  throw new Error(
    "bb-browser: Daemon did not start in time.\n\nMake sure Chrome is installed, then try again.",
  );
}

export async function daemonCommand(request: DaemonRequest): Promise<DaemonResponse> {
  if (!cachedInfo) {
    cachedInfo = await readDaemonJson();
  }
  if (!cachedInfo) {
    throw new Error("No daemon.json found. Is the daemon running?");
  }
  return httpJson<DaemonResponse>("POST", "/command", cachedInfo, request, COMMAND_TIMEOUT);
}
