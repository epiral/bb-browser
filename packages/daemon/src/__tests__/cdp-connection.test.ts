import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CdpConnection, type CdpTargetInfo } from "../cdp-connection.js";
import { TabStateManager } from "../tab-state.js";

const targets: CdpTargetInfo[] = [
  { id: "target-current-1234", type: "page", title: "Current", url: "https://example.com/current" },
  { id: "target-selected-5678", type: "page", title: "Selected", url: "https://example.com/selected" },
];

function makeConnection(): { cdp: CdpConnection; calls: string[]; selectedShortId: string } {
  const tabManager = new TabStateManager();
  tabManager.addTab(targets[0].id);
  const selectedTab = tabManager.addTab(targets[1].id);
  const calls: string[] = [];
  const cdp = new CdpConnection("127.0.0.1", 9222, tabManager);

  cdp.currentTargetId = targets[0].id;
  cdp.getTargets = async () => targets;
  cdp.browserCommand = async <T,>(method: string, params: Record<string, unknown> = {}) => {
    calls.push(`${method}:${String(params.targetId ?? "")}`);
    return {} as T;
  };
  cdp.attachAndEnable = async (targetId: string) => {
    calls.push(`attach:${targetId}`);
    return "session-id";
  };

  return { cdp, calls, selectedShortId: selectedTab.shortId };
}

describe("CdpConnection.ensurePageTarget", () => {
  it("activates an explicitly selected tab before attaching", async () => {
    const { cdp, calls, selectedShortId } = makeConnection();

    const target = await cdp.ensurePageTarget(selectedShortId, { activate: true });

    assert.equal(target.id, targets[1].id);
    assert.deepEqual(calls, [
      `Target.activateTarget:${targets[1].id}`,
      `attach:${targets[1].id}`,
    ]);
    assert.equal(cdp.currentTargetId, targets[1].id);
  });

  it("does not activate when reusing daemon current tab", async () => {
    const { cdp, calls } = makeConnection();

    const target = await cdp.ensurePageTarget();

    assert.equal(target.id, targets[0].id);
    assert.deepEqual(calls, [`attach:${targets[0].id}`]);
  });
});
