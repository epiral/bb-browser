/**
 * Daemon lifecycle integration tests — daemon.json + HTTP server.
 *
 * These tests verify the daemon.json file lifecycle WITHOUT requiring Chrome.
 * Each test uses unique ports to avoid EADDRINUSE conflicts.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use isolated temp dir to avoid conflicts with parallel test suites
const TEST_HOME = path.join(os.tmpdir(), `bb-browser-test-lifecycle-${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });
process.env.BB_BROWSER_HOME = TEST_HOME;
const DAEMON_JSON = path.join(TEST_HOME, "daemon.json");

// Each test gets unique ports to avoid EADDRINUSE
let portCounter = 49800;
function nextPorts(): { daemonPort: number; cdpPort: number } {
  const daemonPort = portCounter++;
  const cdpPort = portCounter++;
  return { daemonPort, cdpPort };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTsx(): string {
  const candidates = [
    path.resolve(__dirname, "../../../../node_modules/.bin/tsx"),
    path.resolve(__dirname, "../../../node_modules/.bin/tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "tsx";
}

function startFakeCdp(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === "/json/version" && req.method === "GET") {
        const body = JSON.stringify({
          Browser: "FakeChrome/0.0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function stopFakeCdp(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function spawnDaemon(port: number, cdpPort: number): ChildProcess {
  const sourceEntry = path.resolve(__dirname, "../index.ts");
  return spawn(
    findTsx(),
    [sourceEntry, "--port", String(port), "--cdp-port", String(cdpPort)],
    { stdio: "pipe", env: { ...process.env } },
  );
}

async function waitForDaemonJson(timeoutMs = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(DAEMON_JSON, "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("daemon.json not created in time");
}

async function waitForStatus(
  host: string, port: number, token: string, timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("daemon /status not reachable in time");
}

function killDaemon(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) { resolve(); return; }
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
    child.on("exit", () => clearTimeout(timer));
  });
}

async function cleanupDaemonJson(): Promise<void> {
  try { await unlink(DAEMON_JSON); } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon lifecycle (no Chrome needed)", () => {
  let daemon: ChildProcess | null = null;
  let fakeCdp: Server | null = null;

  afterEach(async () => {
    // Kill the actual daemon process (from daemon.json PID, not tsx wrapper PID)
    try {
      const raw = await readFile(DAEMON_JSON, "utf8");
      const info = JSON.parse(raw);
      if (info.pid) {
        try { process.kill(info.pid, "SIGKILL"); } catch {}
      }
    } catch {}

    // Also kill the tsx wrapper
    if (daemon && !daemon.killed && daemon.exitCode === null) {
      await killDaemon(daemon);
    }
    daemon = null;
    if (fakeCdp) {
      await stopFakeCdp(fakeCdp);
      fakeCdp = null;
    }
    await cleanupDaemonJson();
    // Wait for ports to release
    await new Promise((r) => setTimeout(r, 500));
  });

  it("writes daemon.json on startup with pid/host/port/token", async () => {
    const { daemonPort, cdpPort } = nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);

    const info = await waitForDaemonJson();

    assert.equal(typeof info.pid, "number");
    assert.equal(typeof info.host, "string");
    assert.equal(info.port, daemonPort);
    assert.equal(typeof info.token, "string");
    assert.ok((info.token as string).length > 0);
    // Note: daemon.pid is tsx wrapper PID, info.pid is the actual daemon PID
    assert.ok(info.pid as number > 0, "daemon PID should be positive");
  });

  it("GET /status returns running: true", async () => {
    const { daemonPort, cdpPort } = nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);

    const info = await waitForDaemonJson();
    const status = await waitForStatus(
      info.host as string, info.port as number, info.token as string,
    );

    assert.equal(status.running, true);
    assert.equal(typeof status.uptime, "number");
  });

  it("daemon.json is deleted on graceful shutdown (SIGTERM)", async () => {
    const { daemonPort, cdpPort } = nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);
    await waitForDaemonJson();

    assert.ok(existsSync(DAEMON_JSON));

    await killDaemon(daemon);
    daemon = null;
    await new Promise((r) => setTimeout(r, 500));

    assert.ok(!existsSync(DAEMON_JSON), "daemon.json should be deleted after graceful shutdown");
  });

  it("stale daemon.json survives kill -9", async () => {
    const { daemonPort, cdpPort } = nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);
    const info = await waitForDaemonJson();
    const oldPid = info.pid;

    // Kill the actual daemon PID (not tsx wrapper)
    try { process.kill(oldPid as number, "SIGKILL"); } catch {}
    daemon.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1000));
    daemon = null;

    assert.ok(existsSync(DAEMON_JSON), "daemon.json should survive SIGKILL");
    const staleInfo = JSON.parse(await readFile(DAEMON_JSON, "utf8"));
    assert.equal(staleInfo.pid, oldPid);
  });

  it("new daemon after kill -9 gets new PID and token", async () => {
    const ports1 = nextPorts();
    const ports2 = nextPorts(); // completely separate ports for second daemon
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(ports1.cdpPort);

    // First daemon
    daemon = spawnDaemon(ports1.daemonPort, ports1.cdpPort);
    const info1 = await waitForDaemonJson();
    const pid1 = info1.pid;
    const token1 = info1.token;

    // Force kill the actual daemon process
    try { process.kill(pid1 as number, "SIGKILL"); } catch {}
    daemon.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
    daemon = null;

    assert.ok(existsSync(DAEMON_JSON));

    // Stop old fake CDP server and wait for port release
    await stopFakeCdp(fakeCdp);
    await new Promise((r) => setTimeout(r, 500));

    // Start new fake CDP on different port
    fakeCdp = await startFakeCdp(ports2.cdpPort);

    // Delete stale daemon.json so waitForDaemonJson detects the NEW one
    await cleanupDaemonJson();

    // Second daemon on completely new ports
    daemon = spawnDaemon(ports2.daemonPort, ports2.cdpPort);
    const info2 = await waitForDaemonJson();

    assert.notEqual(info2.pid, pid1, "new daemon should have different PID");
    assert.notEqual(info2.token, token1, "new daemon should have different token");
    assert.equal(info2.port, ports2.daemonPort);
  });
});
