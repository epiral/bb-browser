import { execFile, execSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseOpenClawJson } from "./openclaw-json.js";

/**
 * Read the CDP port from a DevToolsActivePort file.
 * The file contains two lines: port number on line 1, optional ws path on line 2.
 * Returns null if the file does not exist or is malformed.
 */
function readDevToolsActivePortFile(userDataDir: string): number | null {
  const filePath = path.join(userDataDir, "DevToolsActivePort");
  try {
    const content = readFileSync(filePath, "utf8");
    const port = Number.parseInt(content.split("\n")[0].trim(), 10);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {}
  return null;
}

/**
 * Scan all known browser user-data directories for a DevToolsActivePort file.
 * Returns the first reachable CDP endpoint found, or null.
 */
async function discoverViaDevToolsActivePort(): Promise<{ host: string; port: number } | null> {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    candidates.push(
      path.join(appSupport, "Microsoft Edge"),
      path.join(appSupport, "Google", "Chrome"),
      path.join(appSupport, "BraveSoftware", "Brave-Browser"),
      path.join(appSupport, "Chromium"),
      path.join(appSupport, "Arc"),
      path.join(appSupport, "com.operasoftware.Opera"),
      path.join(appSupport, "Vivaldi"),
    );
  } else if (process.platform === "linux") {
    const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    candidates.push(
      path.join(configHome, "microsoft-edge"),
      path.join(configHome, "google-chrome"),
      path.join(configHome, "chromium"),
      path.join(configHome, "BraveSoftware", "Brave-Browser"),
      path.join(configHome, "opera"),
      path.join(configHome, "vivaldi"),
    );
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const appData = process.env.APPDATA ?? "";
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "Microsoft", "Edge", "User Data"),
        path.join(localAppData, "Google", "Chrome", "User Data"),
        path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
        path.join(localAppData, "Chromium", "User Data"),
        path.join(localAppData, "Vivaldi", "User Data"),
      );
    }
    if (appData) {
      candidates.push(path.join(appData, "Opera Software", "Opera Stable"));
    }
  }

  for (const dir of candidates) {
    const port = readDevToolsActivePortFile(dir);
    if (port !== null && await canConnect("127.0.0.1", port)) {
      return { host: "127.0.0.1", port };
    }
  }
  return null;
}

// Chromium-based browser identifiers for detection
const CHROMIUM_BUNDLE_IDS = [
  "com.google.Chrome",
  "com.google.Chrome.beta",
  "com.google.Chrome.dev",
  "com.google.Chrome.canary",
  "com.microsoft.edgemac",
  "com.microsoft.edgemac.Beta",
  "com.microsoft.edgemac.Dev",
  "com.microsoft.edgemac.Canary",
  "com.brave.Browser",
  "com.brave.Browser.beta",
  "com.brave.Browser.nightly",
  "company.thebrowser.Browser", // Arc
  "org.chromium.Chromium",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
];

const CHROMIUM_EXECUTABLE_PATTERNS = [
  /chrome/i,
  /chromium/i,
  /microsoft.?edge/i,
  /msedge/i,
  /brave/i,
  /arc/i,
  /opera/i,
  /vivaldi/i,
];

/**
 * Determine if a browser executable path or bundle ID corresponds to a Chromium-based browser.
 */
function isChromiumBased(executableOrBundleId: string): boolean {
  // Check against known bundle IDs first
  if (CHROMIUM_BUNDLE_IDS.includes(executableOrBundleId)) {
    return true;
  }
  // Check executable path/name patterns
  return CHROMIUM_EXECUTABLE_PATTERNS.some((pattern) => pattern.test(executableOrBundleId));
}

/**
 * Get the system default browser executable path.
 * Returns null if the default browser cannot be determined.
 */
function getDefaultBrowserExecutable(): { executable: string; isChromium: boolean } | null {
  if (process.platform === "darwin") {
    return getDefaultBrowserDarwin();
  }
  if (process.platform === "linux") {
    return getDefaultBrowserLinux();
  }
  if (process.platform === "win32") {
    return getDefaultBrowserWin32();
  }
  return null;
}

function getDefaultBrowserDarwin(): { executable: string; isChromium: boolean } | null {
  try {
    // Read the default handler for https scheme from LaunchServices
    const output = execSync(
      "defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    );

    // Find the bundle ID for the https handler
    const lines = output.split("\n");
    let bundleId: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("LSHandlerURLScheme") && lines[i].includes("https")) {
        // Look backwards for LSHandlerRoleAll in the same block
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const match = lines[j].match(/LSHandlerRoleAll\s*=\s*"([^"]+)"/);
          if (match) {
            bundleId = match[1];
            break;
          }
        }
        if (bundleId) break;
      }
    }

    if (!bundleId) return null;

    const chromium = isChromiumBased(bundleId);

    // Find the app path via mdfind (Spotlight)
    const appPath = execSync(
      `mdfind "kMDItemCFBundleIdentifier == '${bundleId}'"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    ).trim().split("\n")[0];

    if (!appPath) return null;

    // Get the executable name from Info.plist
    const execName = execSync(
      `defaults read "${appPath}/Contents/Info" CFBundleExecutable`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();

    if (!execName) return null;

    const executable = `${appPath}/Contents/MacOS/${execName}`;
    if (!existsSync(executable)) return null;

    return { executable, isChromium: chromium };
  } catch {
    return null;
  }
}

function getDefaultBrowserLinux(): { executable: string; isChromium: boolean } | null {
  try {
    // Get the default browser .desktop file name
    const desktopFile = execSync(
      "xdg-settings get default-web-browser",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    ).trim();

    if (!desktopFile) return null;

    // Search for the .desktop file in standard locations
    const desktopDirs = [
      "/usr/share/applications",
      "/usr/local/share/applications",
      path.join(os.homedir(), ".local/share/applications"),
    ];

    let execLine: string | null = null;
    for (const dir of desktopDirs) {
      const desktopPath = path.join(dir, desktopFile);
      if (existsSync(desktopPath)) {
        try {
          const content = readFileSync(desktopPath, "utf8");
          const match = content.match(/^Exec=(.+?)(?:\s+%[uUfF])?$/m);
          if (match) {
            execLine = match[1].trim();
            break;
          }
        } catch {
          // continue
        }
      }
    }

    if (!execLine) return null;

    // Resolve to full path if needed
    let executable = execLine.split(" ")[0];
    if (!path.isAbsolute(executable)) {
      try {
        executable = execSync(`which ${executable}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        }).trim();
      } catch {
        return null;
      }
    }

    if (!existsSync(executable)) return null;

    return { executable, isChromium: isChromiumBased(executable) };
  } catch {
    return null;
  }
}

function getDefaultBrowserWin32(): { executable: string; isChromium: boolean } | null {
  try {
    // Read the ProgId for https from the registry
    const progId = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId',
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    );
    const progIdMatch = progId.match(/ProgId\s+REG_SZ\s+(\S+)/);
    if (!progIdMatch) return null;

    const id = progIdMatch[1];

    // Get the open command for this ProgId
    const openCmd = execSync(
      `reg query "HKCR\\${id}\\shell\\open\\command" /ve`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    );
    const cmdMatch = openCmd.match(/REG_SZ\s+"?([^"%\s][^"]*?)(?:\.exe)"?/i);
    if (!cmdMatch) return null;

    const executable = `${cmdMatch[1]}.exe`.replace(/^"/, "");
    if (!existsSync(executable)) return null;

    return { executable, isChromium: isChromiumBased(executable) };
  } catch {
    return null;
  }
}

const DEFAULT_CDP_PORT = 19825;
const MANAGED_BROWSER_DIR = path.join(os.homedir(), ".bb-browser", "browser");
const MANAGED_USER_DATA_DIR = path.join(MANAGED_BROWSER_DIR, "user-data");
const MANAGED_PORT_FILE = path.join(MANAGED_BROWSER_DIR, "cdp-port");
const CDP_CACHE_FILE = path.join(os.tmpdir(), "bb-browser-cdp-cache.json");
const CACHE_TTL_MS = 30000; // 缓存有效期 30 秒

/**
 * Get the real user-data-dir for a given browser executable.
 * Returns null if it cannot be determined.
 */
function getRealUserDataDir(executable: string): string | null {
  const home = os.homedir();

  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    if (/Google Chrome/i.test(executable)) return path.join(appSupport, "Google", "Chrome");
    if (/Microsoft Edge/i.test(executable)) return path.join(appSupport, "Microsoft Edge");
    if (/Brave/i.test(executable)) return path.join(appSupport, "BraveSoftware", "Brave-Browser");
    if (/Arc/i.test(executable)) return path.join(appSupport, "Arc");
    if (/Chromium/i.test(executable)) return path.join(appSupport, "Chromium");
    if (/Opera/i.test(executable)) return path.join(appSupport, "com.operasoftware.Opera");
    if (/Vivaldi/i.test(executable)) return path.join(appSupport, "Vivaldi");
  }

  if (process.platform === "linux") {
    const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    if (/google-chrome/i.test(executable)) return path.join(configHome, "google-chrome");
    if (/chromium/i.test(executable)) return path.join(configHome, "chromium");
    if (/microsoft-edge/i.test(executable) || /msedge/i.test(executable)) return path.join(configHome, "microsoft-edge");
    if (/brave/i.test(executable)) return path.join(configHome, "BraveSoftware", "Brave-Browser");
    if (/opera/i.test(executable)) return path.join(configHome, "opera");
    if (/vivaldi/i.test(executable)) return path.join(configHome, "vivaldi");
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const appData = process.env.APPDATA ?? "";
    if (/chrome/i.test(executable)) return path.join(localAppData, "Google", "Chrome", "User Data");
    if (/msedge/i.test(executable) || /Microsoft Edge/i.test(executable)) return path.join(localAppData, "Microsoft", "Edge", "User Data");
    if (/brave/i.test(executable)) return path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data");
    if (/chromium/i.test(executable)) return path.join(localAppData, "Chromium", "User Data");
    if (/opera/i.test(executable)) return path.join(appData, "Opera Software", "Opera Stable");
    if (/vivaldi/i.test(executable)) return path.join(localAppData, "Vivaldi", "User Data");
  }

  return null;
}

/**
 * Check if the real browser (not bb-browser managed instance) is currently running.
 * Uses SingletonLock file presence as the primary signal on all platforms.
 */
function isRealBrowserRunning(realUserDataDir: string): boolean {
  const singletonLock = path.join(realUserDataDir, "SingletonLock");

  // Use lstatSync instead of existsSync because SingletonLock is a dangling symlink
  // (points to "hostname-pid", not a real file path), so existsSync returns false
  try {
    lstatSync(singletonLock);
  } catch {
    return false;
  }

  // On macOS/Linux, SingletonLock is a symlink pointing to "hostname-pid"
  // Verify the PID is still alive
  if (process.platform !== "win32") {
    try {
      const target = readlinkSync(singletonLock);
      const pidMatch = target.match(/-(\d+)$/);
      if (pidMatch) {
        const pid = Number(pidMatch[1]);
        try {
          process.kill(pid, 0); // signal 0 = check if process exists
          return true;
        } catch {
          return false; // process not found, stale lock
        }
      }
    } catch {
      // Can't read symlink, assume running
      return true;
    }
  }

  return true;
}

/**
 * Gracefully quit the real browser process so we can restart it with CDP enabled.
 * Kills all processes sharing the same executable path to avoid SingletonLock conflicts.
 * Returns true if the browser was successfully stopped.
 */
async function quitRealBrowser(realUserDataDir: string, executable: string): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      const exeName = path.basename(executable);
      execSync(`taskkill /F /IM "${exeName}"`, { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return true;
    } catch {
      return false;
    }
  }

  // macOS / Linux: kill all processes whose executable path starts with the app bundle
  // (covers main process + all Helper/Renderer/GPU child processes)
  const appDir = process.platform === "darwin"
    ? executable.replace(/\/Contents\/MacOS\/[^/]+$/, "") // e.g. /Applications/Microsoft Edge.app
    : path.dirname(executable);

  try {
    // Get all PIDs whose command starts with the app directory
    const psOutput = execSync(
      `pgrep -f "${appDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    ).trim();

    const pids = psOutput.split("\n").map(Number).filter((n) => n > 0 && n !== process.pid);
    if (pids.length === 0) return true;

    // Send SIGTERM to all
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }

    // Wait up to 5s for all to exit
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const stillAlive = pids.filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      if (stillAlive.length === 0) break;
      // Force kill stragglers near deadline
      if (Date.now() + 600 >= deadline) {
        for (const pid of stillAlive) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    }

    // Extra wait for OS to release the SingletonLock file
    await new Promise((resolve) => setTimeout(resolve, 500));
    return true;
  } catch {
    return false;
  }
}

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
  // Try the system default browser first
  const defaultBrowser = getDefaultBrowserExecutable();
  if (defaultBrowser) {
    if (defaultBrowser.isChromium) {
      return defaultBrowser.executable;
    }
    // Default browser is not Chromium-based; warn and fall through to known candidates
    console.error(
      `[bb-browser] 系统默认浏览器不是 Chromium 内核，无法直接控制。正在查找 Chrome/Edge/Brave...`,
    );
  }

  // Fall back to known Chromium-based browser candidates
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

  // Prefer the real user profile so the browser has full history/bookmarks/passwords
  const realUserDataDir = getRealUserDataDir(executable);
  let userDataDir: string;

  if (realUserDataDir && existsSync(realUserDataDir)) {
    if (isRealBrowserRunning(realUserDataDir)) {
      // Check if the running browser already has CDP enabled (DevToolsActivePort exists)
      const existingPort = readDevToolsActivePortFile(realUserDataDir);
      if (existingPort !== null && await canConnect("127.0.0.1", existingPort)) {
        // Browser is already running with CDP — reuse it directly, no restart needed
        await mkdir(MANAGED_BROWSER_DIR, { recursive: true });
        await writeFile(MANAGED_PORT_FILE, String(existingPort), "utf8");
        return { host: "127.0.0.1", port: existingPort };
      }

      // Real browser is running without CDP — restart it with CDP enabled
      console.error("[bb-browser] 检测到浏览器正在运行，正在重启以启用调试模式（历史记录/书签/密码将保留）...");
      const stopped = await quitRealBrowser(realUserDataDir, executable);
      if (!stopped) {
        // Could not stop the real browser; fall back to isolated profile
        console.error("[bb-browser] 无法关闭已运行的浏览器，将使用独立 profile 启动（不含历史记录/书签）");
        userDataDir = MANAGED_USER_DATA_DIR;
      } else {
        userDataDir = realUserDataDir;
      }
    } else {
      userDataDir = realUserDataDir;
    }
  } else {
    userDataDir = MANAGED_USER_DATA_DIR;
  }

  if (userDataDir === MANAGED_USER_DATA_DIR) {
    // Only set up the managed profile name when using the isolated dir
    await mkdir(MANAGED_USER_DATA_DIR, { recursive: true });
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
  }

  const usingRealProfile = userDataDir !== MANAGED_USER_DATA_DIR;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // When using the real profile, don't pass a URL so the browser restores
    // the previous session (tabs) according to the user's startup settings.
    // For the isolated managed profile, open about:blank to avoid a blank window.
    ...(!usingRealProfile ? [
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "about:blank",
    ] : []),
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

  // Real profiles take longer to start; allow up to 15s
  const deadline = Date.now() + 15000;
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

  // 优先级5: DevToolsActivePort 文件自动发现
  // 当用户在 chrome://inspect 或 edge://inspect 中开启了远程调试后，
  // 浏览器会将动态分配的 CDP 端口写入 DevToolsActivePort 文件。
  // 这样无需重启浏览器即可直接连接。
  const viaActivePort = await discoverViaDevToolsActivePort();
  if (viaActivePort) {
    return viaActivePort;
  }

  // 优先级6: 自动启动浏览器
  const launched = await launchManagedBrowser();
  if (launched) {
    return launched;
  }

  // 优先级7: 自动检测 OpenClaw（不带 --openclaw 参数时）
  if (!process.argv.includes("--openclaw")) {
    const detectedOpenClaw = await tryOpenClaw();
    if (detectedOpenClaw && await canConnect(detectedOpenClaw.host, detectedOpenClaw.port)) {
      return detectedOpenClaw;
    }
  }

  return null;
}
