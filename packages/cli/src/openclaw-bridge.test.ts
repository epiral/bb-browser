import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenClawArgs, getOpenClawExecTimeout } from "./openclaw-bridge.js";

test("places timeout after the browser subcommand", () => {
  assert.deepEqual(buildOpenClawArgs(["status", "--json"], 5000), [
    "openclaw",
    "browser",
    "status",
    "--timeout",
    "5000",
    "--json",
  ]);
});

test("preserves subcommand flags and values after inserting timeout", () => {
  assert.deepEqual(buildOpenClawArgs(["evaluate", "--fn", "() => document.title", "--target-id", "abc123"], 120000), [
    "openclaw",
    "browser",
    "evaluate",
    "--timeout",
    "120000",
    "--fn",
    "() => document.title",
    "--target-id",
    "abc123",
  ]);
});

test("adds a small buffer to the exec timeout", () => {
  assert.equal(getOpenClawExecTimeout(120000), 125000);
});

test("requires a browser subcommand", () => {
  assert.throws(() => buildOpenClawArgs([], 5000), /requires a subcommand/);
});
