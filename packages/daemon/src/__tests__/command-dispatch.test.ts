import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "@bb-browser/shared";
import type { CdpConnection, CdpTargetInfo } from "../cdp-connection.js";
import { dispatchRequest } from "../command-dispatch.js";
import { TabStateManager } from "../tab-state.js";

function makeTarget(id: string, title: string): CdpTargetInfo {
  return {
    id,
    type: "page",
    title,
    url: `https://example.com/${title.toLowerCase().replace(/\s+/g, "-")}`,
  };
}

describe("dispatchRequest", () => {
  it("tab_select activates the requested target before updating daemon state", async () => {
    const current = makeTarget("TARGET_CURRENT_1234", "Current Tab");
    const selected = makeTarget("TARGET_SELECTED_5678", "Selected Tab");
    const tabManager = new TabStateManager();
    tabManager.addTab(current.id);
    const selectedTab = tabManager.addTab(selected.id);
    const calls: string[] = [];

    const cdp = {
      tabManager,
      currentTargetId: current.id,
      async ensurePageTarget() {
        return current;
      },
      async getTargets() {
        return [current, selected];
      },
      async browserCommand(method: string, params?: { targetId?: string }) {
        if (method === "Target.activateTarget") {
          calls.push(`activate:${params?.targetId ?? ""}`);
        }
        return {};
      },
      async attachAndEnable(targetId: string) {
        calls.push(`attach:${targetId}`);
        return "session-id";
      },
    } as unknown as CdpConnection;

    const request: Request = {
      id: "test-tab-select",
      action: "tab_select",
      tabId: selectedTab.shortId,
    };

    const response = await dispatchRequest(cdp, request);

    assert.equal(response.success, true);
    assert.deepEqual(calls, [
      `activate:${selected.id}`,
      `attach:${selected.id}`,
    ]);
    assert.equal(cdp.currentTargetId, selected.id);
    assert.equal(response.data?.tabId, selected.id);
    assert.equal(response.data?.title, selected.title);
    assert.equal(response.data?.tab, selectedTab.shortId);
  });
});
