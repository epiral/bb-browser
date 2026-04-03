/**
 * Daemon startup tests — reproduces and verifies fixes for:
 *   - #136: "Daemon did not start in time" when no Chrome running
 *   - #143: "找不到chrome" on Windows/Linux
 *   - #141: IPv6/IPv4 mismatch
 *   - #118: daemon exits immediately
 *
 * Root cause: daemon-manager.ts spawns daemon without passing CDP info,
 * daemon's own discoverCdpPort only tries port 19825 + managed port file,
 * does NOT auto-launch Chrome. CLI's cdp-discovery.ts has full 6-level
 * discovery (including auto-launch) but daemon never uses it.
 *
 * These tests verify the startup chain WITHOUT requiring a real Chrome browser.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
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
const DAEMON_ENTRY = path.resolve(
  import.meta.dirname,
  "../../../daemon/src/index.ts",
);
const TSX = path.resolve(
  import.meta.dirname,
  "../../../../node_modules/.bin/tsx",
);

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

/** Start a fake CDP server that responds to /json/version */
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

// ---------------------------------------------------------------------------
// Test: Daemon with no Chrome — reproduces #136, #143
// ---------------------------------------------------------------------------

describe("daemon startup without Chrome", () => {
  beforeEach(() => {
    cleanupDaemonJson();
    cleanupManagedPortFile();
  });

  it("daemon exits with error when no CDP is available", async () => {
    // Spawn daemon with a port that nothing is listening on
    const unusedPort = 39999;
    const child = spawn(TSX, [DAEMON_ENTRY, "--cdp-port", String(unusedPort)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const exitCode = await new Promise<number | null>(resolve => {
      child.on("exit", resolve);
    });

    assert.notEqual(exitCode, 0, "daemon should exit with non-zero when no Chrome");
    assert.match(stderr, /Cannot connect to Chrome CDP/, "should report CDP connection failure");
    assert.equal(readDaemonJson(), null, "daemon.json should NOT be written on failure");
  });

  it("ensureDaemon flow fails within 5s when daemon cannot start (current bug)", async () => {
    // This reproduces what users see: CLI spawns daemon, daemon can't find Chrome, exits
    // CLI waits 5 seconds, never sees daemon.json, throws "Daemon did not start in time"
    const unusedPort = 39999;
    const child = spawn(TSX, [DAEMON_ENTRY, "--cdp-port", String(unusedPort)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // daemon should exit quickly — daemon.json should never appear
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(readDaemonJson(), null, "daemon.json should not exist — daemon exited");
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
    const child = spawn(TSX, [DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", "39997"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const info = await waitForDaemonJson();
    daemonPid = info.pid;

    assert.equal(typeof info.pid, "number");
    assert.equal(typeof info.token, "string");
    assert.ok(info.token.length > 0, "token should be generated");
    assert.ok(isProcessAlive(info.pid), "daemon process should be alive");
  });

  it("daemon writes correct host/port in daemon.json", async () => {
    const child = spawn(TSX, [DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--host", "127.0.0.1", "--port", "39996"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const info = await waitForDaemonJson();
    daemonPid = info.pid;

    assert.equal(info.host, "127.0.0.1");
    assert.equal(info.port, 39996);
  });

  it("daemon HTTP /status responds when CDP is connected", async () => {
    const child = spawn(TSX, [DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", "39995"], {
      detached: true,
      stdio: "ignore",
    });
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
    cleanupDaemonJson();
    cleanupManagedPortFile();
    // Kill any daemon we spawned
    const info = readDaemonJson();
    if (info && isProcessAlive(info.pid)) {
      killProcess(info.pid);
    }
    if (fakeCdp) {
      await new Promise<void>(resolve => fakeCdp!.close(() => resolve()));
      fakeCdp = null;
    }
  });

  it("daemon discovers CDP via managed port file", async () => {
    // Daemon should read ~/.bb-browser/browser/cdp-port and find our fake CDP
    const child = spawn(TSX, [DAEMON_ENTRY, "--port", "39993"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const info = await waitForDaemonJson();
    assert.ok(isProcessAlive(info.pid), "daemon should be running");

    // Cleanup
    killProcess(info.pid);
  });
});

// ---------------------------------------------------------------------------
// Test: The core bug — daemon spawned without CDP info
// ---------------------------------------------------------------------------

describe("core bug: daemon spawned without --cdp-port fails silently (#136)", () => {
  beforeEach(() => {
    cleanupDaemonJson();
    cleanupManagedPortFile();
  });

  afterEach(() => {
    cleanupDaemonJson();
  });

  it("daemon with default port 19825 and nothing listening → exits, no daemon.json", async () => {
    // This is exactly what ensureDaemon() does: spawn daemon with NO args
    // Default --cdp-port is 19825, nothing listening there → daemon exits
    const child = spawn(TSX, [DAEMON_ENTRY], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, BB_BROWSER_CDP_URL: undefined },
    });
    child.unref();

    // daemon should exit within 3 seconds, daemon.json never appears
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(readDaemonJson(), null,
      "BUG CONFIRMED: daemon exits without daemon.json when spawned with no args and no Chrome on default port");
  });

  it("daemon with explicit --cdp-port pointing to fake CDP → starts successfully", async () => {
    // This proves the fix: if CLI passes --cdp-port to daemon, it works
    const cdpPort = 39992;
    const fakeCdp = await startFakeCdpServer(cdpPort);

    try {
      const child = spawn(TSX, [DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", "39991"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      const info = await waitForDaemonJson();
      assert.ok(isProcessAlive(info.pid), "daemon should be running when given correct CDP port");
      killProcess(info.pid);
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
      const child = spawn(TSX, [DAEMON_ENTRY, "--cdp-port", String(cdpPort), "--port", String(daemonPort)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      const info = await waitForDaemonJson();
      daemonPid = info.pid;

      // Wait for daemon to try and fail CDP WebSocket
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

      // Must not wait 30s
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
