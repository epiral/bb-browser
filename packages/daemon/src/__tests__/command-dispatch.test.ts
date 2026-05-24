import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "@bb-browser/shared";
import { dispatchRequest } from "../command-dispatch.js";
import type { CdpConnection, CdpTargetInfo } from "../cdp-connection.js";
import { TabStateManager } from "../tab-state.js";

type RecordedCommand = {
  scope: "browser" | "session";
  targetId?: string;
  method: string;
  params: Record<string, unknown>;
};

class FakeCdp {
  readonly tabManager = new TabStateManager();
  readonly target: CdpTargetInfo = {
    id: "target-background",
    type: "page",
    title: "Example",
    url: "https://example.com",
  };
  readonly commands: RecordedCommand[] = [];
  currentTargetId: string | undefined;

  constructor() {
    const tab = this.tabManager.addTab(this.target.id);
    tab.refs["1"] = {
      backendDOMNodeId: 42,
      role: "button",
      name: "Submit",
      tagName: "button",
    };
  }

  async ensurePageTarget(): Promise<CdpTargetInfo> {
    this.currentTargetId = this.target.id;
    return this.target;
  }

  async browserCommand<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ scope: "browser", method, params });
    return {} as T;
  }

  async sessionCommand<T = unknown>(
    targetId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.commands.push({ scope: "session", targetId, method, params });

    if (method === "DOM.resolveNode") {
      return { object: { objectId: "object-1" } } as T;
    }
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: { x: 100, y: 200 } } } as T;
    }
    return {} as T;
  }
}

function fakeConnection(): CdpConnection {
  return new FakeCdp() as unknown as CdpConnection;
}

describe("dispatchRequest input activation", () => {
  it("activates a background target before resolving click coordinates", async () => {
    const cdp = fakeConnection();

    const response = await dispatchRequest(cdp, {
      id: "click-1",
      method: "click",
      ref: "1",
    } satisfies Request);

    assert.equal(response.error, undefined);
    assert.equal(response.result?.tab, "ound");
    assert.equal(typeof response.result?.seq, "number");

    const commands = (cdp as unknown as FakeCdp).commands;
    const activateIndex = commands.findIndex(
      (cmd) => cmd.scope === "browser" && cmd.method === "Target.activateTarget",
    );
    const resolveIndex = commands.findIndex((cmd) => cmd.method === "DOM.resolveNode");
    const pressIndex = commands.findIndex(
      (cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mousePressed",
    );

    assert.notEqual(activateIndex, -1);
    assert.notEqual(resolveIndex, -1);
    assert.notEqual(pressIndex, -1);
    assert.ok(activateIndex < resolveIndex);
    assert.ok(activateIndex < pressIndex);
    assert.deepEqual(commands[activateIndex].params, { targetId: "target-background" });
  });

  it("activates a background target before dispatching wheel events", async () => {
    const cdp = fakeConnection();

    const response = await dispatchRequest(cdp, {
      id: "scroll-1",
      method: "scroll",
      direction: "down",
      pixels: 200,
    } satisfies Request);

    assert.equal(response.error, undefined);
    assert.equal(response.result?.tab, "ound");
    assert.equal(typeof response.result?.seq, "number");

    const commands = (cdp as unknown as FakeCdp).commands;
    const activateIndex = commands.findIndex(
      (cmd) => cmd.scope === "browser" && cmd.method === "Target.activateTarget",
    );
    const wheelIndex = commands.findIndex(
      (cmd) => cmd.method === "Input.dispatchMouseEvent" && cmd.params.type === "mouseWheel",
    );

    assert.notEqual(activateIndex, -1);
    assert.notEqual(wheelIndex, -1);
    assert.ok(activateIndex < wheelIndex);
    assert.deepEqual(commands[wheelIndex].params, {
      type: "mouseWheel",
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 200,
    });
  });
});
