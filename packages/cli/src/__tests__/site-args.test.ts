/**
 * site adapter 参数解析测试
 *
 * 回归背景：CLI 的全局 parseArgs 会丢弃未识别的 `--flag`（`--status` / `--id` / `--type`
 * / `--limit` / `--filter` / `--since` / `--tab` / `--jq` 等还会连值一起丢），
 * 结果是 adapter 收到错误的参数、甚至静默返回全量数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFlagPairs, parseSiteArgs, sliceAfter } from "../site-args.js";

const ARGS = {
  status: { required: false, description: "任务状态" },
  bizId: { required: false, description: "业务 ID" },
  size: { required: false, description: "每页条数" },
};

test("位置参数按声明顺序填充", () => {
  assert.deepEqual(parseSiteArgs(["FAIL", "biz_1", "20"], ARGS), {
    status: "FAIL",
    bizId: "biz_1",
    size: "20",
  });
});

test("adapter 自己的 --flag 能被解析（回归：之前会被全局 parseArgs 吞掉）", () => {
  assert.deepEqual(parseSiteArgs(["--status", "FAIL", "--size", "20"], ARGS), {
    status: "FAIL",
    size: "20",
  });
});

test("位置参数 + --flag 混用", () => {
  assert.deepEqual(parseSiteArgs(["FAIL", "--size", "20"], ARGS), {
    status: "FAIL",
    size: "20",
  });
});

test("--flag 的值不会漏进位置参数（之前会挤占下一个字段）", () => {
  assert.deepEqual(parseSiteArgs(["biz_1", "--status", "FAIL"], ARGS), {
    bizId: "biz_1",
    status: "FAIL",
  });
});

test("CLI 全局 flag 及其值被跳过，不污染位置参数", () => {
  assert.deepEqual(
    parseSiteArgs(["--jq", ".items[].taskId", "FAIL", "--tab", "0a8d"], ARGS),
    { status: "FAIL" }
  );
});

test("adapter 自己声明的 flag 优先于同名全局 flag", () => {
  assert.deepEqual(parseSiteArgs(["--status", "FAIL"], ARGS), { status: "FAIL" });
});

test("未知 flag 与短 flag 被忽略", () => {
  assert.deepEqual(parseSiteArgs(["-i", "--unknown", "FAIL"], ARGS), { status: "FAIL" });
});

test("未知 --flag 后面那个 token 会落到位置参数（无法判断它是不是该 flag 的值）", () => {
  assert.deepEqual(parseSiteArgs(["--nope", "FAIL"], ARGS), { status: "FAIL" });
});

test("超出声明数量的位置参数被忽略", () => {
  assert.deepEqual(parseSiteArgs(["a", "b", "c", "d"], ARGS), {
    status: "a",
    bizId: "b",
    size: "c",
  });
});

test("adapter 没有参数声明时不报错", () => {
  assert.deepEqual(parseSiteArgs(["--json"], {}), {});
});

// ---- parseFlagPairs（无 adapter meta 的兜底解析）----

test("parseFlagPairs 只认 --key value", () => {
  assert.deepEqual(parseFlagPairs(["--head", "user:branch", "positional"]), { head: "user:branch" });
});

// ---- sliceAfter ----

test("sliceAfter 取出 adapter 名之后的原始 token", () => {
  assert.deepEqual(
    sliceAfter(["site", "isagentos/tasks", "--status", "FAIL"], "isagentos/tasks"),
    ["--status", "FAIL"]
  );
});

test("sliceAfter 在找不到名字时返回 undefined（调用方回退到 parsed.args）", () => {
  assert.equal(sliceAfter(["site", "list"], "isagentos/tasks"), undefined);
  assert.equal(sliceAfter(undefined, "isagentos/tasks"), undefined);
});
