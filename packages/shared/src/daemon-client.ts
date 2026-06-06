/**
 * Shared daemon HTTP client utilities.
 *
 * Used by CLI (daemon-manager), MCP server, and Edge Clip provider
 * to communicate with the bb-browser daemon process.
 */

import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir, release } from "node:os";
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
      info.host = await resolveDaemonHost(info.host);
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WSL → Windows host resolution
//
// The daemon is owned by the Windows tray and binds the wildcard address, but
// advertises loopback in daemon.json. An agent running *inside WSL2* can't
// reach Windows' 127.0.0.1 — WSL2 is a separate (Hyper-V NAT) network
// namespace. The Windows host is reachable at the default gateway instead.
// We rewrite loopback → that gateway IP so every WSL agent connects to the one
// Windows daemon with zero per-agent configuration.
// ---------------------------------------------------------------------------

/** Cached Windows host IP. `undefined` = not resolved yet; `null` = no WSL/gw. */
let cachedWindowsHostIp: string | null | undefined;

export function isWsl(): boolean {
  return process.platform === "linux" && /microsoft|wsl/i.test(release());
}

/**
 * Parse the default-route gateway from the contents of `/proc/net/route`.
 * The gateway is stored as little-endian hex, e.g. `0100A8C0` → `192.168.0.1`.
 */
export function parseDefaultGatewayHex(routeContent: string): string | null {
  for (const line of routeContent.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    // Columns: Iface Destination Gateway Flags RefCnt Use Metric Mask ...
    if (f.length > 2 && f[1] === "00000000" && f[2] !== "00000000") {
      const hex = f[2];
      if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
      return [
        parseInt(hex.slice(6, 8), 16),
        parseInt(hex.slice(4, 6), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(0, 2), 16),
      ].join(".");
    }
  }
  return null;
}

/** Parse the first `nameserver` IP out of `/etc/resolv.conf` contents. */
export function parseNameserver(resolvContent: string): string | null {
  const m = resolvContent.match(/^\s*nameserver\s+(\d+\.\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

async function getWindowsHostIp(): Promise<string | null> {
  if (cachedWindowsHostIp !== undefined) return cachedWindowsHostIp;
  let ip: string | null = null;
  // Primary: default gateway = the Windows host under WSL2 NAT.
  try {
    ip = parseDefaultGatewayHex(await readFile("/proc/net/route", "utf8"));
  } catch {}
  // Fallback: auto-generated resolv.conf points nameserver at the Windows host.
  if (!ip) {
    try {
      ip = parseNameserver(await readFile("/etc/resolv.conf", "utf8"));
    } catch {}
  }
  cachedWindowsHostIp = ip;
  return ip;
}

async function resolveDaemonHost(host: string): Promise<string> {
  // Explicit override wins — the deterministic escape hatch for when the
  // daemon isn't on loopback (e.g. a WSL agent pointing at the Windows daemon,
  // or auto-detection picking the wrong gateway). Port + token still come from
  // daemon.json, so token rotation on daemon restart is handled transparently.
  const override = process.env.BB_DAEMON_HOST;
  if (override) return override;
  // Default: on WSL, rewrite advertised loopback → the Windows host IP, since
  // WSL2's loopback is a separate network namespace from Windows.
  if (!isWsl()) return host;
  if (host !== "127.0.0.1" && host !== "localhost") return host;
  return (await getWindowsHostIp()) ?? host;
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
