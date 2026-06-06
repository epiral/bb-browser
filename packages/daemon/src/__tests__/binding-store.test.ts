import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../state-store.js";
import { BindingStore } from "../binding-store.js";

function makeStore(): { store: StateStore; bindings: BindingStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-binding-test-"));
  const store = new StateStore(dir);
  const bindings = new BindingStore(store);
  return { store, bindings, dir };
}

const BASE: Parameters<BindingStore["upsert"]>[0] = {
  bbTabId: "tab-1",
  agentId: "agent-a",
  anchorUrl: "https://example.com",
  intent: "Fill and submit the form",
  claimedAt: 1000,
  updatedAt: 1000,
};

describe("BindingStore", () => {
  const dirs: string[] = [];

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("starts empty", () => {
    const { bindings, dir } = makeStore();
    dirs.push(dir);
    assert.deepEqual(bindings.all(), []);
  });

  it("upserts and retrieves a binding", () => {
    const { bindings, dir } = makeStore();
    dirs.push(dir);
    bindings.upsert(BASE);
    const all = bindings.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].bbTabId, "tab-1");
    assert.equal(all[0].intent, "Fill and submit the form");
  });

  it("overwrites an existing binding on re-upsert", () => {
    const { bindings, dir } = makeStore();
    dirs.push(dir);
    bindings.upsert(BASE);
    bindings.upsert({ ...BASE, anchorUrl: "https://example.com/page2" });
    assert.equal(bindings.all().length, 1);
    assert.equal(bindings.all()[0].anchorUrl, "https://example.com/page2");
  });

  it("updateProgress returns true and updates field", () => {
    const { bindings, dir } = makeStore();
    dirs.push(dir);
    bindings.upsert(BASE);
    const ok = bindings.updateProgress("tab-1", "Step 3 of 5 complete");
    assert.ok(ok);
    assert.equal(bindings.all()[0].progress, "Step 3 of 5 complete");
  });

  it("updateProgress returns false for unknown bbTabId", () => {
    const { bindings, dir } = makeStore();
    dirs.push(dir);
    assert.equal(bindings.updateProgress("no-such-tab", "x"), false);
  });

  it("remove deletes the binding", () => {
    const { bindings, dir } = makeStore();
    dirs.push(dir);
    bindings.upsert(BASE);
    bindings.remove("tab-1");
    assert.deepEqual(bindings.all(), []);
  });

  it("forAgent filters by agentId", () => {
    const { bindings, dir } = makeStore();
    dirs.push(dir);
    bindings.upsert(BASE);
    bindings.upsert({ ...BASE, bbTabId: "tab-2", agentId: "agent-b" });
    const forA = bindings.forAgent("agent-a");
    assert.equal(forA.length, 1);
    assert.equal(forA[0].bbTabId, "tab-1");
  });

  it("persists across BindingStore restart", () => {
    const { store, bindings, dir } = makeStore();
    dirs.push(dir);
    bindings.upsert(BASE);
    bindings.updateProgress("tab-1", "halfway done");

    const bindings2 = new BindingStore(store);
    const all = bindings2.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].progress, "halfway done");
    assert.equal(all[0].intent, "Fill and submit the form");
  });
});
