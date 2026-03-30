import test from "node:test";
import assert from "node:assert/strict";
import { parseOpenClawJson } from "./openclaw-json.js";

test("parses normal JSON via fast path", () => {
  assert.deepEqual(parseOpenClawJson('{"tabs":[]}'), { tabs: [] });
});

test("parses JSON with leading diagnostic lines", () => {
  const raw = '[plugins] loading...\n{"tabs": []}';
  assert.deepEqual(parseOpenClawJson(raw), { tabs: [] });
});

test("parses JSON with leading and trailing noise", () => {
  const raw = '[plugins] loading...\n{"cdpPort":"18810"}\n[tail] done';
  assert.deepEqual(parseOpenClawJson(raw), { cdpPort: "18810" });
});

test("parses top-level arrays", () => {
  const raw = '[plugins] loading...\n[{"targetId":"1"}]';
  assert.deepEqual(parseOpenClawJson(raw), [{ targetId: "1" }]);
});

test("parses nested objects and arrays", () => {
  const raw = '[plugins] loading...\n{"tabs":[{"targetId":"1","meta":{"tags":["a","b"]}}]}';
  assert.deepEqual(parseOpenClawJson(raw), {
    tabs: [{ targetId: "1", meta: { tags: ["a", "b"] } }],
  });
});

test("preserves braces inside JSON strings", () => {
  const raw = '{"msg":"use {braces} here"}';
  assert.deepEqual(parseOpenClawJson(raw), { msg: "use {braces} here" });
});

test("preserves escaped quotes and backslashes", () => {
  const raw = '{"path":"C:\\\\Users\\\\ted","quote":"say \\"hi\\""}';
  assert.deepEqual(parseOpenClawJson(raw), {
    path: "C:\\Users\\ted",
    quote: 'say "hi"',
  });
});

test("ignores log lines that look like partial JSON", () => {
  const raw = '[plugins] config: {"verbose": true\n{"tabs": []}';
  assert.deepEqual(parseOpenClawJson(raw), { tabs: [] });
});

test("parses primitive JSON values after leading noise", () => {
  assert.equal(parseOpenClawJson('[plugins] loading...\n123'), 123);
  assert.equal(parseOpenClawJson('[plugins] loading...\n"ok"'), "ok");
  assert.equal(parseOpenClawJson('[plugins] loading...\ntrue'), true);
  assert.equal(parseOpenClawJson('[plugins] loading...\nnull'), null);
});

test("throws on empty input", () => {
  assert.throws(() => parseOpenClawJson(" \n\t "), /OpenClaw returned empty output/);
});

test("throws with a raw preview when no valid JSON exists", () => {
  assert.throws(
    () => parseOpenClawJson("[plugins] loading...\nnot json"),
    /Raw \(preview\): \[plugins\] loading\.\.\./,
  );
});
