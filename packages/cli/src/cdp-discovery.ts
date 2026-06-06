import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANAGED_PORT_FILE, launchManagedBrowser } from "@bb-browser/shared";
import { parseOpenClawJson } from "./openclaw-json.js";

// Browser-launch helpers live in @bb-browser/shared so the daemon can reuse
// them. Re-export findBrowserExecutable to preserve this module's public API.
export { findBrowserExecutable } from "@bb-browser/shared";

const CDP_CACHE_FILE = path.join(os.tmpdir(), "bb-browser-cdp-cache.json");
const CACHE_TTL_MS = 30000; // 缓存有效期 30 秒

function execFileAsync(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function tryOpenClaw(): Promise<{ host: string; port: number } | null> {
  try {
    const raw = await execFileAsync("npx", ["openclaw", "browser", "status", "--json"], 30000);
    const parsed = parseOpenClawJson<{ cdpUrl?: string; cdpHost?: string; cdpPort?: number | string }>(raw);

    let result: { host: string; port: number } | null = null;

    // 优先使用完整的 cdpUrl
    if (parsed?.cdpUrl) {
      try {
        const url = new URL(parsed.cdpUrl);
        const port = Number(url.port);
        if (Number.isInteger(port) && port > 0) {
          result = { host: url.hostname, port };
        }
      } catch {
        // cdpUrl 解析失败，继续尝试其他字段
      }
    }

    // 其次使用 cdpHost + cdpPort
    if (!result) {
      const port = Number(parsed?.cdpPort);
      if (Number.isInteger(port) && port > 0) {
        const host = parsed?.cdpHost || "127.0.0.1";
        result = { host, port };
      }
    }

    // 成功后写入缓存
    if (result) {
      try {
        await writeFile(CDP_CACHE_FILE, JSON.stringify({ ...result, timestamp: Date.now() }), "utf8");
      } catch {}
    }

    return result;
  } catch {
  }
  return null;
}

async function canConnect(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

export async function isManagedBrowserRunning(): Promise<boolean> {
  try {
    const rawPort = await readFile(MANAGED_PORT_FILE, "utf8");
    const port = Number.parseInt(rawPort.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      return false;
    }
    return await canConnect("127.0.0.1", port);
  } catch {
    return false;
  }
}

export async function discoverCdpPort(): Promise<{ host: string; port: number } | null> {
  // 优先级1: 环境变量 BB_BROWSER_CDP_URL（最快，零延迟）
  const envUrl = process.env.BB_BROWSER_CDP_URL;
  if (envUrl) {
    try {
      const url = new URL(envUrl);
      const port = Number(url.port);
      if (Number.isInteger(port) && port > 0 && await canConnect(url.hostname, port)) {
        return { host: url.hostname, port };
      }
    } catch {}
  }

  // 优先级2: 命令行 --port
  const explicitPort = Number.parseInt(getArgValue("--port") ?? "", 10);
  if (Number.isInteger(explicitPort) && explicitPort > 0 && await canConnect("127.0.0.1", explicitPort)) {
    return { host: "127.0.0.1", port: explicitPort };
  }

  try {
    const rawPort = await readFile(MANAGED_PORT_FILE, "utf8");
    const managedPort = Number.parseInt(rawPort.trim(), 10);
    if (Number.isInteger(managedPort) && managedPort > 0 && await canConnect("127.0.0.1", managedPort)) {
      return { host: "127.0.0.1", port: managedPort };
    }
  } catch {
  }

  // 优先级3: 文件缓存（避免重复执行 npx openclaw）
  try {
    const cacheRaw = await readFile(CDP_CACHE_FILE, "utf8");
    const cache = JSON.parse(cacheRaw) as { host: string; port: number; timestamp: number };
    if (Date.now() - cache.timestamp < CACHE_TTL_MS && await canConnect(cache.host, cache.port)) {
      return { host: cache.host, port: cache.port };
    }
  } catch {}

  // 优先级4: OpenClaw
  if (process.argv.includes("--openclaw")) {
    const viaOpenClaw = await tryOpenClaw();
    if (viaOpenClaw && await canConnect(viaOpenClaw.host, viaOpenClaw.port)) {
      return viaOpenClaw;
    }
  }

  // 优先级5: 自动启动浏览器
  const launched = await launchManagedBrowser();
  if (launched) {
    return launched;
  }

  // 优先级6: 自动检测 OpenClaw（不带 --openclaw 参数时）
  if (!process.argv.includes("--openclaw")) {
    const detectedOpenClaw = await tryOpenClaw();
    if (detectedOpenClaw && await canConnect(detectedOpenClaw.host, detectedOpenClaw.port)) {
      return detectedOpenClaw;
    }
  }

  return null;
}
