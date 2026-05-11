import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOpenTabOption } from "./open.js";

describe("resolveOpenTabOption", () => {
  it("preserves short string tab ids", () => {
    assert.equal(resolveOpenTabOption("a1b2"), "a1b2");
  });

  it("preserves full CDP target ids", () => {
    const targetId = "D9E4E599BD8F29EA64E59C80EEB70234";
    assert.equal(resolveOpenTabOption(targetId), targetId);
  });

  it("preserves numeric strings so the daemon can resolve short ids before indexes", () => {
    assert.equal(resolveOpenTabOption("1234"), "1234");
  });
});
