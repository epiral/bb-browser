import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "@bb-browser/shared";
import { dispatchRequest } from "../command-dispatch.js";
import type { CdpConnection, CdpTargetInfo } from "../cdp-connection.js";
import { TabStateManager } from "../tab-state.js";

class FakeCdp {
  readonly tabManager = new TabStateManager();
  readonly existingTargetId = "D9E4E599BD8F29EA64E59C80EEB70234";
  readonly createdTargetId = "A1E4E599BD8F29EA64E59C80EEB75678";
  readonly target: CdpTargetInfo = {
    id: this.existingTargetId,
    type: "page",
    title: "Existing",
    url: "https://old.example",
  };
  readonly createdTarget: CdpTargetInfo = {
    id: this.createdTargetId,
    type: "page",
    title: "Created",
    url: "https://new.example",
  };
  currentTargetId: string | undefined = this.target.id;
  targets: CdpTargetInfo[] = [this.target];
  ensureCalls: Array<string | number | undefined> = [];
  pageCommands: Array<{ targetId: string; method: string; params: Record<string, unknown> }> = [];
  browserCommands: Array<{ method: string; params: Record<string, unknown> }> = [];
  evaluateCalls: Array<{ targetId: string; expression: string }> = [];

  constructor() {
    this.tabManager.addTab(this.target.id);
  }

  async ensurePageTarget(tabRef?: string | number): Promise<CdpTargetInfo> {
    this.ensureCalls.push(tabRef);
    let target: CdpTargetInfo | undefined;

    if (typeof tabRef === "string") {
      const resolvedTargetId = this.tabManager.resolveShortId(tabRef);
      target = this.targets.find((t) => t.id === resolvedTargetId);
      target ??= this.targets.find((t) => t.id === tabRef);
      if (!target) {
        const index = Number(tabRef);
        if (!Number.isNaN(index)) target = this.targets[index];
      }
    } else if (typeof tabRef === "number") {
      target = this.targets[tabRef];
    } else if (this.currentTargetId) {
      target = this.targets.find((t) => t.id === this.currentTargetId);
    }

    target ??= this.targets[0];
    this.currentTargetId = target.id;
    this.tabManager.addTab(target.id);
    return target;
  }

  async pageCommand<T = unknown>(
    targetId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.pageCommands.push({ targetId, method, params });
    return {} as T;
  }

  async browserCommand<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.browserCommands.push({ method, params });
    if (method === "Target.createTarget") {
      this.targets.push(this.createdTarget);
      return { targetId: this.createdTarget.id } as T;
    }
    return {} as T;
  }

  async evaluate<T = unknown>(targetId: string, expression: string): Promise<T> {
    this.evaluateCalls.push({ targetId, expression });
    const target = this.targets.find((t) => t.id === targetId);
    if (expression === "document.title") {
      return target?.title as T;
    }
    return undefined as T;
  }
}

function fakeConnection(): CdpConnection {
  return new FakeCdp() as unknown as CdpConnection;
}

describe("dispatchRequest open tab targeting", () => {
  it("navigates the current tab when tabId is current", async () => {
    const cdp = fakeConnection();

    const response = await dispatchRequest(cdp, {
      method: "open",
      url: "https://example.com",
      tabId: "current",
    } satisfies Request);

    assert.equal(response.error, undefined);
    assert.equal(response.result?.tabId, (cdp as unknown as FakeCdp).existingTargetId);

    const fake = cdp as unknown as FakeCdp;
    assert.deepEqual(fake.ensureCalls, [undefined]);
    assert.equal(fake.browserCommands.length, 0);
    assert.deepEqual(fake.pageCommands, [
      {
        targetId: fake.existingTargetId,
        method: "Page.navigate",
        params: { url: "https://example.com" },
      },
    ]);
  });

  it("passes short and full string tab ids through daemon target resolution", async () => {
    for (const tabId of ["0234", "D9E4E599BD8F29EA64E59C80EEB70234"]) {
      const cdp = fakeConnection();

      const response = await dispatchRequest(cdp, {
        method: "open",
        url: "https://example.com",
        tabId,
      } satisfies Request);

      assert.equal(response.error, undefined);
      assert.deepEqual((cdp as unknown as FakeCdp).ensureCalls, [tabId]);
    }
  });

  it("returns ids that target the opened tab in follow-up commands", async () => {
    const cdp = fakeConnection();

    const openResponse = await dispatchRequest(cdp, {
      method: "open",
      url: "https://new.example",
    } satisfies Request);

    assert.equal(openResponse.error, undefined);
    assert.equal(openResponse.result?.tabId, (cdp as unknown as FakeCdp).createdTargetId);
    assert.equal(openResponse.result?.tab, "5678");

    const fake = cdp as unknown as FakeCdp;
    assert.deepEqual(fake.browserCommands, [
      {
        method: "Target.createTarget",
        params: { url: "https://new.example", background: true },
      },
    ]);

    const byShortId = await dispatchRequest(cdp, {
      method: "eval",
      script: "document.title",
      tabId: openResponse.result?.tab,
    } satisfies Request);

    assert.equal(byShortId.error, undefined);
    assert.equal(byShortId.result?.result, "Created");

    const byFullId = await dispatchRequest(cdp, {
      method: "eval",
      script: "document.title",
      tabId: openResponse.result?.tabId,
    } satisfies Request);

    assert.equal(byFullId.error, undefined);
    assert.equal(byFullId.result?.result, "Created");
    assert.deepEqual(
      fake.evaluateCalls
        .filter((call) => call.expression === "document.title")
        .map((call) => call.targetId),
      [fake.createdTargetId, fake.createdTargetId],
    );
  });
});
