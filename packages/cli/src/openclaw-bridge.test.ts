import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenClawArgs, getOpenClawExecTimeout } from "./openclaw-bridge.js";

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

test("preserves subcommand flags and values after subcommand", () => {
  assert.deepEqual(buildOpenClawArgs(["evaluate", "--fn", "() => document.title", "--target-id", "abc123"], 120000), [
    "openclaw",
    "browser",
    "--timeout",
    "120000",
    "evaluate",
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
