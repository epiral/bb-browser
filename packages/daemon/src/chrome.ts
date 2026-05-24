/**
 * Chrome manager.
 *
 * Priority order for finding a Chrome binary:
 *   1. System-installed Chrome (Google Chrome, Chromium, Edge, Brave)
 *   2. Previously downloaded Chrome for Testing (full browser)
 *   3. Auto-download Chrome for Testing if nothing found
 *
 * Full Chrome (with --headless=new) is strongly preferred over
 * chrome-headless-shell because headless-shell lacks many browser APIs
 * (Bluetooth, USB, SharedWorker, etc.) that anti-bot systems check.
 *
 * Storage layout:
 *   ~/.bb-browser/
 *     browser/
 *       version          # e.g. "149.0.7827.22"
 *       cdp-port         # written after launch, e.g. "9222"
 *       chrome-<platform>/
 *         chrome | Google Chrome for Testing   # the binary
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, renameSync, readdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BROWSER_DIR = path.join(
  process.env.BB_BROWSER_HOME || path.join(os.homedir(), ".bb-browser"),
  "browser",
);

const CHROME_VERSION = "149.0.7827.22";

// Download sources — try Google CDN first, fallback to COS mirror.
const CHROME_CDN_BASE = "https://storage.googleapis.com/chrome-for-testing-public";
const CHROME_COS_BASE = "https://pinix-blobs-1251447449.cos.ap-beijing.myqcloud.com/releases/chrome";

const LOG_PREFIX = "[Chrome]";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type Platform = "linux64" | "linux-arm64" | "mac-arm64" | "mac-x64";

function detectPlatform(): Platform | null {
  const arch = os.arch(); // arm64, x64
  const plat = os.platform(); // darwin, linux

  if (plat === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (plat === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux64";
  }
  return null;
}

// ---------------------------------------------------------------------------
// System Chrome detection
// ---------------------------------------------------------------------------

const SYSTEM_CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ],
};

function findSystemChrome(): string | null {
  const candidates = SYSTEM_CHROME_PATHS[os.platform()] ?? [];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Also check PATH
  try {
    const which = os.platform() === "darwin"
      ? "which 'Google Chrome' 2>/dev/null || true"
      : "which google-chrome 2>/dev/null || which chromium 2>/dev/null || which chromium-browser 2>/dev/null || true";
    const result = execSync(which, { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (result && existsSync(result)) return result;
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Managed Chrome for Testing paths
// ---------------------------------------------------------------------------

/** Binary name inside the Chrome for Testing zip. */
function chromeBinaryName(platform: Platform): string {
  if (platform.startsWith("mac")) {
    return "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  }
  return "chrome";
}

function chromeDir(platform: Platform): string {
  return path.join(BROWSER_DIR, `chrome-${platform}`);
}

function chromePath(platform: Platform): string {
  return path.join(chromeDir(platform), chromeBinaryName(platform));
}

// ---------------------------------------------------------------------------
// Version management
// ---------------------------------------------------------------------------

function installedVersion(): string | null {
  try {
    return readFileSync(path.join(BROWSER_DIR, "version"), "utf8").trim();
  } catch {
    return null;
  }
}

function saveVersion(version: string): void {
  mkdirSync(BROWSER_DIR, { recursive: true });
  writeFileSync(path.join(BROWSER_DIR, "version"), version);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function getDownloadUrls(platform: Platform): string[] {
  // Chrome for Testing zip name format
  const zipName = `chrome-${platform}.zip`;
  return [
    `${CHROME_CDN_BASE}/${CHROME_VERSION}/${platform}/${zipName}`,
    `${CHROME_COS_BASE}/${zipName}`,
  ];
}

async function tryFetch(url: string): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (resp.ok && resp.body) return resp;
    } finally {
      clearTimeout(timer);
    }
  } catch {}
  return null;
}

async function downloadAndExtractChrome(platform: Platform): Promise<string> {
  const zipPath = path.join(BROWSER_DIR, `chrome-${platform}.zip`);
  const targetDir = chromeDir(platform);

  // Clean up previous
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(BROWSER_DIR, { recursive: true });

  // Try download sources in order
  const urls = getDownloadUrls(platform);
  let resp: Response | null = null;

  for (const url of urls) {
    console.error(`${LOG_PREFIX} Downloading Chrome ${CHROME_VERSION} (${platform}) from ${new URL(url).host}...`);
    resp = await tryFetch(url);
    if (resp) {
      break;
    }
    console.error(`${LOG_PREFIX} Download failed, trying next source...`);
  }

  if (!resp) {
    throw new Error(`Failed to download Chrome from any source`);
  }

  // Save zip to disk
  const fileStream = createWriteStream(zipPath);
  // @ts-expect-error ReadableStream vs NodeJS.ReadableStream
  await pipeline(resp.body, fileStream);

  // Extract
  const extractDir = targetDir + ".extract";
  if (existsSync(extractDir)) {
    rmSync(extractDir, { recursive: true, force: true });
  }
  mkdirSync(extractDir, { recursive: true });

  console.error(`${LOG_PREFIX} Extracting...`);
  try {
    execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
  } catch (error) {
    throw new Error(`Failed to extract zip: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(zipPath, { force: true });

  // Find the chrome binary inside extracted contents
  const binary = findBinaryRecursive(extractDir, "Google Chrome for Testing") ??
                 findBinaryRecursive(extractDir, "chrome");

  if (!binary) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error("Chrome binary not found in zip");
  }

  // For macOS .app bundles, move the entire top-level extracted dir.
  // For Linux, move the directory containing the binary.
  const binaryParent = platform.startsWith("mac")
    ? findAppBundleRoot(extractDir) ?? path.dirname(binary)
    : path.dirname(binary);

  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  renameSync(binaryParent, targetDir);

  // Clean up extract dir
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });

  const finalPath = chromePath(platform);
  if (!existsSync(finalPath)) {
    throw new Error(`Binary not at expected path: ${finalPath}`);
  }
  chmodSync(finalPath, 0o755);

  saveVersion(CHROME_VERSION);
  console.error(`${LOG_PREFIX} Installed Chrome ${CHROME_VERSION}`);

  return finalPath;
}

/** Recursively find a binary by name in a directory tree. */
function findBinaryRecursive(dir: string, name: string): string | null {
  try {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === name) return full;
      try {
        if (statSync(full).isDirectory()) {
          const found = findBinaryRecursive(full, name);
          if (found) return found;
        }
      } catch {}
    }
  } catch {}
  return null;
}

/** Find the top-level directory inside an extract dir (for macOS .app bundles). */
function findAppBundleRoot(extractDir: string): string | null {
  try {
    const entries = readdirSync(extractDir);
    // Chrome for Testing zips contain a single top-level dir like "chrome-mac-arm64/"
    const dirs = entries.filter(e => {
      try { return statSync(path.join(extractDir, e)).isDirectory(); } catch { return false; }
    });
    if (dirs.length === 1) return path.join(extractDir, dirs[0]);
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ChromeManager {
  /** Ensure a Chrome binary is available. Returns the binary path. */
  ensureBinary(): Promise<string>;

  /** Launch Chrome on the given port. Returns the child process. */
  launch(port: number, options?: LaunchOptions): ChildProcess;

  /** Wait for CDP to be ready on the given port. */
  waitForCdp(host: string, port: number, timeoutMs?: number): Promise<void>;
}

export interface LaunchOptions {
  windowSize?: string; // e.g. "1920,1080"
  userDataDir?: string;
}

export function createChromeManager(): ChromeManager {
  const platform = detectPlatform();
  // Cache the resolved binary path after ensureBinary()
  let resolvedBinary: string | null = null;

  return {
    async ensureBinary(): Promise<string> {
      // 1. System Chrome (best — full browser, user-installed)
      const systemChrome = findSystemChrome();
      if (systemChrome) {
        console.error(`${LOG_PREFIX} Using system Chrome at ${systemChrome}`);
        resolvedBinary = systemChrome;
        return systemChrome;
      }

      // 2. Previously downloaded Chrome for Testing
      if (platform) {
        const managed = chromePath(platform);
        if (existsSync(managed)) {
          const version = installedVersion();
          console.error(`${LOG_PREFIX} Using managed Chrome ${version ?? "unknown"} at ${managed}`);
          resolvedBinary = managed;
          return managed;
        }
      }

      // 3. Download Chrome for Testing
      if (!platform) {
        throw new Error(
          `No Chrome browser found for ${os.platform()}/${os.arch()}. ` +
          `Install Google Chrome or use --no-chrome.`,
        );
      }

      console.error(`${LOG_PREFIX} No Chrome found — downloading Chrome for Testing...`);
      const binary = await downloadAndExtractChrome(platform);
      resolvedBinary = binary;
      return binary;
    },

    launch(port: number, options?: LaunchOptions): ChildProcess {
      const binary = resolvedBinary ?? findSystemChrome() ?? (platform ? chromePath(platform) : null);
      if (!binary || !existsSync(binary)) {
        throw new Error(`No Chrome binary available. Run ensureBinary() first.`);
      }

      const userDataDir = options?.userDataDir ?? path.join(
        process.env.BB_BROWSER_HOME || path.join(os.homedir(), ".bb-browser"),
        "chrome-data",
      );
      const windowSize = options?.windowSize ?? process.env.CHROME_WINDOW_SIZE ?? "1920,1080";

      mkdirSync(userDataDir, { recursive: true });

      // Always run headed. On macOS Chrome renders off-screen (no visible
      // window without a focused user session). On Linux Docker, Xvfb
      // provides the virtual display. Headless mode is intentionally
      // avoided — it lacks full GUI APIs and gets flagged by anti-bot
      // systems (Google, etc.).
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--window-size=${windowSize}`,
        "--no-first-run",
        "--disable-default-apps",
        "--no-sandbox",
        "about:blank",
      ];

      const isSystem = binary === findSystemChrome();
      const label = isSystem ? "system Chrome" : `managed Chrome ${installedVersion() ?? ""}`;
      console.error(`${LOG_PREFIX} Launching ${label.trim()} on port ${port}`);

      const child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      child.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.error(`${LOG_PREFIX} ${line}`);
      });

      child.on("exit", (code, signal) => {
        console.error(`${LOG_PREFIX} Process exited (code=${code}, signal=${signal})`);
      });

      // Write CDP port file for discovery
      const portFile = path.join(BROWSER_DIR, "cdp-port");
      mkdirSync(BROWSER_DIR, { recursive: true });
      writeFileSync(portFile, String(port));

      return child;
    },

    async waitForCdp(host: string, port: number, timeoutMs = 15000): Promise<void> {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2000);
          try {
            const resp = await fetch(`http://${host}:${port}/json/version`, {
              signal: controller.signal,
            });
            if (resp.ok) {
              const info = (await resp.json()) as { Browser?: string };
              console.error(`${LOG_PREFIX} CDP ready: ${info.Browser ?? "unknown"}`);
              return;
            }
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // Not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      throw new Error(`CDP not ready at ${host}:${port} after ${timeoutMs}ms`);
    },
  };
}
