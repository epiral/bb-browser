import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../state-store.js";
import { AgentRegistry } from "../agent-registry.js";

function makeRegistry(): { store: StateStore; registry: AgentRegistry; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-agent-test-"));
  const store = new StateStore(dir);
  const registry = new AgentRegistry(store);
  return { store, registry, dir };
}

describe("AgentRegistry", () => {
  const dirs: string[] = [];

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("case 3: anonymous session uses sessionId as agentId (in-memory only)", () => {
    const { registry, dir } = makeRegistry();
    dirs.push(dir);
    const rec = registry.resolveOrCreate({ sessionId: "sess-abc" });
    assert.equal(rec.agentId, "sess-abc");
    assert.equal(rec.knownSessionIds[0], "sess-abc");
  });

  it("case 2: label produces stable agentId across two calls", () => {
    const { registry, dir } = makeRegistry();
    dirs.push(dir);
    const r1 = registry.resolveOrCreate({ sessionId: "s1", label: "MyAgent" });
    const r2 = registry.resolveOrCreate({ sessionId: "s2", label: "MyAgent" });
    assert.equal(r1.agentId, r2.agentId);
    assert.ok(r2.knownSessionIds.includes("s1"));
    assert.ok(r2.knownSessionIds.includes("s2"));
  });

  it("case 2: label matching is case-insensitive", () => {
    const { registry, dir } = makeRegistry();
    dirs.push(dir);
    const r1 = registry.resolveOrCreate({ sessionId: "s1", label: "MyAgent" });
    const r2 = registry.resolveOrCreate({ sessionId: "s2", label: "myagent" });
    assert.equal(r1.agentId, r2.agentId);
  });

  it("case 1: explicit agentId is used verbatim", () => {
    const { registry, dir } = makeRegistry();
    dirs.push(dir);
    const rec = registry.resolveOrCreate({
      sessionId: "s1",
      explicitAgentId: "my-stable-agent-id",
    });
    assert.equal(rec.agentId, "my-stable-agent-id");
  });

  it("persists named agents and restores on new registry instance", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bb-agent-persist-"));
    dirs.push(dir);
    const store1 = new StateStore(dir);
    const registry1 = new AgentRegistry(store1);
    const r1 = registry1.resolveOrCreate({ sessionId: "s1", label: "PersistMe" });

    // New registry instance reads from the same store directory
    const store2 = new StateStore(dir);
    const registry2 = new AgentRegistry(store2);
    const r2 = registry2.resolveOrCreate({ sessionId: "s2", label: "PersistMe" });

    assert.equal(r1.agentId, r2.agentId, "agentId must survive a registry restart");
  });

  it("all() returns registered named agents", () => {
    const { registry, dir } = makeRegistry();
    dirs.push(dir);
    registry.resolveOrCreate({ sessionId: "s1", label: "AgentA" });
    registry.resolveOrCreate({ sessionId: "s2", label: "AgentB" });
    registry.resolveOrCreate({ sessionId: "s3" }); // anonymous — not in all()
    const all = registry.all();
    const labels = all.map((r) => r.label).filter(Boolean);
    assert.ok(labels.includes("AgentA"));
    assert.ok(labels.includes("AgentB"));
  });
});
