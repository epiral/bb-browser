/**
 * Multi-instance session management.
 *
 * Each Claude Code window (identified by --session-id) is automatically
 * bound to its own Chrome browser instance on a dedicated CDP port.
 * Login state is inherited from the template user-data directory.
 */

import { execSync, spawn } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  openSync, closeSync, unlinkSync, readdirSync, rmSync,
  statSync, cpSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findBrowserExecutable } from "./cdp-discovery.js";

const LOCALHOST = "127.0.0.1";
const DEFAULT_CDP_PORT = 19825;
const MAX_CDP_PORT = 19899;
const MANAGED_BROWSER_DIR = path.join(os.homedir(), ".bb-browser", "browser");
const MANAGED_USER_DATA_DIR = path.join(MANAGED_BROWSER_DIR, "user-data");
const INSTANCES_DIR = path.join(os.homedir(), ".bb-browser", "instances");
const SESSION_MAP_FILE = path.join(INSTANCES_DIR, "session-map.json");
const SESSION_MAP_LOCK = path.join(INSTANCES_DIR, "session-map.lock");

type CdpEndpoint = { host: string; port: number };
type SessionMap = Record<string, number>;

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

// -- Session ID detection (cached) --

let cachedSessionId: string | null | undefined;

function detectSessionId(): string | null {
  if (cachedSessionId !== undefined) return cachedSessionId;

  if (process.env.BB_BROWSER_SESSION_ID) {
    cachedSessionId = process.env.BB_BROWSER_SESSION_ID;
    return cachedSessionId;
  }

  try {
    let pid = process.ppid;
    for (let i = 0; i < 5 && pid > 1; i++) {
      const info = execSync(`ps -p ${pid} -o ppid=,args=`, { encoding: "utf8", timeout: 2000 }).trim();
      const match = info.match(/--session-id\s+([a-f0-9-]+)/);
      if (match) { cachedSessionId = match[1]; return cachedSessionId; }
      pid = Number.parseInt(info.trim().split(/\s+/)[0], 10);
    }
  } catch {}

  cachedSessionId = null;
  return null;
}

// -- Session map file I/O with file lock --

function loadSessionMap(): SessionMap {
  try { return JSON.parse(readFileSync(SESSION_MAP_FILE, "utf8")); } catch { return {}; }
}

function saveSessionMap(map: SessionMap): void {
  try {
    mkdirSync(INSTANCES_DIR, { recursive: true });
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {}
}

function sleepSync(ms: number): void {
  try { execSync(`sleep ${(ms / 1000).toFixed(2)}`, { timeout: ms + 200 }); } catch {}
}

function withSessionMapLock<T>(fn: () => T): T {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(SESSION_MAP_LOCK, "wx");
      closeSync(fd);
      try { return fn(); } finally { try { unlinkSync(SESSION_MAP_LOCK); } catch {} }
    } catch {
      sleepSync(50);
    }
  }
  // Stale lock — force remove and proceed
  try { unlinkSync(SESSION_MAP_LOCK); } catch {}
  return fn();
}

function bindSessionPort(sessionId: string, port: number): void {
  withSessionMapLock(() => {
    const map = loadSessionMap();
    map[sessionId] = port;
    saveSessionMap(map);
  });
}

// -- Stale session cleanup --

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function checkPortAliveSync(port: number): boolean {
  try {
    const r = execSync(`curl -s --connect-timeout 1 http://${LOCALHOST}:${port}/json/version`, {
      encoding: "utf8", timeout: 2000,
    });
    return r.includes("Browser");
  } catch { return false; }
}

function cleanStaleSessions(map: SessionMap): void {
  try {
    const allProcs = execSync("ps -eo args=", { encoding: "utf8", timeout: 3000 });
    const staleSids: string[] = [];

    for (const [sid, port] of Object.entries(map)) {
      const stale = UUID_RE.test(sid)
        ? !allProcs.includes("--session-id " + sid)
        : !checkPortAliveSync(port);
      if (stale) staleSids.push(sid);
    }

    if (staleSids.length > 0) {
      withSessionMapLock(() => {
        const fresh = loadSessionMap();
        for (const sid of staleSids) delete fresh[sid];
        saveSessionMap(fresh);
      });
      for (const sid of staleSids) delete map[sid];
    }
  } catch {}
}

// -- Port allocation --

async function canConnect(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch { return false; }
}

async function findAliveInstances(boundPorts: Set<number>): Promise<Set<number>> {
  const alive = new Set<number>();
  try {
    const entries = readdirSync(INSTANCES_DIR);
    for (const entry of entries) {
      if (entry.endsWith(".lock") || entry === "session-map.json") continue;
      const port = Number.parseInt(entry, 10);
      if (!isValidPort(port)) continue;
      if (await canConnect(LOCALHOST, port)) {
        alive.add(port);
      } else if (!boundPorts.has(port)) {
        try { rmSync(path.join(INSTANCES_DIR, entry), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
  // Clean stale lock files
  try {
    for (const entry of readdirSync(INSTANCES_DIR)) {
      if (!entry.endsWith(".lock")) continue;
      const lockPath = path.join(INSTANCES_DIR, entry);
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30000) unlinkSync(lockPath);
      } catch {}
    }
  } catch {}
  return alive;
}

function tryAcquirePortLock(port: number): boolean {
  try {
    const fd = openSync(path.join(INSTANCES_DIR, `${port}.lock`), "wx");
    closeSync(fd);
    return true;
  } catch { return false; }
}

function releasePortLock(port: number): void {
  try { unlinkSync(path.join(INSTANCES_DIR, `${port}.lock`)); } catch {}
}

async function findFreePort(): Promise<number | null> {
  await mkdir(INSTANCES_DIR, { recursive: true });
  const map = loadSessionMap();
  cleanStaleSessions(map);
  const reservedPorts = new Set(Object.values(map));
  const alive = await findAliveInstances(reservedPorts);

  for (let port = DEFAULT_CDP_PORT; port <= MAX_CDP_PORT; port++) {
    if (alive.has(port) || reservedPorts.has(port)) continue;
    if (tryAcquirePortLock(port)) return port;
  }
  return null;
}

// -- Instance user-data preparation --

async function prepareInstanceUserData(port: number): Promise<string> {
  const instanceDir = path.join(INSTANCES_DIR, String(port));
  const instanceUserData = path.join(instanceDir, "user-data");
  await mkdir(instanceDir, { recursive: true });

  if (!existsSync(instanceUserData)) {
    if (existsSync(MANAGED_USER_DATA_DIR)) {
      cpSync(MANAGED_USER_DATA_DIR, instanceUserData, { recursive: true, force: true });
      // Remove Chrome singleton locks and SQLite WAL files from the copy
      const defaultDir = path.join(instanceUserData, "Default");
      const toRemove = [
        ...["SingletonLock", "SingletonCookie", "SingletonSocket"].map(n => path.join(instanceUserData, n)),
        ...["Cookies-journal", "Cookies-wal", "History-journal", "History-wal",
          "Login Data-journal", "Login Data-wal", "Web Data-journal", "Web Data-wal",
        ].map(n => path.join(defaultDir, n)),
      ];
      for (const f of toRemove) { try { unlinkSync(f); } catch {} }
    } else {
      await mkdir(instanceUserData, { recursive: true });
    }
  }

  // Ensure profile name
  const prefsPath = path.join(instanceUserData, "Default", "Preferences");
  await mkdir(path.join(instanceUserData, "Default"), { recursive: true });
  try {
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(await readFile(prefsPath, "utf8")); } catch {}
    if (!(prefs.profile as Record<string, unknown>)?.name || (prefs.profile as Record<string, unknown>).name !== "bb-browser") {
      prefs.profile = { ...(prefs.profile as Record<string, unknown> || {}), name: "bb-browser" };
      await writeFile(prefsPath, JSON.stringify(prefs), "utf8");
    }
  } catch {}

  return instanceUserData;
}

// -- Browser launch for instances --

async function launchInstanceBrowser(port: number): Promise<CdpEndpoint | null> {
  const executable = findBrowserExecutable();
  if (!executable) { releasePortLock(port); return null; }

  const userDataDir = await prepareInstanceUserData(port);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--disable-background-networking",
    "--disable-component-update", "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
    "--disable-cookie-encryption",
    "about:blank",
  ];

  try {
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    releasePortLock(port);
    return null;
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await canConnect(LOCALHOST, port)) {
      releasePortLock(port);
      return { host: LOCALHOST, port };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  releasePortLock(port);
  return null;
}

// -- Public API --

export interface SessionDiscoveryResult {
  endpoint: CdpEndpoint | null;
  handled: boolean; // true if session logic ran (caller should not fall through)
}

/**
 * Try to resolve a CDP endpoint via session binding.
 * Returns { handled: true } if a session was detected (endpoint may still be null on failure).
 * Returns { handled: false } if no session context — caller should fall through to legacy logic.
 */
export async function discoverSessionPort(): Promise<SessionDiscoveryResult> {
  // Check explicit port override (env var or --port flag)
  const envPort = Number.parseInt(process.env.BB_BROWSER_PORT ?? "", 10);
  if (isValidPort(envPort)) {
    if (await canConnect(LOCALHOST, envPort)) return { endpoint: { host: LOCALHOST, port: envPort }, handled: true };
    const launched = await launchInstanceBrowser(envPort);
    return { endpoint: launched, handled: true };
  }

  const sid = detectSessionId();
  if (!sid) return { endpoint: null, handled: false };

  // Session detected — look up bound port
  const map = loadSessionMap();
  const boundPort = map[sid];

  if (isValidPort(boundPort)) {
    if (await canConnect(LOCALHOST, boundPort)) {
      return { endpoint: { host: LOCALHOST, port: boundPort }, handled: true };
    }
    // Browser died — relaunch on same port to preserve user-data
    const relaunched = await launchInstanceBrowser(boundPort);
    if (relaunched) return { endpoint: relaunched, handled: true };
  }

  // No binding or relaunch failed — allocate new port
  const freePort = await findFreePort();
  if (freePort) {
    const launched = await launchInstanceBrowser(freePort);
    if (launched) {
      bindSessionPort(sid, freePort);
      return { endpoint: launched, handled: true };
    }
  }

  return { endpoint: null, handled: true };
}
