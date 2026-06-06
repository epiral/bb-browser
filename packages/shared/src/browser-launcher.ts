/**
 * Managed-browser launcher.
 *
 * Locates a Chromium-based browser and launches it with a remote-debugging
 * port so the daemon can attach via CDP. Shared by:
 *   - the CLI orchestrator (cli/cdp-discovery), which pre-launches Chrome
 *     before spawning the daemon; and
 *   - the daemon itself (daemon/index), so a daemon spawned by the tray app
 *     — which, unlike the CLI, does NOT pre-launch Chrome — can still bring
 *     up its own browser instead of dying when no CDP endpoint is reachable.
 *
 * The managed browser runs under a DEDICATED, persistent profile, separate
 * from the user's real profile, so it coexists with the user's normal browser
 * without ever closing or disturbing it. (360ChromeX in particular has a
 * stubborn single-instance model that made closing-and-relaunching the real
 * profile unreliable — it looped, repeatedly killing the user's browser.)
 * Agent logins accumulate in this managed profile and persist across runs.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DAEMON_DIR } from "./daemon-client.js";

/** Default CDP debugging port (odd chain start). */
export const DEFAULT_CDP_PORT = 19825;

/** Directory holding managed-browser bookkeeping. */
export const MANAGED_BROWSER_DIR = path.join(DAEMON_DIR, "browser");

/** File recording the port of the managed browser, if any. */
export const MANAGED_PORT_FILE = path.join(MANAGED_BROWSER_DIR, "cdp-port");

/**
 * Dedicated, persistent profile for the managed debug browser. A distinct
 * `--user-data-dir` gives the managed instance its own single-instance scope,
 * so it runs alongside the user's normal browser without our needing to close
 * theirs. Logins made here persist across runs.
 */
const MANAGED_USER_DATA_DIR = path.join(MANAGED_BROWSER_DIR, "profile");

/**
 * Hosts to probe for a CDP endpoint. 360ChromeX may bind the debug port on
 * IPv6 (`::1`) rather than IPv4 loopback, so we try both — otherwise a browser
 * that IS debuggable on `::1` looks unreachable and the daemon relaunch-loops.
 */
const PROBE_HOSTS = ["127.0.0.1", "[::1]"];

/**
 * Probe a CDP endpoint on `port` across IPv4 and IPv6. Returns the host (in URL
 * form, e.g. `127.0.0.1` or `[::1]`) that answered `/json/version`, or null.
 */
export async function probeCdp(port: number): Promise<string | null> {
  for (const host of PROBE_HOSTS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch(`http://${host}:${port}/json/version`, {
          signal: controller.signal,
        });
        if (response.ok) return host;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // try next host
    }
  }
  return null;
}

/** Locate a Chromium-based browser executable for the current platform. */
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
        const resolved = execSync(`which ${candidate}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (resolved) {
          return resolved;
        }
      } catch {
        // not found — try next
      }
    }
    return null;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = [
      // 360ChromeX
      ...(localAppData ? [`${localAppData}/360ChromeX/Chrome/Application/360ChromeX.exe`] : []),
      // Google Chrome
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ...(localAppData
        ? [
            `${localAppData}/Google/Chrome Dev/Application/chrome.exe`,
            `${localAppData}/Google/Chrome SxS/Application/chrome.exe`,
            `${localAppData}/Google/Chrome Beta/Application/chrome.exe`,
          ]
        : []),
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  return null;
}

/**
 * Launch a managed Chromium browser on the given CDP port under a dedicated
 * profile and wait until it is reachable. Writes the resolved port to
 * MANAGED_PORT_FILE so other processes (and the daemon's own fallback) can find
 * it. Returns the reachable `{host, port}` (host may be IPv4 or IPv6), or null
 * if no browser executable is found or it never becomes reachable.
 *
 * Never closes the user's browser: the dedicated `--user-data-dir` gives the
 * managed instance its own single-instance scope, so it coexists with the
 * user's normal session.
 */
export async function launchManagedBrowser(
  port: number = DEFAULT_CDP_PORT,
): Promise<{ host: string; port: number } | null> {
  const executable = findBrowserExecutable();
  if (!executable) {
    return null;
  }

  // Already debuggable on this port? (Our managed instance from a prior run, or
  // a browser the user started with --remote-debugging-port.) Nothing to launch.
  const existing = await probeCdp(port);
  if (existing) {
    return { host: existing, port };
  }

  await mkdir(MANAGED_USER_DATA_DIR, { recursive: true });

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
    "--use-mock-keychain",
    "about:blank",
  ];

  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    return null;
  }

  await mkdir(MANAGED_BROWSER_DIR, { recursive: true });
  await writeFile(MANAGED_PORT_FILE, String(port), "utf8");

  // 360ChromeX + a cold dedicated profile can take a while to bind the port;
  // poll both IPv4 and IPv6 for up to ~25s.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const host = await probeCdp(port);
    if (host) {
      return { host, port };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return null;
}
