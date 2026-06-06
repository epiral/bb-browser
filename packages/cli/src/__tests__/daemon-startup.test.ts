/**
 * Daemon startup tests — verifies:
 *   - Two-phase startup: daemon.json written before CDP connects (#136 fix)
 *   - Daemon stays alive when Chrome is unavailable (self-healing via retry loop)
 *   - 503 diagnostics when CDP is not yet connected
 *
 * These tests verify the startup chain WITHOUT requiring a real Chrome browser.
 * The pre-commit hook runs `pnpm build` before `pnpm test`, so dist/ is fresh.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use isolated temp dir to avoid conflicts with parallel test suites
const DAEMON_DIR = path.join(os.tmpdir(), `bb-browser-test-startup-${process.pid}`);
mkdirSync(DAEMON_DIR, { recursive: true });
process.env.BB_BROWSER_HOME = DAEMON_DIR;
const DAEMON_JSON = path.join(DAEMON_DIR, "daemon.json");
const MANAGED_PORT_FILE = path.join(DAEMON_DIR, "browser", "cdp-port");

// Use the compiled dist so no tsx/shell-script issues on Windows.
// The pre-commit hook runs `pnpm build` before tests, so dist/ is always fresh.
const DAEMON_ENTRY = path.resolve(
  import.meta.dirname,
  "../../../daemon/dist/index.js",
);

// Unique port counter so concurrent/sequential tests don't share daemon ports.
let _portCounter = 39970;
function nextPort(): number { return _portCounter++; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDaemonJson(): { pid: number; host: string; port: number; token: string } | null {
  try {
    return JSON.parse(readFileSync(DAEMON_JSON, "utf8"));
  } catch {
    return null;
  }
}

function cleanupDaemonJson(): void {
  try { unlinkSync(DAEMON_JSON); } catch {}
}

function cleanupManagedPortFile(): void {
  try { unlinkSync(MANAGED_PORT_FILE); } catch {}
}

/** Wait for daemon.json to appear (or timeout) */
async function waitForDaemonJson(timeoutMs = 8000): Promise<{ pid: number; host: string; port: number; token: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDaemonJson();
    if (info) return info;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("daemon.json not created in time");
}

/** Start a fake CDP server that responds to /json/version (HTTP only, not WebSocket) */
function startFakeCdpServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          Browser: "FakeChrome/1.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        }));
      } else if (req.url === "/json/list" || req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{
          id: "DEADBEEF1234",
          type: "page",
          title: "Test Page",
          url: "about:blank",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/DEADBEEF1234`,
        }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function killProcess(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch {}
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kill daemon by PID from daemon.json, then clean up. */
async function killDaemonFromJson(): Promise<void> {
  const info = readDaemonJson();
  if (info && isProcessAlive(info.pid)) {
    killProcess(info.pid);
    await new Promise(r => setTimeout(r, 400));
  }
  cleanupDaemonJson();
}

// ---------------------------------------------------------------------------
// Test: Daemon with no Chrome — two-phase startup keeps daemon alive (#136 fix)
// ---------------------------------------------------------------------------

describe("daemon startup without Chrome", () => {
  let daemonPid: number | null = null;

  beforeEach(() => {
    cleanupDaemonJson();
    cleanupManagedPortFile();
    daemonPid = null;
  });

  afterEach(async () => {
    // Kill by daemon.json PID (most reliable) then by any saved daemonPid
    await killDaemonFromJson();
    if (daemonPid && isProcessAlive(daemonPid)) {
      killProcess(daemonPid);
      await new Promise(r => setTimeout(r, 300));
    }
    daemonPid = null;
  });

  it("daemon stays running and writes daemon.json even without Chrome (two-phase startup)", async () => {
    // Phase 1 (HTTP server) always completes regardless of Chrome availability.
    // Phase 2 (CDP) retries in the background — daemon never exits on CDP failure.
    const daemonPort = nextPort();
    const unusedCdpPort = nextPort();
    const child = spawn(process.execPath, [
      DAEMON_ENTRY, "--cdp-port", String(unusedCdpPort), "--port", String(daemonPort),
    ], { detached: true, stdio: "ignore" });
    child.unref();

    const info = await waitForDaemonJson();
    daemonPid = info.pid;

    assert.equal(typeof info.pid, "number");
    assert.equal(typeof info.token, "string");
    assert.ok(info.token.length > 0);
    assert.ok(isProcessAlive(info.pid), "daemon should stay alive even without Chrome");
  });

  it("daemon writes daemon.json quickly via two-phase startup (no Chrome needed)", async () => {
    // The HTTP server (phase 1) starts in milliseconds. daemon.json appears
    // long before the CDP retry window gives up — well within 5 seconds.
    const daemonPort = nextPort();
    const unusedCdpPort = nextPort();
    const child = spawn(process.execPath, [
      DAEMON_ENTRY, "--cdp-port", String(unusedCdpPort), "--port", String(daemonPort),
    ], { detached: true, stdio: "ignore" });
    child.unref();

    const info = await waitForDaemonJson(5000);
    daemonPid = info.pid;

    assert.ok(info.pid > 0, "daemon should be running with a valid PID");
    assert.ok(isProcessAlive(info.pid), "daemon process should be alive");
  });
});

// ---------------------------------------------------------------------------
// Test: Daemon with fake Chrome — proves fix works
// ---------------------------------------------------------------------------

describe("daemon startup with CDP available", () => {
  let fakeCdp: http.Server | null = null;
  const cdpPort = 39998;
  let daemonPid: number | null = null;

  beforeEach(async () => {
    cleanupDaemonJson();
    cleanupManagedPortFile();
    fakeCdp = await startFakeCdpServer(cdpPort);
  });

  afterEach(async () => {
    if (daemonPid && isProcessAlive(daemonPid)) {
      killProcess(daemonPid);
      await new Promise(r => setTimeout(r, 500));
    }
    daemonPid = null;
    cleanupDaemonJson();
    if (fakeCdp) {
      await new Promise<void>(resolve => fakeCdp!.close(() => resolve()));
      fakeCdp = null;
    }
  });

  it("daemon starts successfully when CDP port is reachable", async () => {
    const daemonPort = nextPort();
    const child = spawn(process.execPath, [
      DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", String(daemonPort),
    ], { detached: true, stdio: "ignore" });
    child.unref();

    const info = await waitForDaemonJson();
    daemonPid = info.pid;

    assert.equal(typeof info.pid, "number");
    assert.equal(typeof info.token, "string");
    assert.ok(info.token.length > 0, "token should be generated");
    assert.ok(isProcessAlive(info.pid), "daemon process should be alive");
  });

  it("daemon writes correct host/port in daemon.json", async () => {
    const daemonPort = nextPort();
    const child = spawn(process.execPath, [
      DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--host", "127.0.0.1", "--port", String(daemonPort),
    ], { detached: true, stdio: "ignore" });
    child.unref();

    const info = await waitForDaemonJson();
    daemonPid = info.pid;

    assert.equal(info.host, "127.0.0.1");
    assert.equal(info.port, daemonPort);
  });

  it("daemon HTTP /status responds when CDP is connected", async () => {
    const daemonPort = nextPort();
    const child = spawn(process.execPath, [
      DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", String(daemonPort),
    ], { detached: true, stdio: "ignore" });
    child.unref();

    const info = await waitForDaemonJson();
    daemonPid = info.pid;

    // Wait a bit for CDP connection
    await new Promise(r => setTimeout(r, 1000));

    const status = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.request({
        hostname: info.host,
        port: info.port,
        path: "/status",
        method: "GET",
        headers: { Authorization: `Bearer ${info.token}` },
        timeout: 3000,
      }, res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(status.running, true, "/status should report running");
  });
});

// ---------------------------------------------------------------------------
// Test: CLI ensureDaemon should pass CDP info to daemon
// ---------------------------------------------------------------------------

describe("ensureDaemon passes CDP info to daemon", () => {
  let fakeCdp: http.Server | null = null;
  const cdpPort = 39994;

  beforeEach(async () => {
    cleanupDaemonJson();
    cleanupManagedPortFile();
    // Write managed port file pointing to our fake CDP
    mkdirSync(path.dirname(MANAGED_PORT_FILE), { recursive: true });
    writeFileSync(MANAGED_PORT_FILE, String(cdpPort));
    fakeCdp = await startFakeCdpServer(cdpPort);
  });

  afterEach(async () => {
    await killDaemonFromJson();
    cleanupManagedPortFile();
    if (fakeCdp) {
      await new Promise<void>(resolve => fakeCdp!.close(() => resolve()));
      fakeCdp = null;
    }
  });

  it("daemon discovers CDP via managed port file", async () => {
    // Daemon should read ~/.bb-browser/browser/cdp-port and find our fake CDP
    const daemonPort = nextPort();
    const child = spawn(process.execPath, [DAEMON_ENTRY, "--port", String(daemonPort)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const info = await waitForDaemonJson();
    assert.ok(isProcessAlive(info.pid), "daemon should be running");
  });
});

// ---------------------------------------------------------------------------
// Test: Two-phase startup — daemon persists without CDP (#136 fix)
// ---------------------------------------------------------------------------

describe("two-phase startup: daemon writes daemon.json before CDP (#136 fix)", () => {
  let daemonPid: number | null = null;

  beforeEach(() => {
    cleanupDaemonJson();
    cleanupManagedPortFile();
    daemonPid = null;
  });

  afterEach(async () => {
    await killDaemonFromJson();
    if (daemonPid && isProcessAlive(daemonPid)) {
      killProcess(daemonPid);
      await new Promise(r => setTimeout(r, 300));
    }
    daemonPid = null;
  });

  it("daemon writes daemon.json even with no Chrome on default CDP port (phase 1 is independent)", async () => {
    // With two-phase startup, the HTTP server (phase 1) always completes and
    // writes daemon.json before any CDP work begins. Phase 2 (CDP) retries in
    // the background and never kills the daemon on failure.
    const daemonPort = nextPort();
    const child = spawn(process.execPath, [DAEMON_ENTRY, "--port", String(daemonPort)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, BB_BROWSER_CDP_URL: undefined },
    });
    child.unref();

    const info = await waitForDaemonJson(5000);
    daemonPid = info.pid;
    assert.ok(isProcessAlive(info.pid), "daemon should be running even without Chrome on default port");
  });

  it("daemon with explicit --cdp-port pointing to fake CDP → starts successfully", async () => {
    const cdpPort = 39992;
    const daemonPort = nextPort();
    const fakeCdp = await startFakeCdpServer(cdpPort);

    try {
      const child = spawn(process.execPath, [
        DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", String(daemonPort),
      ], { detached: true, stdio: "ignore" });
      child.unref();

      const info = await waitForDaemonJson();
      daemonPid = info.pid;
      assert.ok(isProcessAlive(info.pid), "daemon should be running when given correct CDP port");
    } finally {
      await new Promise<void>(resolve => fakeCdp.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Test: 503 error includes diagnostics
// ---------------------------------------------------------------------------

describe("CDP 503 error includes diagnostics", () => {
  let daemonPid: number | null = null;

  afterEach(async () => {
    if (daemonPid && isProcessAlive(daemonPid)) {
      killProcess(daemonPid);
      await new Promise(r => setTimeout(r, 500));
    }
    daemonPid = null;
    cleanupDaemonJson();
  });

  it("503 response includes CDP target, reason, and hint — responds immediately not 30s", async () => {
    const cdpPort = 39989;
    const daemonPort = 39988;
    const fakeCdp = await startFakeCdpServer(cdpPort);

    try {
      const child = spawn(process.execPath, [
        DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", String(daemonPort),
      ], { detached: true, stdio: "ignore" });
      child.unref();

      const info = await waitForDaemonJson();
      daemonPid = info.pid;

      // Wait for daemon to try and fail CDP WebSocket (fake server doesn't handle WebSocket)
      await new Promise(r => setTimeout(r, 2000));

      const start = Date.now();
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = http.request({
          hostname: info.host,
          port: info.port,
          path: "/command",
          method: "POST",
          headers: {
            Authorization: `Bearer ${info.token}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }, res => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (e) { reject(e); }
          });
        });
        req.on("error", reject);
        req.write(JSON.stringify({ id: "diag-test", action: "tab_list" }));
        req.end();
      });
      const elapsed = Date.now() - start;

      // Must not wait 30s — cdp.lastError is set after first failed attempt,
      // so waitUntilReady() rejects immediately on subsequent calls.
      assert.ok(elapsed < 10000, `should respond quickly, not wait 30s (took ${elapsed}ms)`);

      // Must have diagnostics
      assert.equal(response.success, false);
      assert.match(response.error as string, /Chrome not connected/, "error should mention Chrome");
      assert.ok(typeof response.reason === "string", "should include reason");
      assert.ok((response.reason as string).length > 0, "reason should not be empty");
      assert.ok(typeof response.hint === "string", "should include hint");
    } finally {
      await new Promise<void>(resolve => fakeCdp.close(() => resolve()));
    }
  });
});
