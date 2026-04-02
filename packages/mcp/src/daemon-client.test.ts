import test from "node:test";
import assert from "node:assert/strict";
import { daemonBaseUrl, mergeDaemonHeaders } from "./daemon-client.js";

test("daemonBaseUrl normalizes localhost to 127.0.0.1", () => {
  assert.equal(
    daemonBaseUrl({ host: "localhost", port: 19824 }),
    "http://127.0.0.1:19824",
  );
});

test("daemonBaseUrl preserves explicit hosts", () => {
  assert.equal(
    daemonBaseUrl({ host: "127.0.0.1", port: 24446 }),
    "http://127.0.0.1:24446",
  );
});

test("mergeDaemonHeaders injects bearer auth while preserving headers", () => {
  assert.deepEqual(
    mergeDaemonHeaders({ "Content-Type": "application/json" }, "token-123"),
    {
      "Content-Type": "application/json",
      Authorization: "Bearer token-123",
    },
  );
});
