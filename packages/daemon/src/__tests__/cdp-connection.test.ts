import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CdpConnection } from "../cdp-connection.js";
import { TabStateManager } from "../tab-state.js";

function makeConnection() {
  const manager = new TabStateManager();
  const cdp = new CdpConnection("127.0.0.1", 9222, manager);
  return { cdp, manager };
}

describe("CdpConnection iframe target handling", () => {
  it("maps auto-attached iframe targets to the owning page and enables network", async () => {
    const { cdp, manager } = makeConnection();
    manager.addTab("page-target");
    (cdp as any).ownerPageTargetByTarget.set("page-target", "page-target");

    const calls: Array<{ targetId: string; method: string }> = [];
    (cdp as any).sessionCommand = async (targetId: string, method: string) => {
      calls.push({ targetId, method });
      return {};
    };

    await (cdp as any).handleSessionEvent("page-target", {
      method: "Target.attachedToTarget",
      params: {
        sessionId: "iframe-session",
        targetInfo: {
          targetId: "iframe-target",
          type: "iframe",
        },
      },
    });

    assert.equal((cdp as any).sessions.get("iframe-target"), "iframe-session");
    assert.equal((cdp as any).attachedTargets.get("iframe-session"), "iframe-target");
    assert.equal((cdp as any).ownerPageTargetByTarget.get("iframe-target"), "page-target");
    assert.deepEqual(calls, [{ targetId: "iframe-target", method: "Network.enable" }]);
  });

  it("routes iframe network events into the owning page tab", async () => {
    const { cdp, manager } = makeConnection();
    const pageTab = manager.addTab("page-target");
    (cdp as any).ownerPageTargetByTarget.set("page-target", "page-target");
    (cdp as any).ownerPageTargetByTarget.set("iframe-target", "page-target");

    await (cdp as any).handleSessionEvent("iframe-target", {
      method: "Network.requestWillBeSent",
      params: {
        requestId: "req-1",
        request: {
          url: "https://example.com/api/data",
          method: "GET",
        },
        type: "XHR",
        timestamp: 1,
      },
    });

    await (cdp as any).handleSessionEvent("iframe-target", {
      method: "Network.responseReceived",
      params: {
        requestId: "req-1",
        response: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
        },
      },
    });

    const { items } = pageTab.getNetworkRequests();
    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://example.com/api/data");
    assert.equal(items[0].status, 200);
    assert.equal(pageTab.getNetworkOriginTargetId(items[0].seq), "iframe-target");
  });

  it("cleans up iframe target ownership on detach", async () => {
    const { cdp, manager } = makeConnection();
    manager.addTab("page-target");
    (cdp as any).ownerPageTargetByTarget.set("page-target", "page-target");
    (cdp as any).ownerPageTargetByTarget.set("iframe-target", "page-target");
    (cdp as any).sessions.set("iframe-target", "iframe-session");
    (cdp as any).attachedTargets.set("iframe-session", "iframe-target");

    await (cdp as any).handleSessionEvent("page-target", {
      method: "Target.detachedFromTarget",
      params: {
        sessionId: "iframe-session",
      },
    });

    assert.equal((cdp as any).sessions.get("iframe-target"), undefined);
    assert.equal((cdp as any).attachedTargets.get("iframe-session"), undefined);
    assert.equal((cdp as any).ownerPageTargetByTarget.get("iframe-target"), undefined);
  });
});
