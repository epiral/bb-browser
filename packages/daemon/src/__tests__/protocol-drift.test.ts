/**
 * Protocol Drift Tests — verify daemon HTTP responses match protocol.ts shapes.
 *
 * These tests start a real daemon, send HTTP commands, and check that response
 * shapes match the types defined in @bb-browser/shared (protocol.ts).
 *
 * Requirements:
 *   - Chrome running with --remote-debugging-port=<CDP_PORT>
 *   - Ports CDP_PORT and DAEMON_PORT must be free
 *
 * Run:
 *   pnpm test:drift
 *
 * All tests are skipped automatically when Chrome CDP is not reachable.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration — use non-standard ports to avoid conflicts
// ---------------------------------------------------------------------------

const CDP_PORT = Number(process.env.BB_TEST_CDP_PORT ?? 19222);
const DAEMON_PORT = Number(process.env.BB_TEST_DAEMON_PORT ?? 19899);
const TOKEN = "test-token-protocol-drift";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.resolve(__dirname, "../../dist/daemon.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isChromeAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function sendCommand(
  action: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ id: `drift-${Date.now()}`, action, ...params }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function getStatus(): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return res.json() as Promise<Record<string, unknown>>;
}

/** Wait until the daemon HTTP server is responding. */
async function waitForDaemon(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Daemon did not start within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Protocol drift tests (requires Chrome + daemon)", async () => {
  let daemon: ChildProcess | null = null;
  let chromeAvailable = false;

  before(async () => {
    chromeAvailable = await isChromeAvailable();
    if (!chromeAvailable) {
      console.log(
        `\n  ⚠ Chrome CDP not reachable at 127.0.0.1:${CDP_PORT} — all protocol drift tests will be skipped.\n` +
          `    To run these tests, start Chrome with: --remote-debugging-port=${CDP_PORT}\n`,
      );
      return;
    }

    // Spawn the daemon as a child process
    daemon = spawn(
      "node",
      [
        DAEMON_ENTRY,
        "--port",
        String(DAEMON_PORT),
        "--cdp-port",
        String(CDP_PORT),
        "--token",
        TOKEN,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    daemon.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log(`  [daemon] ${line}`);
    });

    daemon.on("error", (err) => {
      console.error(`  [daemon] spawn error: ${err.message}`);
    });

    await waitForDaemon();
  });

  after(async () => {
    if (daemon && !daemon.killed) {
      daemon.kill("SIGTERM");
      // Give it a moment to clean up
      await new Promise((r) => setTimeout(r, 500));
      if (!daemon.killed) daemon.kill("SIGKILL");
    }
  });

  // -------------------------------------------------------------------------
  // Helper: skip if Chrome is unavailable
  // -------------------------------------------------------------------------
  function skipIfNoChrome() {
    if (!chromeAvailable) {
      return true;
    }
    return false;
  }

  // =========================================================================
  // GET /status response shape
  // =========================================================================

  it("GET /status has correct shape", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const status = await getStatus();

    assert.equal(typeof status.running, "boolean", "running should be boolean");
    assert.equal(typeof status.cdpConnected, "boolean", "cdpConnected should be boolean");
    assert.ok(Array.isArray(status.tabs), "tabs should be an array");

    // Each tab entry shape
    if (Array.isArray(status.tabs) && status.tabs.length > 0) {
      const tab = status.tabs[0] as Record<string, unknown>;
      assert.equal(typeof tab.shortId, "string", "tab.shortId should be string");
      assert.equal(typeof tab.targetId, "string", "tab.targetId should be string");
      assert.equal(typeof tab.networkRequests, "number", "tab.networkRequests should be number");
      assert.equal(typeof tab.consoleMessages, "number", "tab.consoleMessages should be number");
      assert.equal(typeof tab.jsErrors, "number", "tab.jsErrors should be number");
      assert.equal(typeof tab.lastActionSeq, "number", "tab.lastActionSeq should be number");
    }
  });

  // =========================================================================
  // eval response shape
  // =========================================================================

  it("eval response has success, data.result, data.tab (string), data.seq (number)", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("eval", { script: "1 + 1" });

    assert.equal(res.success, true, "success should be true");
    const data = res.data as Record<string, unknown>;
    assert.ok(data !== undefined, "data should be present");
    assert.ok("result" in data, "data.result should exist");
    assert.equal(typeof data.tab, "string", "data.tab should be string");
    assert.equal(typeof data.seq, "number", "data.seq should be number");
  });

  // =========================================================================
  // open response shape
  // =========================================================================

  it("open response has data.tab, data.seq, data.url", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("open", { url: "about:blank" });

    assert.equal(res.success, true, "success should be true");
    const data = res.data as Record<string, unknown>;
    assert.equal(typeof data.tab, "string", "data.tab should be string");
    assert.equal(typeof data.seq, "number", "data.seq should be number");
    assert.equal(typeof data.url, "string", "data.url should be string");
  });

  // =========================================================================
  // tab_list response shape
  // =========================================================================

  it("tab_list response has data.tabs (array) with correct tab entries", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("tab_list");

    assert.equal(res.success, true, "success should be true");
    const data = res.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.tabs), "data.tabs should be an array");

    const tabs = data.tabs as Array<Record<string, unknown>>;
    assert.ok(tabs.length > 0, "should have at least one tab");

    for (const tab of tabs) {
      assert.equal(typeof tab.tab, "string", "tab.tab should be string (short ID)");
      assert.equal(typeof tab.url, "string", "tab.url should be string");
      assert.equal(typeof tab.title, "string", "tab.title should be string");
      assert.equal(typeof tab.index, "number", "tab.index should be number");
      assert.equal(typeof tab.active, "boolean", "tab.active should be boolean");
      // tabId can be string or number per protocol
      assert.ok(
        typeof tab.tabId === "string" || typeof tab.tabId === "number",
        "tab.tabId should be string or number",
      );
    }
  });

  // =========================================================================
  // snapshot response shape
  // =========================================================================

  it("snapshot response has data.snapshotData.snapshot (string)", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    // Open a page first so snapshot has content
    await sendCommand("open", { url: "data:text/html,<h1>drift test</h1>" });
    // Wait a moment for the page to load
    await sendCommand("wait", { ms: 500 });

    const res = await sendCommand("snapshot");

    assert.equal(res.success, true, "success should be true");
    const data = res.data as Record<string, unknown>;
    assert.ok(data.snapshotData !== undefined, "data.snapshotData should exist");

    const snapshotData = data.snapshotData as Record<string, unknown>;
    assert.equal(typeof snapshotData.snapshot, "string", "snapshotData.snapshot should be string");
    assert.equal(typeof data.tab, "string", "data.tab should be string");
  });

  // =========================================================================
  // network requests response shape
  // =========================================================================

  it("network requests response has data.networkRequests (array), data.cursor (number)", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("network", { networkCommand: "requests" });

    assert.equal(res.success, true, "success should be true");
    const data = res.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.networkRequests), "data.networkRequests should be an array");
    assert.equal(typeof data.cursor, "number", "data.cursor should be number");
    assert.equal(typeof data.tab, "string", "data.tab should be string");

    // If there are requests, verify entry shape
    const requests = data.networkRequests as Array<Record<string, unknown>>;
    if (requests.length > 0) {
      const req = requests[0];
      assert.equal(typeof req.url, "string", "request.url should be string");
      assert.equal(typeof req.method, "string", "request.method should be string");
      assert.equal(typeof req.type, "string", "request.type should be string");
      assert.equal(typeof req.timestamp, "number", "request.timestamp should be number");
    }
  });

  // =========================================================================
  // console get response shape
  // =========================================================================

  it("console get response has data.consoleMessages (array), data.cursor (number)", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("console", { consoleCommand: "get" });

    assert.equal(res.success, true, "success should be true");
    const data = res.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.consoleMessages), "data.consoleMessages should be an array");
    assert.equal(typeof data.cursor, "number", "data.cursor should be number");
    assert.equal(typeof data.tab, "string", "data.tab should be string");
  });

  // =========================================================================
  // errors get response shape
  // =========================================================================

  it("errors get response has data.jsErrors (array), data.cursor (number)", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("errors", { errorsCommand: "get" });

    assert.equal(res.success, true, "success should be true");
    const data = res.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.jsErrors), "data.jsErrors should be an array");
    assert.equal(typeof data.cursor, "number", "data.cursor should be number");
    assert.equal(typeof data.tab, "string", "data.tab should be string");
  });

  // =========================================================================
  // Type correctness: data.tab is always string, data.seq is always number
  // =========================================================================

  it("data.tab is always a string (not number) across multiple commands", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const commands = [
      sendCommand("eval", { script: "'hello'" }),
      sendCommand("snapshot"),
      sendCommand("network", { networkCommand: "requests" }),
      sendCommand("console", { consoleCommand: "get" }),
      sendCommand("errors", { errorsCommand: "get" }),
    ];

    const results = await Promise.all(commands);

    for (const res of results) {
      assert.equal(res.success, true, "command should succeed");
      const data = res.data as Record<string, unknown>;
      assert.equal(typeof data.tab, "string", `data.tab should be string, got ${typeof data.tab}`);
      assert.ok(typeof data.tab !== "number", "data.tab must not be a number");
    }
  });

  it("data.seq is always a number when present", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const commands = [
      sendCommand("eval", { script: "42" }),
      sendCommand("open", { url: "about:blank" }),
    ];

    const results = await Promise.all(commands);

    for (const res of results) {
      assert.equal(res.success, true);
      const data = res.data as Record<string, unknown>;
      if ("seq" in data) {
        assert.equal(typeof data.seq, "number", "data.seq should be number");
      }
    }
  });

  it("data.cursor is always a number when present", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const commands = [
      sendCommand("network", { networkCommand: "requests" }),
      sendCommand("console", { consoleCommand: "get" }),
      sendCommand("errors", { errorsCommand: "get" }),
    ];

    const results = await Promise.all(commands);

    for (const res of results) {
      assert.equal(res.success, true);
      const data = res.data as Record<string, unknown>;
      assert.equal(typeof data.cursor, "number", "data.cursor should be number");
    }
  });

  // =========================================================================
  // Error response shape
  // =========================================================================

  it("error response has success: false and error (string)", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("eval", { /* missing script */ });

    assert.equal(res.success, false, "success should be false");
    assert.equal(typeof res.error, "string", "error should be a string");
  });

  // =========================================================================
  // tabs[].tab is a string in tab_list
  // =========================================================================

  it("tabs[].tab in tab_list is always a string", { skip: false }, async (t) => {
    if (skipIfNoChrome()) { t.skip("Chrome CDP not available"); return; }

    const res = await sendCommand("tab_list");
    assert.equal(res.success, true);

    const data = res.data as Record<string, unknown>;
    const tabs = data.tabs as Array<Record<string, unknown>>;

    for (const tab of tabs) {
      assert.equal(typeof tab.tab, "string", `tab.tab should be string, got ${typeof tab.tab}: ${tab.tab}`);
    }
  });

  // =========================================================================
  // Cleanup: close tabs we opened during testing
  // =========================================================================

  after(async () => {
    if (!chromeAvailable) return;

    try {
      // Get list of tabs and close any about:blank / data: tabs we created
      const res = await sendCommand("tab_list");
      if (res.success) {
        const data = res.data as Record<string, unknown>;
        const tabs = data.tabs as Array<Record<string, unknown>>;
        for (const tab of tabs) {
          const url = tab.url as string;
          if (url === "about:blank" || url.startsWith("data:")) {
            await sendCommand("tab_close", { tabId: tab.tab }).catch(() => {});
          }
        }
      }
    } catch {
      // Best effort cleanup
    }
  });
});
