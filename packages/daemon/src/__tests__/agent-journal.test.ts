import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../state-store.js";
import { JournalManager } from "../agent-journal.js";

function makeManager(): { manager: JournalManager; store: StateStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-journal-test-"));
  const store = new StateStore(dir);
  const manager = new JournalManager(store);
  return { manager, store, dir };
}

describe("JournalManager", () => {
  const dirs: string[] = [];

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("returns empty array for unknown agent", () => {
    const { manager, dir } = makeManager();
    dirs.push(dir);
    assert.deepEqual(manager.getRecent("no-such-agent"), []);
  });

  it("records entries and retrieves them in order", () => {
    const { manager, dir } = makeManager();
    dirs.push(dir);
    manager.record("agent-1", "open", undefined, "https://example.com", true);
    manager.record("agent-1", "click", "abc1", undefined, true);
    const entries = manager.getRecent("agent-1");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, "open");
    assert.equal(entries[0].url, "https://example.com");
    assert.equal(entries[1].action, "click");
    assert.equal(entries[1].tab, "abc1");
  });

  it("limit parameter caps the returned entries", () => {
    const { manager, dir } = makeManager();
    dirs.push(dir);
    for (let i = 0; i < 10; i++) manager.record("agent-x", "snapshot", undefined, undefined, true);
    assert.equal(manager.getRecent("agent-x", 3).length, 3);
    assert.equal(manager.getRecent("agent-x", 100).length, 10);
  });

  it("journals for different agents are isolated", () => {
    const { manager, dir } = makeManager();
    dirs.push(dir);
    manager.record("agent-a", "click", undefined, undefined, true);
    manager.record("agent-b", "fill", undefined, undefined, false);
    assert.equal(manager.getRecent("agent-a").length, 1);
    assert.equal(manager.getRecent("agent-a")[0].action, "click");
    assert.equal(manager.getRecent("agent-b").length, 1);
    assert.equal(manager.getRecent("agent-b")[0].action, "fill");
    assert.equal(manager.getRecent("agent-b")[0].success, false);
  });

  it("persists entries across JournalManager restart", () => {
    const { store, manager, dir } = makeManager();
    dirs.push(dir);
    manager.record("persist-agent", "open", undefined, "https://example.com", true);
    manager.record("persist-agent", "click", "tab1", undefined, true);

    const manager2 = new JournalManager(store);
    const entries = manager2.getRecent("persist-agent");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, "open");
    assert.equal(entries[1].action, "click");
  });

  it("seq numbers are monotonically increasing", () => {
    const { manager, dir } = makeManager();
    dirs.push(dir);
    manager.record("seq-agent", "a", undefined, undefined, true);
    manager.record("seq-agent", "b", undefined, undefined, true);
    manager.record("seq-agent", "c", undefined, undefined, true);
    const entries = manager.getRecent("seq-agent");
    assert.ok(entries[0].seq < entries[1].seq);
    assert.ok(entries[1].seq < entries[2].seq);
  });

  it("seq continues after restart", () => {
    const { store, manager, dir } = makeManager();
    dirs.push(dir);
    manager.record("seq-persist", "a", undefined, undefined, true);
    manager.record("seq-persist", "b", undefined, undefined, true);
    const lastSeqBefore = manager.getRecent("seq-persist").at(-1)!.seq;

    const manager2 = new JournalManager(store);
    manager2.record("seq-persist", "c", undefined, undefined, true);
    const lastSeqAfter = manager2.getRecent("seq-persist").at(-1)!.seq;
    assert.ok(lastSeqAfter > lastSeqBefore, "seq must not reset after restart");
  });
});
