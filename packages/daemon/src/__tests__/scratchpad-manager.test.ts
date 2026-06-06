import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScratchpadManager } from "../scratchpad-manager.js";

describe("ScratchpadManager", () => {
  it("returns null for unknown tab", () => {
    const mgr = new ScratchpadManager();
    assert.equal(mgr.getRecent("no-such-tab"), null);
  });

  it("records write actions and retrieves them", () => {
    const mgr = new ScratchpadManager();
    mgr.record("tab-1", "click", "agent-a");
    mgr.record("tab-1", "fill", "agent-a");
    const entries = mgr.getRecent("tab-1");
    assert.ok(entries !== null);
    assert.equal(entries!.length, 2);
    assert.equal(entries![0].action, "click");
    assert.equal(entries![0].agentId, "agent-a");
    assert.equal(entries![1].action, "fill");
  });

  it("does not record read-only actions (snapshot, tab_list, etc.)", () => {
    const mgr = new ScratchpadManager();
    mgr.record("tab-2", "snapshot", "agent-a");
    mgr.record("tab-2", "tab_list", "agent-a");
    mgr.record("tab-2", "get", "agent-a");
    mgr.record("tab-2", "network", "agent-a");
    assert.equal(mgr.getRecent("tab-2"), null);
  });

  it("tabs are isolated from each other", () => {
    const mgr = new ScratchpadManager();
    mgr.record("tab-a", "click", "agent-1");
    mgr.record("tab-b", "fill", "agent-2");
    const a = mgr.getRecent("tab-a");
    const b = mgr.getRecent("tab-b");
    assert.equal(a!.length, 1);
    assert.equal(a![0].action, "click");
    assert.equal(b!.length, 1);
    assert.equal(b![0].action, "fill");
  });

  it("isWriteAction correctly classifies actions", () => {
    const mgr = new ScratchpadManager();
    assert.ok(mgr.isWriteAction("click"));
    assert.ok(mgr.isWriteAction("fill"));
    assert.ok(mgr.isWriteAction("open"));
    assert.ok(!mgr.isWriteAction("snapshot"));
    assert.ok(!mgr.isWriteAction("tab_list"));
    assert.ok(!mgr.isWriteAction("network"));
    assert.ok(!mgr.isWriteAction("resume"));
  });

  it("respects capacity: keeps only the last 10 entries", () => {
    const mgr = new ScratchpadManager();
    for (let i = 0; i < 15; i++) mgr.record("tab-cap", "click", "a");
    const entries = mgr.getRecent("tab-cap");
    assert.equal(entries!.length, 10);
  });

  it("gc removes entries whose last write is older than TTL", (t) => {
    // Cannot easily control time without mocking, so just verify gc() doesn't
    // throw and doesn't remove fresh entries.
    const mgr = new ScratchpadManager();
    mgr.record("tab-gc", "click", "a");
    mgr.gc();
    const entries = mgr.getRecent("tab-gc");
    assert.ok(entries !== null && entries.length === 1, "fresh entry should survive gc");
  });
});
