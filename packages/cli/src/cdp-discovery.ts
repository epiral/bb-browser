import { execFile, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseOpenClawJson } from "./openclaw-json.js";

const DEFAULT_CDP_PORT = 19825;
const MANAGED_BROWSER_DIR = path.join(os.homedir(), ".bb-browser", "browser");
const MANAGED_USER_DATA_DIR = path.join(MANAGED_BROWSER_DIR, "user-data");
const MANAGED_PORT_FILE = path.join(MANAGED_BROWSER_DIR, "cdp-port");
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

export function findBrowserExecutable(): string | null {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Arc.app/Contents/MacOS/Arc",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  if (process.platform === "linux") {
    const candidates = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
    for (const candidate of candidates) {
      try {
        const resolved = execSync(`which ${candidate}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (resolved) {
          return resolved;
        }
      } catch {
      }
    }
    return null;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ...(localAppData ? [
        `${localAppData}\\Google\\Chrome Dev\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome SxS\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome Beta\\Application\\chrome.exe`,
      ] : []),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  return null;
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

export async function launchManagedBrowser(port: number = DEFAULT_CDP_PORT): Promise<{ host: string; port: number } | null> {
  const executable = findBrowserExecutable();
  if (!executable) {
    return null;
  }

  await mkdir(MANAGED_USER_DATA_DIR, { recursive: true });

  // Set profile name so the Chrome window shows "bb-browser" in the title bar
  const defaultProfileDir = path.join(MANAGED_USER_DATA_DIR, "Default");
  const prefsPath = path.join(defaultProfileDir, "Preferences");
  await mkdir(defaultProfileDir, { recursive: true });
  try {
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(await readFile(prefsPath, "utf8")); } catch {}
    if (!(prefs.profile as Record<string, unknown>)?.name || (prefs.profile as Record<string, unknown>).name !== "bb-browser") {
      prefs.profile = { ...(prefs.profile as Record<string, unknown> || {}), name: "bb-browser" };
      await writeFile(prefsPath, JSON.stringify(prefs), "utf8");
    }
  } catch {}

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${MANAGED_USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "about:blank",
  ];

  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    return null;
  }

  await mkdir(MANAGED_BROWSER_DIR, { recursive: true });
  await writeFile(MANAGED_PORT_FILE, String(port), "utf8");

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await canConnect("127.0.0.1", port)) {
      return { host: "127.0.0.1", port };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
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
