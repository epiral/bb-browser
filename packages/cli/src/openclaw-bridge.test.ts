import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenClawArgs,
  getOpenClawExecTimeout,
  isOpenClawNavigationError,
  ocGetTabReference,
} from "./openclaw-bridge.js";

test("places browser-level flags before subcommand", () => {
  assert.deepEqual(buildOpenClawArgs(["status", "--json"], 5000), [
    "openclaw",
    "browser",
    "--json",
    "--timeout",
    "5000",
    "status",
  ]);
});

test("builds evaluate without relying on target-id", () => {
  assert.deepEqual(buildOpenClawArgs(["evaluate", "--fn", "() => document.title"], 120000), [
    "openclaw",
    "browser",
    "--timeout",
    "120000",
    "evaluate",
    "--fn",
    "() => document.title",
  ]);
});

test("prefers stable OpenClaw tab references", () => {
  const base = { targetId: "raw123", url: "https://example.com", title: "Example", type: "page" };
  assert.equal(ocGetTabReference({ ...base, suggestedTargetId: "docs", tabId: "t1", label: "example" }), "docs");
  assert.equal(ocGetTabReference({ ...base, tabId: "t1", label: "example" }), "t1");
  assert.equal(ocGetTabReference({ ...base, label: "example" }), "example");
  assert.equal(ocGetTabReference(base), "raw123");
});

test("detects evaluate interruption caused by page navigation", () => {
  assert.equal(isOpenClawNavigationError(new Error(
    "page.evaluate: Execution context was destroyed, most likely because of a navigation.",
  )), true);
  assert.equal(isOpenClawNavigationError(Object.assign(new Error("Command failed"), {
    stderr: Buffer.from("Execution context was destroyed, most likely because of a navigation"),
  })), true);
  assert.equal(isOpenClawNavigationError(new Error("page.evaluate: ReferenceError: feedContainer is not defined")), false);
});

test("adds a small buffer to the exec timeout", () => {
  assert.equal(getOpenClawExecTimeout(120000), 125000);
});

test("requires a browser subcommand", () => {
  assert.throws(() => buildOpenClawArgs([], 5000), /requires a subcommand/);
});
