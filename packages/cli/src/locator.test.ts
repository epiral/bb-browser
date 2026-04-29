import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatLocatorOutput, parseLocatorInput } from "./locator.js";

describe("locator helpers", () => {
  it("strips @ refs but preserves @@ tags", () => {
    assert.equal(parseLocatorInput("@5"), "5");
    assert.equal(parseLocatorInput("5"), "5");
    assert.equal(parseLocatorInput("@@searchBox"), "@@searchBox");
    assert.equal(parseLocatorInput("@@items[2]"), "@@items[2]");
  });

  it("formats output locators consistently", () => {
    assert.equal(formatLocatorOutput("5"), "@5");
    assert.equal(formatLocatorOutput("@5"), "@5");
    assert.equal(formatLocatorOutput("@@searchBox"), "@@searchBox");
  });
});
