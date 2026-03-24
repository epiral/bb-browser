import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(currentDir, "../dist/index.js");

test("daemon subcommand forwards help to the daemon entrypoint", () => {
  const result = spawnSync(process.execPath, [cliPath, "daemon", "--help"], {
    encoding: "utf-8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /bb-browser daemon - HTTP server daemon for bb-browser/);
  assert.match(result.stderr, /bb-browser daemon \[options\]/);
  assert.doesNotMatch(result.stdout + result.stderr, /AI Agent 浏览器自动化工具|已关闭当前标签页/);
});
