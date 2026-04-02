# bb-browser Harness Test Scenarios

这些场景用于验证 bb-browser 对 AI Agent 的可用性。每次大改后应该让 Agent 执行这些场景。

## 前提条件

- Chrome 已启动并开启 CDP: `--remote-debugging-port=19222`
- Daemon 已运行: `bb-browser-daemon --cdp-port 19222`
- 或者直接使用 `bb` CLI（内部会自动管理 daemon）

## 场景 1: 搜索工作流

验证从打开网站到搜索结果的完整流程。

**步骤：**
1. `open` 打开一个搜索引擎（如 Bing 或 DuckDuckGo）
2. `get --attribute title` 确认页面加载成功
3. `snapshot --interactive` 获取可交互元素列表
4. `fill --ref <搜索框ref> --text "test query"` 填写搜索框
5. `press --key Enter` 提交搜索
6. `wait --ms 2000` 等待结果加载
7. `snapshot` 查看搜索结果页
8. `network --since last_action` 查看增量网络请求

**验证点：**
- `open` 返回短 tab ID（`data.tab` 是 4 位字符串）
- `snapshot --interactive` 包含可操作的 `[ref=N]` 引用
- `fill` + `press` 组合可以完成搜索表单提交
- `network --since last_action` 返回增量请求（只有搜索触发的请求）
- `data.cursor` 是 number 类型，可用于下次增量查询

## 场景 2: 多 Tab 工作流

验证跨标签页操作的隔离性和切换。

**步骤：**
1. `tab_list` 获取当前标签页列表
2. `open --url "https://example.com"` 打开第一个页面
3. `open --url "https://httpbin.org/html"` 打开第二个页面（新 tab）
4. `tab_list` 确认两个 tab 都存在
5. `tab_select --tabId <tab1的shortId>` 切换到第一个 tab
6. `eval --script "document.title"` 验证是 example.com
7. `tab_select --tabId <tab2的shortId>` 切换到第二个 tab
8. `eval --script "document.title"` 验证是 httpbin
9. `network --tabId <tab1> --networkCommand requests` 查看 tab1 的网络请求
10. `network --tabId <tab2> --networkCommand requests` 查看 tab2 的网络请求
11. `tab_close --tabId <tab2>` 关闭第二个 tab
12. `tab_list` 确认只剩一个 tab

**验证点：**
- 每个 `open` 返回不同的短 tab ID
- `tab_list` 中每个 tab 有 `tab` (string), `url`, `title`, `active` (boolean)
- 网络请求按 tab 隔离（tab1 的请求不会出现在 tab2 中）
- `tab_close` 后 `tab_list` 正确更新

## 场景 3: 表单填写 + API 逆向

验证表单交互和网络请求捕获能力。

**步骤：**
1. `open --url "https://httpbin.org/forms/post"` 打开表单页
2. `snapshot --interactive` 获取表单元素
3. `fill --ref <姓名字段ref> --text "Test User"` 填写姓名
4. `fill --ref <邮件字段ref> --text "test@example.com"` 填写邮件
5. `click --ref <提交按钮ref>` 提交表单
6. `wait --ms 2000` 等待提交完成
7. `network --since last_action --method POST` 查看 POST 请求
8. `network --since last_action --method POST --withBody true` 获取请求体
9. `eval --script "document.body.innerText"` 查看响应页面内容

**验证点：**
- `fill` 操作对每个字段返回 `success: true` 和 `data.seq`
- `click` 提交按钮触发表单提交
- `network --method POST` 可以过滤出 POST 请求
- `--withBody true` 可以获取请求体和响应体内容
- 每个 `NetworkRequestInfo` 有 `requestId`, `url`, `method`, `type`, `timestamp`

## 场景 4: Console/Error 监控

验证控制台和错误捕获的增量查询能力。

**步骤：**
1. `open --url "about:blank"` 打开空白页
2. `eval --script "console.log('hello'); console.warn('warning'); console.error('oops')"` 触发控制台输出
3. `console --consoleCommand get` 获取所有控制台消息
4. `eval --script "throw new Error('test error')"` 触发 JS 错误
5. `errors --errorsCommand get` 获取所有 JS 错误
6. 记录 `data.cursor` 值
7. `eval --script "console.log('new message')"` 再次触发输出
8. `console --consoleCommand get --since <cursor>` 增量获取新消息
9. `console --consoleCommand get --filter "warning"` 按关键词过滤

**验证点：**
- `consoleMessages` 数组中每条消息有 `type` ('log'|'info'|'warn'|'error'), `text`, `timestamp`
- `jsErrors` 数组中每条错误有 `message`, `timestamp`
- `data.cursor` 是 number，可用于 `--since` 增量查询
- `--since` 返回的结果不包含之前已查询过的消息
- `--filter` 按文本子串过滤

## 场景 5: 页面导航 + Snapshot 缓存失效

验证页面导航后 ref 缓存正确失效。

**步骤：**
1. `open --url "https://example.com"` 打开页面
2. `snapshot --interactive` 获取元素引用
3. 记录某个 ref 编号
4. `open --url "https://httpbin.org/html" --tabId <当前tab>` 在同一 tab 导航
5. 使用旧 ref 尝试 `click`，应该报错（Unknown ref）
6. `snapshot --interactive` 重新获取新页面的引用
7. `back` 后退
8. `snapshot --interactive` 后退后重新获取

**验证点：**
- 导航后旧 ref 失效，返回错误 "Unknown ref: N. Run snapshot first."
- `back`/`forward` 返回 `data.tab` 和 `data.seq`
- 每次 `snapshot` 返回的 `refs` 对应新页面内容

## 场景 6: Trace 录制

验证操作录制功能。

**步骤：**
1. `trace --traceCommand start` 开始录制
2. 执行几个操作（open, click, fill 等）
3. `trace --traceCommand status` 检查录制状态
4. `trace --traceCommand stop` 停止录制并获取事件

**验证点：**
- `traceCommand: start` 返回 `traceStatus.recording: true`
- `traceCommand: status` 返回 `traceStatus.eventCount` (number)
- `traceCommand: stop` 返回 `traceEvents` (array) 和 `traceStatus.recording: false`

## 如何执行

用 AI Agent（Claude Code、Codex、Gemini CLI 等）执行以上场景，使用 bb-browser daemon HTTP API。

```bash
# 启动 Chrome（如果没有运行）
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=19222 &

# 启动 daemon
cd /path/to/bb-browser
pnpm --filter @bb-browser/daemon build
node packages/daemon/dist/daemon.js --cdp-port 19222

# 让 Agent 通过 HTTP 执行场景
# POST http://127.0.0.1:19824/command
# GET  http://127.0.0.1:19824/status
```

Agent 的反馈即 harness 改进方向。常见改进信号：
- 某个步骤返回意外的响应格式 → 需要更新 protocol.ts 或 command-dispatch.ts
- 某个操作超时或失败 → 需要增加 wait 或改进 CDP 命令
- 增量查询返回错误的条目数 → 需要检查 seq/cursor 逻辑
- Agent 无法理解 snapshot 输出 → 需要优化可访问性树格式

## 场景 7: 冷启动 + PID 残留恢复

验证 daemon 被异常终止后 CLI 能自动恢复。

**步骤：**
1. 启动 daemon，确认 `~/.bb-browser/daemon.json` 存在
2. `kill -9 <daemon-pid>` 强制杀进程
3. 确认 `daemon.json` 残留（未被正常清理）
4. 运行 `bb-browser eval "1+1"` — CLI 应检测到 PID 不存活，删除旧文件，重新 spawn daemon
5. 验证命令正常返回结果

**验证点：**
- daemon.json 包含 pid, host, port, token
- PID 不存活时自动清理并重启
- 新 daemon 写入新的 daemon.json
- 不依赖硬编码地址，使用 daemon.json 中的 host:port

## 自动化执行建议

可以用 protocol-drift.test.ts 作为基线，在 CI 中（有 Chrome headless 时）自动验证。
对于需要真实网络的场景（搜索、httpbin），建议手动或在专用测试环境中执行。
