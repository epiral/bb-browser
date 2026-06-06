import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../state-store.js";

describe("StateStore", () => {
  let dir: string;
  let store: StateStore;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bb-state-test-"));
    store = new StateStore(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for missing file", () => {
    assert.equal(store.read("nonexistent.json"), null);
  });

  it("writes and reads back a value", () => {
    store.write("test.json", { foo: 42, bar: "hello" });
    const result = store.read<{ foo: number; bar: string }>("test.json");
    assert.ok(result !== null);
    assert.equal(result.foo, 42);
    assert.equal(result.bar, "hello");
  });

  it("overwrites an existing file atomically", () => {
    store.write("overwrite.json", { v: 1 });
    store.write("overwrite.json", { v: 2 });
    const result = store.read<{ v: number }>("overwrite.json");
    assert.ok(result !== null);
    assert.equal(result.v, 2);
  });

  it("returns null for corrupt JSON", () => {
    writeFileSync(path.join(dir, "corrupt.json"), "not json{{{");
    assert.equal(store.read("corrupt.json"), null);
  });

  it("creates the directory if it does not exist", () => {
    const subDir = path.join(dir, "sub", "nested");
    const subStore = new StateStore(subDir);
    subStore.write("ping.json", { ok: true });
    assert.ok(existsSync(path.join(subDir, "ping.json")));
  });
});
