/**
 * Contract / invariant tests for daemon state management.
 *
 * These tests verify protocol invariants using TabStateManager and TabState
 * directly, without requiring a real Chrome browser or WebSocket connection.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TabStateManager, type TabState } from "../tab-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addFakeNetworkRequest(
  tab: TabState,
  id: string,
  url = `https://example.com/${id}`,
): void {
  tab.addNetworkRequest(id, {
    url,
    method: "GET",
    type: "Document",
    timestamp: Date.now(),
  });
}

function addFakeConsoleMessage(tab: TabState, text: string): void {
  tab.addConsoleMessage({
    type: "log",
    text,
    timestamp: Date.now(),
  });
}

function addFakeJSError(tab: TabState, message: string): void {
  tab.addJSError({
    message,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TabStateManager + TabState contract tests", () => {
  let manager: TabStateManager;

  beforeEach(() => {
    manager = new TabStateManager();
  });

  // -------------------------------------------------------------------------
  // INV-1: Operations produce seq
  // -------------------------------------------------------------------------
  describe("INV-1: Operations produce seq", () => {
    it("recordAction returns a positive number", () => {
      const tab = manager.addTab("target-aaa");
      const seq = tab.recordAction();
      assert.ok(seq > 0, `Expected seq > 0, got ${seq}`);
    });

    it("successive recordAction calls produce increasing seq", () => {
      const tab = manager.addTab("target-bbb");
      const seq1 = tab.recordAction();
      const seq2 = tab.recordAction();
      assert.ok(seq2 > seq1, `Expected ${seq2} > ${seq1}`);
    });

    it("addNetworkRequest assigns a seq to each entry", () => {
      const tab = manager.addTab("target-ccc");
      addFakeNetworkRequest(tab, "req-1");
      const items = tab.getNetworkRequests().items;
      assert.equal(items.length, 1);
      assert.ok(items[0].seq > 0);
    });
  });

  // -------------------------------------------------------------------------
  // INV-3: Invalid tab ID errors
  // -------------------------------------------------------------------------
  describe("INV-3: Invalid tab ID errors", () => {
    it("resolveShortId returns undefined for unknown short ID", () => {
      manager.addTab("target-ddd");
      const result = manager.resolveShortId("xxxx");
      assert.equal(result, undefined);
    });

    it("getTab returns undefined for unknown targetId", () => {
      const result = manager.getTab("nonexistent-target");
      assert.equal(result, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // INV-4: seq monotonically increases
  // -------------------------------------------------------------------------
  describe("INV-4: seq monotonically increases", () => {
    it("interleaved recordAction and addNetworkRequest produce strictly increasing seqs", () => {
      const tab = manager.addTab("target-eee");

      const seqs: number[] = [];

      // action -> network -> action -> network -> network -> action
      seqs.push(tab.recordAction());
      addFakeNetworkRequest(tab, "req-1");
      seqs.push(tab.getNetworkRequests().items.at(-1)!.seq);

      seqs.push(tab.recordAction());
      addFakeNetworkRequest(tab, "req-2");
      seqs.push(tab.getNetworkRequests().items.at(-1)!.seq);

      addFakeNetworkRequest(tab, "req-3");
      seqs.push(tab.getNetworkRequests().items.at(-1)!.seq);

      seqs.push(tab.recordAction());

      for (let i = 1; i < seqs.length; i++) {
        assert.ok(
          seqs[i] > seqs[i - 1],
          `seq[${i}]=${seqs[i]} should be > seq[${i - 1}]=${seqs[i - 1]}`,
        );
      }
    });

    it("console and error events also get increasing seqs", () => {
      const tab = manager.addTab("target-fff");

      tab.recordAction();
      addFakeConsoleMessage(tab, "hello");
      addFakeJSError(tab, "boom");
      addFakeNetworkRequest(tab, "req-1");

      const networkSeq = tab.getNetworkRequests().items[0].seq;
      const consoleSeq = tab.getConsoleMessages().items[0].seq;
      const errorSeq = tab.getJSErrors().items[0].seq;
      const actionSeq = tab.lastActionSeq;

      const allSeqs = [actionSeq, consoleSeq, errorSeq, networkSeq];
      for (let i = 1; i < allSeqs.length; i++) {
        assert.ok(
          allSeqs[i] > allSeqs[i - 1],
          `allSeqs[${i}]=${allSeqs[i]} should be > allSeqs[${i - 1}]=${allSeqs[i - 1]}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // INV-5: Per-tab isolation
  // -------------------------------------------------------------------------
  describe("INV-5: Per-tab isolation", () => {
    it("network events added to tab A are not visible in tab B", () => {
      const tabA = manager.addTab("target-aaa-111");
      const tabB = manager.addTab("target-bbb-222");

      addFakeNetworkRequest(tabA, "req-a1");
      addFakeNetworkRequest(tabA, "req-a2");

      const aItems = tabA.getNetworkRequests().items;
      const bItems = tabB.getNetworkRequests().items;

      assert.equal(aItems.length, 2);
      assert.equal(bItems.length, 0);
    });

    it("console messages are isolated per tab", () => {
      const tabA = manager.addTab("target-aaa-333");
      const tabB = manager.addTab("target-bbb-444");

      addFakeConsoleMessage(tabA, "from A");

      assert.equal(tabA.getConsoleMessages().items.length, 1);
      assert.equal(tabB.getConsoleMessages().items.length, 0);
    });

    it("JS errors are isolated per tab", () => {
      const tabA = manager.addTab("target-aaa-555");
      const tabB = manager.addTab("target-bbb-666");

      addFakeJSError(tabA, "error in A");

      assert.equal(tabA.getJSErrors().items.length, 1);
      assert.equal(tabB.getJSErrors().items.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // INV-6: Tab close clears state
  // -------------------------------------------------------------------------
  describe("INV-6: Tab close clears state", () => {
    it("removeTab clears the tab from manager lookups", () => {
      const tab = manager.addTab("target-ggg");
      const shortId = tab.shortId;

      addFakeNetworkRequest(tab, "req-1");
      addFakeConsoleMessage(tab, "hello");

      assert.ok(manager.getTab("target-ggg") !== undefined);
      assert.ok(manager.resolveShortId(shortId) !== undefined);

      manager.removeTab("target-ggg");

      assert.equal(manager.getTab("target-ggg"), undefined);
      assert.equal(manager.resolveShortId(shortId), undefined);
    });

    it("tabCount decreases after removeTab", () => {
      manager.addTab("target-hhh");
      manager.addTab("target-iii");
      assert.equal(manager.tabCount, 2);

      manager.removeTab("target-hhh");
      assert.equal(manager.tabCount, 1);
    });

    it("removing a non-existent tab is a no-op", () => {
      manager.addTab("target-jjj");
      manager.removeTab("no-such-target");
      assert.equal(manager.tabCount, 1);
    });
  });

  // -------------------------------------------------------------------------
  // INV-7: tab_new with zero tabs
  // -------------------------------------------------------------------------
  describe("INV-7: tab_new with zero tabs", () => {
    it("addTab works on an empty manager", () => {
      assert.equal(manager.tabCount, 0);
      const tab = manager.addTab("brand-new-target");
      assert.equal(manager.tabCount, 1);
      assert.ok(tab.shortId.length > 0);
    });

    it("short ID is generated correctly for first tab", () => {
      const tab = manager.addTab("ABCDEF1234");
      // Short ID should be the last 4 chars, lowercased
      assert.equal(tab.shortId, "1234");
    });
  });

  // -------------------------------------------------------------------------
  // INV-2: Cursor in observation queries
  // -------------------------------------------------------------------------
  describe("INV-2: Cursor in observation queries", () => {
    it("getNetworkRequests returns cursor = max seq of results", () => {
      const tab = manager.addTab("target-kkk");

      addFakeNetworkRequest(tab, "req-1");
      addFakeNetworkRequest(tab, "req-2");
      addFakeNetworkRequest(tab, "req-3");

      const result = tab.getNetworkRequests();
      assert.equal(result.items.length, 3);
      assert.equal(result.cursor, Math.max(...result.items.map((i) => i.seq)));
    });

    it("getNetworkRequests with since returns cursor of filtered subset", () => {
      const tab = manager.addTab("target-lll");

      addFakeNetworkRequest(tab, "req-1");
      addFakeNetworkRequest(tab, "req-2");

      const allResult = tab.getNetworkRequests();
      const sinceSeq = allResult.items[0].seq;

      addFakeNetworkRequest(tab, "req-3");

      const filtered = tab.getNetworkRequests({ since: sinceSeq });
      assert.equal(filtered.items.length, 2); // req-2 and req-3
      assert.equal(filtered.cursor, Math.max(...filtered.items.map((i) => i.seq)));
      assert.ok(filtered.cursor > sinceSeq);
    });

    it("getNetworkRequests with no results returns cursor = 0", () => {
      const tab = manager.addTab("target-mmm");
      const result = tab.getNetworkRequests({ filter: "nonexistent" });
      assert.equal(result.items.length, 0);
      assert.equal(result.cursor, 0);
    });

    it("getConsoleMessages returns correct cursor", () => {
      const tab = manager.addTab("target-nnn");
      addFakeConsoleMessage(tab, "msg-1");
      addFakeConsoleMessage(tab, "msg-2");

      const result = tab.getConsoleMessages();
      assert.equal(result.items.length, 2);
      assert.equal(result.cursor, Math.max(...result.items.map((i) => i.seq)));
    });

    it("getJSErrors returns correct cursor", () => {
      const tab = manager.addTab("target-ooo");
      addFakeJSError(tab, "err-1");
      addFakeJSError(tab, "err-2");

      const result = tab.getJSErrors();
      assert.equal(result.items.length, 2);
      assert.equal(result.cursor, Math.max(...result.items.map((i) => i.seq)));
    });
  });

  // -------------------------------------------------------------------------
  // Incremental query contract
  // -------------------------------------------------------------------------
  describe("Incremental query contract", () => {
    it("since: last_action returns only events after the last action", () => {
      const tab = manager.addTab("target-ppp");

      // Add some network events before action
      addFakeNetworkRequest(tab, "req-before-1", "https://example.com/before1");
      addFakeNetworkRequest(tab, "req-before-2", "https://example.com/before2");

      // Perform an action
      tab.recordAction();

      // Add network events after action
      addFakeNetworkRequest(tab, "req-after-1", "https://example.com/after1");
      addFakeNetworkRequest(tab, "req-after-2", "https://example.com/after2");

      const result = tab.getNetworkRequests({ since: "last_action" });
      assert.equal(result.items.length, 2);
      assert.ok(result.items.every((i) => i.url.includes("after")));
    });

    it("since: last_action works for console messages", () => {
      const tab = manager.addTab("target-qqq");

      addFakeConsoleMessage(tab, "before");
      tab.recordAction();
      addFakeConsoleMessage(tab, "after");

      const result = tab.getConsoleMessages({ since: "last_action" });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].text, "after");
    });

    it("since: last_action works for JS errors", () => {
      const tab = manager.addTab("target-rrr");

      addFakeJSError(tab, "old error");
      tab.recordAction();
      addFakeJSError(tab, "new error");

      const result = tab.getJSErrors({ since: "last_action" });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].message, "new error");
    });

    it("cursor reflects the filtered set after incremental query", () => {
      const tab = manager.addTab("target-sss");

      addFakeNetworkRequest(tab, "req-1");
      const firstCursor = tab.getNetworkRequests().cursor;

      tab.recordAction();

      addFakeNetworkRequest(tab, "req-2");
      addFakeNetworkRequest(tab, "req-3");

      const incremental = tab.getNetworkRequests({ since: "last_action" });
      assert.equal(incremental.items.length, 2);
      assert.ok(incremental.cursor > firstCursor);
    });

    it("numeric since value filters correctly", () => {
      const tab = manager.addTab("target-ttt");

      addFakeNetworkRequest(tab, "req-1");
      addFakeNetworkRequest(tab, "req-2");
      addFakeNetworkRequest(tab, "req-3");

      const allItems = tab.getNetworkRequests().items;
      const since = allItems[1].seq; // seq of req-2

      const result = tab.getNetworkRequests({ since });
      assert.equal(result.items.length, 1); // only req-3
      assert.ok(result.items[0].seq > since);
    });
  });

  // -------------------------------------------------------------------------
  // Short ID stability
  // -------------------------------------------------------------------------
  describe("Short ID stability", () => {
    it("same targetId always generates same short ID within a session", () => {
      const tab1 = manager.addTab("target-uuu-abcd");
      const shortId1 = tab1.shortId;

      // addTab with the same targetId returns the existing TabState
      const tab2 = manager.addTab("target-uuu-abcd");
      assert.equal(tab2.shortId, shortId1);
      assert.strictEqual(tab1, tab2);
    });

    it("different targetIds generate different short IDs", () => {
      const tabA = manager.addTab("target-vvv-1111");
      const tabB = manager.addTab("target-www-2222");
      assert.notEqual(tabA.shortId, tabB.shortId);
    });

    it("short ID collision is resolved by extending length", () => {
      // Two targets whose last 4 chars are the same
      const tabA = manager.addTab("aaaa-xxxx-abcd");
      const tabB = manager.addTab("bbbb-yyyy-abcd");
      assert.notEqual(tabA.shortId, tabB.shortId);
      // First one gets the short version, second gets a longer one
      assert.equal(tabA.shortId, "abcd");
      assert.ok(tabB.shortId.length > 4);
    });

    it("resolveShortId maps back to the correct targetId", () => {
      const tab = manager.addTab("target-zzz-9876");
      const resolved = manager.resolveShortId(tab.shortId);
      assert.equal(resolved, "target-zzz-9876");
    });
  });

  // -------------------------------------------------------------------------
  // Query filtering contracts
  // -------------------------------------------------------------------------
  describe("Query filtering contracts", () => {
    it("filter narrows network requests by URL substring", () => {
      const tab = manager.addTab("target-filter-1");
      addFakeNetworkRequest(tab, "req-1", "https://api.example.com/users");
      addFakeNetworkRequest(tab, "req-2", "https://cdn.example.com/image.png");
      addFakeNetworkRequest(tab, "req-3", "https://api.example.com/posts");

      const result = tab.getNetworkRequests({ filter: "api.example.com" });
      assert.equal(result.items.length, 2);
    });

    it("method filter works (case-insensitive)", () => {
      const tab = manager.addTab("target-filter-2");
      tab.addNetworkRequest("req-1", {
        url: "https://example.com/a",
        method: "GET",
        type: "XHR",
        timestamp: Date.now(),
      });
      tab.addNetworkRequest("req-2", {
        url: "https://example.com/b",
        method: "POST",
        type: "XHR",
        timestamp: Date.now(),
      });

      const result = tab.getNetworkRequests({ method: "post" });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].method, "POST");
    });

    it("limit returns the last N items", () => {
      const tab = manager.addTab("target-filter-3");
      for (let i = 0; i < 10; i++) {
        addFakeNetworkRequest(tab, `req-${i}`);
      }

      const result = tab.getNetworkRequests({ limit: 3 });
      assert.equal(result.items.length, 3);
      // Should be the last 3
      assert.ok(result.items[0].url.includes("req-7"));
      assert.ok(result.items[1].url.includes("req-8"));
      assert.ok(result.items[2].url.includes("req-9"));
    });

    it("console filter narrows by text substring", () => {
      const tab = manager.addTab("target-filter-4");
      addFakeConsoleMessage(tab, "Loading page...");
      addFakeConsoleMessage(tab, "Error: 404 not found");
      addFakeConsoleMessage(tab, "Page loaded");

      const result = tab.getConsoleMessages({ filter: "Error" });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].text, "Error: 404 not found");
    });

    it("error filter matches message or URL", () => {
      const tab = manager.addTab("target-filter-5");
      tab.addJSError({
        message: "TypeError: x is undefined",
        url: "https://example.com/app.js",
        timestamp: Date.now(),
      });
      tab.addJSError({
        message: "RangeError: out of bounds",
        url: "https://example.com/lib.js",
        timestamp: Date.now(),
      });

      const byMessage = tab.getJSErrors({ filter: "TypeError" });
      assert.equal(byMessage.items.length, 1);

      const byUrl = tab.getJSErrors({ filter: "lib.js" });
      assert.equal(byUrl.items.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Clear operations
  // -------------------------------------------------------------------------
  describe("Clear operations", () => {
    it("clearNetwork empties network requests", () => {
      const tab = manager.addTab("target-clear-1");
      addFakeNetworkRequest(tab, "req-1");
      addFakeNetworkRequest(tab, "req-2");
      assert.equal(tab.getNetworkRequests().items.length, 2);

      tab.clearNetwork();
      assert.equal(tab.getNetworkRequests().items.length, 0);
    });

    it("clearConsole empties console messages", () => {
      const tab = manager.addTab("target-clear-2");
      addFakeConsoleMessage(tab, "msg-1");
      assert.equal(tab.getConsoleMessages().items.length, 1);

      tab.clearConsole();
      assert.equal(tab.getConsoleMessages().items.length, 0);
    });

    it("clearErrors empties JS errors", () => {
      const tab = manager.addTab("target-clear-3");
      addFakeJSError(tab, "err-1");
      assert.equal(tab.getJSErrors().items.length, 1);

      tab.clearErrors();
      assert.equal(tab.getJSErrors().items.length, 0);
    });

    it("global seq continues to increase after clear", () => {
      const tab = manager.addTab("target-clear-4");
      addFakeNetworkRequest(tab, "req-1");
      const seqBefore = tab.getNetworkRequests().cursor;

      tab.clearNetwork();
      addFakeNetworkRequest(tab, "req-2");

      const seqAfter = tab.getNetworkRequests().cursor;
      assert.ok(seqAfter > seqBefore, `seq should keep increasing after clear`);
    });
  });

  // -------------------------------------------------------------------------
  // Network response update contract
  // -------------------------------------------------------------------------
  describe("Network response update contract", () => {
    it("updateNetworkResponse attaches status to existing request", () => {
      const tab = manager.addTab("target-resp-1");
      tab.addNetworkRequest("req-1", {
        url: "https://example.com",
        method: "GET",
        type: "Document",
        timestamp: Date.now(),
      });

      tab.updateNetworkResponse("req-1", {
        status: 200,
        statusText: "OK",
        mimeType: "text/html",
      });

      const items = tab.getNetworkRequests().items;
      assert.equal(items[0].status, 200);
      assert.equal(items[0].statusText, "OK");
      assert.equal(items[0].mimeType, "text/html");
    });

    it("updateNetworkFailure marks request as failed", () => {
      const tab = manager.addTab("target-resp-2");
      tab.addNetworkRequest("req-1", {
        url: "https://example.com",
        method: "GET",
        type: "Document",
        timestamp: Date.now(),
      });

      tab.updateNetworkFailure("req-1", "net::ERR_CONNECTION_REFUSED");

      const items = tab.getNetworkRequests().items;
      assert.equal(items[0].failed, true);
      assert.equal(items[0].failureReason, "net::ERR_CONNECTION_REFUSED");
    });

    it("updateNetworkResponse for unknown requestId is a no-op", () => {
      const tab = manager.addTab("target-resp-3");
      // Should not throw
      tab.updateNetworkResponse("unknown-id", { status: 404 });
      tab.updateNetworkFailure("unknown-id", "some error");
    });

    it("status filter works with numeric and range filters", () => {
      const tab = manager.addTab("target-resp-4");
      tab.addNetworkRequest("req-1", {
        url: "https://example.com/ok",
        method: "GET",
        type: "XHR",
        timestamp: Date.now(),
      });
      tab.updateNetworkResponse("req-1", { status: 200 });

      tab.addNetworkRequest("req-2", {
        url: "https://example.com/notfound",
        method: "GET",
        type: "XHR",
        timestamp: Date.now(),
      });
      tab.updateNetworkResponse("req-2", { status: 404 });

      tab.addNetworkRequest("req-3", {
        url: "https://example.com/error",
        method: "GET",
        type: "XHR",
        timestamp: Date.now(),
      });
      tab.updateNetworkResponse("req-3", { status: 500 });

      const by4xx = tab.getNetworkRequests({ status: "4xx" });
      assert.equal(by4xx.items.length, 1);
      assert.equal(by4xx.items[0].status, 404);

      const by5xx = tab.getNetworkRequests({ status: "5xx" });
      assert.equal(by5xx.items.length, 1);
      assert.equal(by5xx.items[0].status, 500);

      const by200 = tab.getNetworkRequests({ status: "200" });
      assert.equal(by200.items.length, 1);
      assert.equal(by200.items[0].status, 200);
    });
  });

  // -------------------------------------------------------------------------
  // allTabs / tabCount contract
  // -------------------------------------------------------------------------
  describe("allTabs / tabCount contract", () => {
    it("allTabs returns all registered tabs", () => {
      manager.addTab("t1");
      manager.addTab("t2");
      manager.addTab("t3");

      const all = manager.allTabs();
      assert.equal(all.length, 3);
    });

    it("tabCount reflects adds and removes", () => {
      assert.equal(manager.tabCount, 0);
      manager.addTab("t1");
      assert.equal(manager.tabCount, 1);
      manager.addTab("t2");
      assert.equal(manager.tabCount, 2);
      manager.removeTab("t1");
      assert.equal(manager.tabCount, 1);
      manager.removeTab("t2");
      assert.equal(manager.tabCount, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Global seq is shared across tabs
  // -------------------------------------------------------------------------
  describe("Global seq shared across tabs", () => {
    it("actions on different tabs share the same monotonic seq", () => {
      const tabA = manager.addTab("tab-global-a");
      const tabB = manager.addTab("tab-global-b");

      const s1 = tabA.recordAction();
      const s2 = tabB.recordAction();
      const s3 = tabA.recordAction();

      assert.ok(s2 > s1);
      assert.ok(s3 > s2);
    });

    it("events across tabs have globally unique seqs", () => {
      const tabA = manager.addTab("tab-cross-a");
      const tabB = manager.addTab("tab-cross-b");

      addFakeNetworkRequest(tabA, "req-a1");
      addFakeNetworkRequest(tabB, "req-b1");
      addFakeNetworkRequest(tabA, "req-a2");

      const seqsA = tabA.getNetworkRequests().items.map((i) => i.seq);
      const seqsB = tabB.getNetworkRequests().items.map((i) => i.seq);
      const allSeqs = [...seqsA, ...seqsB].sort((a, b) => a - b);

      // All unique
      const unique = new Set(allSeqs);
      assert.equal(unique.size, allSeqs.length);

      // All strictly increasing
      for (let i = 1; i < allSeqs.length; i++) {
        assert.ok(allSeqs[i] > allSeqs[i - 1]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// daemon.json PID strategy tests
// ---------------------------------------------------------------------------

/**
 * Mirrors the isProcessAlive helper from @bb-browser/cli daemon-manager.
 * Uses signal 0 which doesn't actually send a signal — just checks existence.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("daemon.json PID strategy", () => {
  const testDir = path.join(os.tmpdir(), "bb-browser-test-" + process.pid);
  const testDaemonJson = path.join(testDir, "daemon.json");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    if (existsSync(testDaemonJson)) {
      unlinkSync(testDaemonJson);
    }
  });

  it("stale daemon.json with dead PID is detected", () => {
    // Write a daemon.json with a PID that doesn't exist (e.g., 999999)
    const stalePid = 999999;
    const info = { pid: stalePid, host: "127.0.0.1", port: 19824, token: "stale-token" };
    writeFileSync(testDaemonJson, JSON.stringify(info));

    // Read it back and verify the PID liveness check detects it as dead
    const raw = JSON.parse(
      readFileSync(testDaemonJson, "utf8"),
    );
    assert.equal(raw.pid, stalePid);
    assert.equal(isProcessAlive(raw.pid), false, "Dead PID should be detected as not alive");
  });

  it("daemon.json with alive PID is accepted", () => {
    // Write daemon.json with process.pid (current process, definitely alive)
    const info = { pid: process.pid, host: "127.0.0.1", port: 19824, token: "alive-token" };
    writeFileSync(testDaemonJson, JSON.stringify(info));

    const raw = JSON.parse(
      readFileSync(testDaemonJson, "utf8"),
    );
    assert.equal(raw.pid, process.pid);
    assert.equal(isProcessAlive(raw.pid), true, "Current process PID should be detected as alive");
  });

  it("daemon.json contains all required fields", () => {
    const info = { pid: 12345, host: "127.0.0.1", port: 19824, token: "test-token-abc" };
    writeFileSync(testDaemonJson, JSON.stringify(info));

    const raw = JSON.parse(
      readFileSync(testDaemonJson, "utf8"),
    );
    assert.equal(typeof raw.pid, "number");
    assert.equal(typeof raw.host, "string");
    assert.equal(typeof raw.port, "number");
    assert.equal(typeof raw.token, "string");
  });
});
