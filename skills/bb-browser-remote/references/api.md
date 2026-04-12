# bb-browser Daemon REST API 参考

---

## 环境变量

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `BB_DAEMON_TOKEN` | `my-secret` | Bearer token |
| `BB_DAEMON_URL` | `http://10.27.6.105:19824` | daemon 端点完整地址 |

---

## 端点 & 认证

```
POST ${BB_DAEMON_URL}/command   → 浏览器操作
POST ${BB_DAEMON_URL}/site      → site adapter 命令
GET  ${BB_DAEMON_URL}/status    → daemon 健康检查

Authorization: Bearer ${BB_DAEMON_TOKEN}
Content-Type: application/json
```

每次调用是独立的 HTTP 请求，无需预先建立连接或维持会话。

---

## POST /command — 浏览器操作

请求格式：
```json
{
  "id": "<uuid>",
  "action": "<动作名>",
  ...其他参数
}
```

响应格式：
```json
{
  "id": "<uuid>",
  "success": true,
  "data": { ... }
}
```

失败时：
```json
{
  "id": "<uuid>",
  "success": false,
  "error": "错误描述",
  "hint": "解决提示（可选）"
}
```

`call_daemon.py` 的 `browser_command()` 已自动处理错误与解包，正常情况直接使用脚本即可。

---

## POST /site — Site Adapter 命令

请求格式：
```json
{
  "command": "run",
  "name": "twitter/search",
  "args": ["Claude Code"],
  "namedArgs": {},
  "tab": "c416"
}
```

响应格式：
```json
{
  "success": true,
  "data": { ... }
}
```

支持的 command 值：

| command | 说明 | 必填字段 |
|---------|------|---------|
| `list` | 列出所有 adapter | — |
| `search` | 搜索 adapter | `query` |
| `info` | 查看 adapter 详情 | `name` |
| `recommend` | 基于历史推荐 | — |
| `run` | 运行 adapter | `name` |
| `update` | 更新社区 adapter 库 | — |

---

## GET /status — daemon 健康检查

```bash
python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_daemon.py --status
```

响应：
```json
{
  "running": true,
  "cdpConnected": true,
  "uptime": 1234,
  "tabs": [...]
}
```

---

## 完整动作列表（POST /command）

> 所有动作均支持可选的 `tabId` 参数（短 ID，如 `"c416"`），省略时操作当前活动标签页。

### 导航类

| action | 必填参数 | 可选参数 |
|--------|---------|---------|
| `open` | `url` | `tabId` |
| `back` | — | `tabId` |
| `forward` | — | `tabId` |
| `refresh` | — | `tabId` |
| `close` | — | `tabId` |

### 观察类

| action | 必填参数 | 可选参数 |
|--------|---------|---------|
| `snapshot` | — | `interactive`(bool), `compact`(bool), `maxDepth`(int), `selector`(CSS), `tabId` |
| `screenshot` | — | `tabId` |
| `get` | `attribute`（`text`/`url`/`title`/`value`/`html`） | `ref`（指定元素，省略则取页面级值）, `tabId` |

### 交互类

| action | 必填参数 | 可选参数 |
|--------|---------|---------|
| `click` | `ref` | `tabId` |
| `hover` | `ref` | `tabId` |
| `fill` | `ref`, `text` | `tabId` |
| `type` | `ref`, `text` | `tabId` |
| `check` | `ref` | `tabId` |
| `uncheck` | `ref` | `tabId` |
| `select` | `ref`, `value` | `tabId` |
| `press` | `key`（见下方格式说明） | `tabId` |
| `scroll` | `direction`（`up`/`down`/`left`/`right`） | `pixels`（默认 300）, `tabId` |
| `eval` | `script` | `tabId` |

### 系统类

| action | 必填参数 | 可选参数 |
|--------|---------|---------|
| `wait` | — | `ms`（默认 1000）, `tabId` |
| `dialog` | `dialogResponse`（`accept`/`dismiss`） | `promptText`（prompt 类型时的输入值）, `tabId` |
| `frame` | `selector`（CSS 选择器） | `tabId` |
| `frame_main` | — | `tabId` |

### 标签页类

| action | 必填参数 | 可选参数 |
|--------|---------|---------|
| `tab_list` | — | — |
| `tab_new` | — | `url`（默认 about:blank） |
| `tab_select` | — | `tabId`（短 ID）, `index`（0-based） |
| `tab_close` | — | `tabId`（短 ID）, `index`（0-based） |

### 网络/观测类

| action | 必填参数 | 可选参数 |
|--------|---------|---------|
| `network` | — | `networkCommand`（`requests`/`clear`/`route`/`unroute`，默认 `requests`）, `filter`(URL 关键词), `since`, `method`, `status`, `limit`, `withBody`(bool), `tabId` |
| `console` | — | `consoleCommand`（`get`/`clear`，默认 `get`）, `filter`, `since`, `limit`, `tabId` |
| `errors` | — | `errorsCommand`（`get`/`clear`，默认 `get`）, `filter`, `since`, `limit`, `tabId` |
| `trace` | `traceCommand`（`start`/`stop`/`status`） | `tabId` |
| `history` | `historyCommand`（`search`/`domains`） | `query`（search 时使用）, `days`（默认 30） |

---

## 参数说明

### `since` 增量查询（network / console / errors）

- `"last_action"` — 返回上次操作之后的新事件
- 数字（seq 序号）— 返回该序号之后的事件
- 响应中包含 `cursor` 字段，可作为下次查询的 `since` 值

```bash
SCRIPT=~/.openclaw/skills/bb-browser-remote/scripts/call_daemon.py

# 第一次查询
python3 $SCRIPT --action network --args '{}'
# 返回 data: {"networkRequests": [...], "cursor": 42}

# 增量查询（只返回新增请求）
python3 $SCRIPT --action network --args '{"since": 42}'
```

### `tabId` 短 ID

- 格式：4 位以上十六进制字符串，如 `"c416"`
- 来源：`tab_list`、`open`、`tab_new` 的响应 `data.tab` 字段
- 省略时操作当前活动标签页

### `press` 按键格式

- 单键：`"Enter"`、`"Tab"`、`"Escape"`、`"ArrowDown"`
- 组合键：`"Control+a"`、`"Shift+Tab"`、`"Meta+r"`
- daemon 会自动拆分修饰键，无需手动分拆

### `screenshot` 返回格式

`call_daemon.py` 已自动转换，直接输出：
```json
{"type": "image", "data": "<base64>", "mimeType": "image/png"}
```

---

## 故障排查

| 错误 | 原因 | 解决 |
|------|------|------|
| `Connection refused` / `timed out` | daemon 未启动或网络不通 | 确认远程主机 `bb-browser daemon` 进程在运行；检查防火墙 |
| `401 Unauthorized` | token 错误 | 核对 `BB_DAEMON_TOKEN` 是否与远程启动时一致 |
| `503` / `Chrome not connected` | Chrome 未连接到 daemon | 重启远程 `bb-browser daemon` |
| `Tab not found` | tab ID 无效或标签已关闭 | 重新用 `tab_list` 获取当前 tab 列表 |
| `Command timeout` | 操作耗时超过 30s | 检查页面是否卡死；`--timeout` 参数无法突破 daemon 内部 30s 硬限制 |
