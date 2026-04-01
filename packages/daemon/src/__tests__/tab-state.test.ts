import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TabState, TabStateManager } from "../tab-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(): TabStateManager {
  return new TabStateManager();
}

function makeTab(manager: TabStateManager, targetId = "ABCDEFGH1234"): TabState {
  return manager.addTab(targetId);
}

function addNetworkRequest(
  tab: TabState,
  overrides: Partial<{ requestId: string; url: string; method: string; type: string; status: number }> = {},
): string {
  const reqId = overrides.requestId ?? `req-${Math.random().toString(36).slice(2, 8)}`;
  tab.addNetworkRequest(reqId, {
    url: overrides.url ?? "https://example.com/api",
    method: overrides.method ?? "GET",
    type: overrides.type ?? "XHR",
    timestamp: Date.now(),
    status: overrides.status,
  });
  return reqId;
}

// ---------------------------------------------------------------------------
// TabStateManager
// ---------------------------------------------------------------------------

describe("TabStateManager", () => {
  describe("addTab short ID generation", () => {
    it("generates 4-char short ID from last 4 chars of targetId", () => {
      const mgr = makeManager();
      const tab = mgr.addTab("ABCDEFGH1234");
      assert.equal(tab.shortId, "1234");
    });

    it("lowercases the short ID", () => {
      const mgr = makeManager();
      const tab = mgr.addTab("ABCDEFGHWXYZ");
      assert.equal(tab.shortId, "wxyz");
    });

    it("extends to 5+ chars on collision", () => {
      const mgr = makeManager();
      const tab1 = mgr.addTab("AAAA_ABCD");
      const tab2 = mgr.addTab("BBBB_ABCD");
      assert.equal(tab1.shortId, "abcd");
      // tab2 must have a longer shortId since "abcd" is taken
      assert.ok(tab2.shortId.length >= 5, `expected >= 5 chars, got "${tab2.shortId}" (${tab2.shortId.length})`);
      assert.notEqual(tab1.shortId, tab2.shortId);
    });
  });

  describe("removeTab", () => {
    it("releases short ID for reuse", () => {
      const mgr = makeManager();
      const tab1 = mgr.addTab("AAAA_ABCD");
      const shortId1 = tab1.shortId;
      mgr.removeTab("AAAA_ABCD");

      const tab2 = mgr.addTab("BBBB_ABCD");
      // After removal, "abcd" should be available again
      assert.equal(tab2.shortId, shortId1);
    });
  });

  describe("resolveShortId", () => {
    it("maps short ID back to full targetId", () => {
      const mgr = makeManager();
      mgr.addTab("TARGET_XY99");
      assert.equal(mgr.resolveShortId("xy99"), "TARGET_XY99");
    });

    it("returns undefined for unknown short ID", () => {
      const mgr = makeManager();
      assert.equal(mgr.resolveShortId("nope"), undefined);
    });
  });

  describe("nextSeq", () => {
    it("is monotonically increasing", () => {
      const mgr = makeManager();
      const a = mgr.nextSeq();
      const b = mgr.nextSeq();
      const c = mgr.nextSeq();
      assert.ok(a < b);
      assert.ok(b < c);
    });
  });

  describe("addTab idempotency", () => {
    it("returns existing tab when called with same targetId twice", () => {
      const mgr = makeManager();
      const tab1 = mgr.addTab("SAME_ID");
      const tab2 = mgr.addTab("SAME_ID");
      assert.equal(tab1, tab2);
    });
  });
});

// ---------------------------------------------------------------------------
// TabState
// ---------------------------------------------------------------------------

describe("TabState", () => {
  describe("recordAction", () => {
    it("increments seq and sets lastActionSeq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      assert.equal(tab.lastActionSeq, 0);
      const seq = tab.recordAction();
      assert.ok(seq > 0);
      assert.equal(tab.lastActionSeq, seq);
    });
  });

  describe("network events", () => {
    it("addNetworkRequest stores entry with seq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { requestId: "r1", url: "https://example.com" });
      const { items } = tab.getNetworkRequests();
      assert.equal(items.length, 1);
      assert.equal(items[0].requestId, "r1");
      assert.ok(items[0].seq > 0);
    });

    it("updateNetworkResponse updates existing entry", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { requestId: "r1" });
      tab.updateNetworkResponse("r1", { status: 200, statusText: "OK", mimeType: "application/json" });
      const { items } = tab.getNetworkRequests();
      assert.equal(items[0].status, 200);
      assert.equal(items[0].statusText, "OK");
      assert.equal(items[0].mimeType, "application/json");
    });

    it("updateNetworkResponse ignores unknown requestId", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      // should not throw
      tab.updateNetworkResponse("unknown", { status: 404 });
    });

    it("updateNetworkFailure marks failure", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { requestId: "r1" });
      tab.updateNetworkFailure("r1", "net::ERR_CONNECTION_REFUSED");
      const { items } = tab.getNetworkRequests();
      assert.equal(items[0].failed, true);
      assert.equal(items[0].failureReason, "net::ERR_CONNECTION_REFUSED");
    });

    it("updateNetworkFailure ignores unknown requestId", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.updateNetworkFailure("unknown", "reason");
    });
  });

  describe("console events", () => {
    it("addConsoleMessage stores entry with seq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addConsoleMessage({ type: "log", text: "hello", timestamp: Date.now() });
      const { items } = tab.getConsoleMessages();
      assert.equal(items.length, 1);
      assert.equal(items[0].text, "hello");
      assert.ok(items[0].seq > 0);
    });
  });

  describe("JS error events", () => {
    it("addJSError stores entry with seq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addJSError({ message: "ReferenceError: x is not defined", timestamp: Date.now() });
      const { items } = tab.getJSErrors();
      assert.equal(items.length, 1);
      assert.equal(items[0].message, "ReferenceError: x is not defined");
      assert.ok(items[0].seq > 0);
    });
  });

  // --------------- getNetworkRequests query options ---------------

  describe("getNetworkRequests", () => {
    it("without filter returns all", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { url: "https://a.com" });
      addNetworkRequest(tab, { url: "https://b.com" });
      addNetworkRequest(tab, { url: "https://c.com" });
      const { items } = tab.getNetworkRequests();
      assert.equal(items.length, 3);
    });

    it("since: number filters by seq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { url: "https://a.com" });
      const { cursor } = tab.getNetworkRequests();
      addNetworkRequest(tab, { url: "https://b.com" });
      addNetworkRequest(tab, { url: "https://c.com" });
      const { items } = tab.getNetworkRequests({ since: cursor });
      assert.equal(items.length, 2);
      assert.ok(items.every((i) => i.seq > cursor));
    });

    it("since: 'last_action' uses lastActionSeq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { url: "https://before.com" });
      tab.recordAction();
      addNetworkRequest(tab, { url: "https://after.com" });
      const { items } = tab.getNetworkRequests({ since: "last_action" });
      assert.equal(items.length, 1);
      assert.equal(items[0].url, "https://after.com");
    });

    it("filter filters by URL substring", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { url: "https://example.com/api/users" });
      addNetworkRequest(tab, { url: "https://example.com/api/posts" });
      addNetworkRequest(tab, { url: "https://cdn.example.com/image.png" });
      const { items } = tab.getNetworkRequests({ filter: "/api/" });
      assert.equal(items.length, 2);
    });

    it("method filters by HTTP method", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { method: "GET" });
      addNetworkRequest(tab, { method: "POST" });
      addNetworkRequest(tab, { method: "GET" });
      const { items } = tab.getNetworkRequests({ method: "post" }); // case-insensitive input
      assert.equal(items.length, 1);
      assert.equal(items[0].method, "POST");
    });

    it("status '4xx' filters 400-499", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { requestId: "r1" });
      addNetworkRequest(tab, { requestId: "r2" });
      addNetworkRequest(tab, { requestId: "r3" });
      addNetworkRequest(tab, { requestId: "r4" });
      tab.updateNetworkResponse("r1", { status: 200 });
      tab.updateNetworkResponse("r2", { status: 404 });
      tab.updateNetworkResponse("r3", { status: 403 });
      tab.updateNetworkResponse("r4", { status: 500 });
      const { items } = tab.getNetworkRequests({ status: "4xx" });
      assert.equal(items.length, 2);
      assert.ok(items.every((i) => i.status! >= 400 && i.status! < 500));
    });

    it("status '200' filters exact code", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab, { requestId: "r1" });
      addNetworkRequest(tab, { requestId: "r2" });
      tab.updateNetworkResponse("r1", { status: 200 });
      tab.updateNetworkResponse("r2", { status: 201 });
      const { items } = tab.getNetworkRequests({ status: "200" });
      assert.equal(items.length, 1);
      assert.equal(items[0].status, 200);
    });

    it("limit returns last N items", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      for (let i = 0; i < 10; i++) {
        addNetworkRequest(tab, { url: `https://example.com/${i}` });
      }
      const { items } = tab.getNetworkRequests({ limit: 3 });
      assert.equal(items.length, 3);
      // Should be the last 3
      assert.equal(items[0].url, "https://example.com/7");
      assert.equal(items[1].url, "https://example.com/8");
      assert.equal(items[2].url, "https://example.com/9");
    });

    it("returns cursor as max seq in results", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab);
      addNetworkRequest(tab);
      addNetworkRequest(tab);
      const { items, cursor } = tab.getNetworkRequests();
      const maxSeq = Math.max(...items.map((i) => i.seq));
      assert.equal(cursor, maxSeq);
    });

    it("returns cursor 0 for empty results", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      const { cursor } = tab.getNetworkRequests();
      assert.equal(cursor, 0);
    });
  });

  describe("clearNetwork", () => {
    it("empties the network buffer", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      addNetworkRequest(tab);
      addNetworkRequest(tab);
      tab.clearNetwork();
      const { items } = tab.getNetworkRequests();
      assert.equal(items.length, 0);
    });
  });

  describe("RingBuffer eviction in network requests", () => {
    it("evicts oldest when > 500 requests added", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      for (let i = 0; i < 510; i++) {
        addNetworkRequest(tab, { url: `https://example.com/${i}` });
      }
      const { items } = tab.getNetworkRequests();
      assert.equal(items.length, 500);
      // Oldest should be #10 (0-9 evicted)
      assert.equal(items[0].url, "https://example.com/10");
      assert.equal(items[499].url, "https://example.com/509");
    });
  });

  // --------------- getConsoleMessages query options ---------------

  describe("getConsoleMessages", () => {
    it("since filters by seq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addConsoleMessage({ type: "log", text: "msg1", timestamp: 1 });
      const { cursor } = tab.getConsoleMessages();
      tab.addConsoleMessage({ type: "log", text: "msg2", timestamp: 2 });
      const { items } = tab.getConsoleMessages({ since: cursor });
      assert.equal(items.length, 1);
      assert.equal(items[0].text, "msg2");
    });

    it("since 'last_action' uses lastActionSeq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addConsoleMessage({ type: "log", text: "before", timestamp: 1 });
      tab.recordAction();
      tab.addConsoleMessage({ type: "warn", text: "after", timestamp: 2 });
      const { items } = tab.getConsoleMessages({ since: "last_action" });
      assert.equal(items.length, 1);
      assert.equal(items[0].text, "after");
    });

    it("filter filters by text substring", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addConsoleMessage({ type: "log", text: "Loading data...", timestamp: 1 });
      tab.addConsoleMessage({ type: "error", text: "Failed to fetch", timestamp: 2 });
      tab.addConsoleMessage({ type: "log", text: "Data loaded", timestamp: 3 });
      const { items } = tab.getConsoleMessages({ filter: "data" });
      // case-sensitive: "Loading data..." contains "data", "Data loaded" does not
      assert.equal(items.length, 1);
      assert.equal(items[0].text, "Loading data...");
    });

    it("filter is case-sensitive", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addConsoleMessage({ type: "log", text: "Loading Data", timestamp: 1 });
      tab.addConsoleMessage({ type: "log", text: "loading data", timestamp: 2 });
      const { items } = tab.getConsoleMessages({ filter: "Data" });
      assert.equal(items.length, 1);
      assert.equal(items[0].text, "Loading Data");
    });

    it("limit returns last N items", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      for (let i = 0; i < 10; i++) {
        tab.addConsoleMessage({ type: "log", text: `msg-${i}`, timestamp: i });
      }
      const { items } = tab.getConsoleMessages({ limit: 2 });
      assert.equal(items.length, 2);
      assert.equal(items[0].text, "msg-8");
      assert.equal(items[1].text, "msg-9");
    });
  });

  // --------------- getJSErrors query options ---------------

  describe("getJSErrors", () => {
    it("since filters by seq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addJSError({ message: "err1", timestamp: 1 });
      const { cursor } = tab.getJSErrors();
      tab.addJSError({ message: "err2", timestamp: 2 });
      const { items } = tab.getJSErrors({ since: cursor });
      assert.equal(items.length, 1);
      assert.equal(items[0].message, "err2");
    });

    it("since 'last_action' uses lastActionSeq", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addJSError({ message: "before", timestamp: 1 });
      tab.recordAction();
      tab.addJSError({ message: "after", timestamp: 2 });
      const { items } = tab.getJSErrors({ since: "last_action" });
      assert.equal(items.length, 1);
      assert.equal(items[0].message, "after");
    });

    it("filter matches by message substring", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addJSError({ message: "TypeError: null is not an object", timestamp: 1 });
      tab.addJSError({ message: "ReferenceError: x is not defined", timestamp: 2 });
      const { items } = tab.getJSErrors({ filter: "TypeError" });
      assert.equal(items.length, 1);
      assert.equal(items[0].message, "TypeError: null is not an object");
    });

    it("filter matches by url substring", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      tab.addJSError({ message: "err1", url: "https://example.com/app.js", timestamp: 1 });
      tab.addJSError({ message: "err2", url: "https://cdn.other.com/lib.js", timestamp: 2 });
      const { items } = tab.getJSErrors({ filter: "example.com" });
      assert.equal(items.length, 1);
      assert.equal(items[0].message, "err1");
    });

    it("limit returns last N items", () => {
      const mgr = makeManager();
      const tab = makeTab(mgr);
      for (let i = 0; i < 10; i++) {
        tab.addJSError({ message: `err-${i}`, timestamp: i });
      }
      const { items } = tab.getJSErrors({ limit: 3 });
      assert.equal(items.length, 3);
      assert.equal(items[0].message, "err-7");
      assert.equal(items[1].message, "err-8");
      assert.equal(items[2].message, "err-9");
    });
  });
});
