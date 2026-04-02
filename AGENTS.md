# bb-browser Agent 开发规范

## 架构

```
CLI (packages/cli) ──HTTP──▶ Daemon (packages/daemon) ──CDP WebSocket──▶ Chrome
MCP (packages/mcp) ──HTTP──┘       │
                              ┌────┴────┐
                              │  HTTP   │
                              │ Server  │
                              └────┬────┘
                                   │
                         ┌─────────┼─────────┐
                         │         │         │
                    CdpConnection  │  CommandDispatch
                    (WebSocket)    │  (request → handler)
                                   │
                            TabStateManager
                            (短 ID, seq 序号,
                             per-tab 事件缓冲)
```

**Daemon 组件：**

- **CdpConnection** — 维持到 Chrome DevTools Protocol 的 WebSocket 长连接。自动发现 Chrome，管理 session 复用（每个 tab 一个 session）。
- **TabStateManager** — 管理 per-tab 状态。分配短 ID（targetId 末 4+ 位 hex，保证唯一）。维护全局单调递增 `seq` 计数器。每个 tab 持有环形缓冲事件集合（network/console/errors）。
- **CommandDispatch** — 将 `Request.action` 映射到处理函数。所有处理器接收 `CdpConnection` 和解析后的 `TabState`，返回带 `tab`（短 ID）和 `seq` 的 `Response`。

**核心概念：**

- **短 tab ID** — 取 CDP targetId 末尾，最少 4 字符，碰撞时自动扩展。所有请求/响应中用短 ID 标识 tab。
- **seq 计数器** — 全局单调递增整数，每次操作和每个捕获事件都递增。支持 `since` 过滤做增量查询。
- **Per-tab 事件缓冲** — 环形缓冲（network: 500 条, console: 200 条, errors: 100 条），带 seq 标签。通过 `since`、`filter`、`method`、`status`、`limit` 查询。

共享类型定义：`packages/shared/src/protocol.ts`

## 添加新命令

3 个文件：

1. `packages/shared/src/protocol.ts` — 添加 ActionType + Request 字段 + ResponseData 字段
2. `packages/daemon/src/command-dispatch.ts` — 在 `dispatchRequest` 中添加处理分支
3. `packages/cli/src/commands/<name>.ts` + `packages/cli/src/index.ts` — CLI 命令 + 路由

可选：`packages/mcp/src/index.ts` — 如果需要暴露为 MCP tool

## 设计不变量

改代码前必读。违反任何一条都是 bug。

- **INV-1:** 所有操作响应必须包含 `tab`（短 ID）和 `seq`（序号）
- **INV-2:** 观察类响应（network/console/errors）必须包含 `cursor`
- **INV-3:** 无效 tab ID 必须报错，不允许静默 fallback
- **INV-4:** `seq` 全局单调递增，不可回退
- **INV-5:** per-tab 事件隔离 — tab A 的事件不会出现在 tab B 的查询中
- **INV-6:** tab 关闭时释放短 ID，清除事件缓冲
- **INV-7:** `tab_new` 在零 tab 时仍可工作（在 `ensurePageTarget` 之前处理）

## UX 规范（Agent 和人类双用户）

bb-browser 有两类用户：**人类**（直接用 CLI）和 **AI Agent**（通过 bash/MCP 调用）。Agent 是桥梁 — 读取 bb-browser 输出并翻译给人类。每个文本表面都要同时服务两者。

### `site list` 描述

公式：`{动作} ({English keywords}: {核心返回字段})`

```
# 差 — Agent 无法按任务匹配
获取雪球股票实时行情

# 好 — 双语可搜索，显示返回内容
股票实时行情 (stock quote: price, change%, market cap)
```

### `site info <name>`

Agent 的函数签名。暴露完整 @meta：
- `args` 含 required/optional 和描述
- `example` 含可执行的命令
- `readOnly`、`domain`

### JSON 字段命名

字段名就是 Agent 向人类解释数据的词汇。

| 规则 | 差 | 好 |
|------|-----|------|
| 完整英文单词 | `chgPct` | `changePercent` |
| 值带单位 | `155` | `"1.55%"` |
| 大数可读 | `177320000000` | `"1.77万亿"` |
| 始终包含 URL | (缺失) | `"url": "https://..."` |
| ISO 时间戳 | `1710000000` | `"2026-03-15T01:40:31.000Z"` |

### 错误结构

每个错误必须有三个字段：

```json
{
  "error": "HTTP 401",
  "hint": "需要先登录雪球，请先在浏览器中打开 xueqiu.com 并登录",
  "action": "bb-browser open https://xueqiu.com"
}
```

- `error` — 技术原因（Agent 判断是否可自动修复）
- `hint` — 人类可读解释（Agent 无法自动修复时原样转达）
- `action` — 可执行的修复命令，可为空（Agent 优先尝试执行）

### 命令后提示

每个有自然下一步的命令输出应包含一行提示：

```
# site update 之后：
💡 运行 bb-browser site recommend 看看哪些和你的浏览习惯匹配
```

### `--help` 分组

按用户意图分组，最重要的在前：

1. **开始使用** — site recommend, site list, site info, site, guide
2. **浏览器操作** — open, snapshot, click, fill, type, press, scroll
3. **页面信息** — get, screenshot, eval, fetch
4. **标签页** — tab
5. **调试** — network, console, errors, trace, history

### `site recommend`

人类和 Agent 的首要入门命令：
- 交叉引用 `history domains` 和 `site list`
- 显示 "available"（含示例命令）和 "not_available"（含访问次数）
- JSON 输出结构化，适合 Agent 能力引导

## 代码规范

- Commit message：`<type>(<scope>): <summary>`，英文
- 类型：`fix` / `feat` / `refactor` / `chore` / `docs`
- 用户面文本用中文，代码/注释用英文
- 遵循现有模式：添加新 CLI 命令前先读 `trace.ts`
- 构建：在仓库根目录执行 `pnpm build`
- site adapter 不需要写测试

## 测试

- `pnpm test` — 运行所有测试（通过 turbo 编排）
- `pnpm build` — 类型安全检查（提交前必须运行）
- `pnpm lint` — 代码风格（daemon, mcp, shared）

测试分层：
- **单元测试** — 数据结构（RingBuffer、TabState、短 ID 生成）
- **契约测试** — 协议一致性、设计不变量验证
