# bb-browser MCP HTTP API 参考

---

## 环境变量

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `BB_MCP_TOKEN` | `my-secret` | Bearer token |
| `BB_MCP_URL` | `http://10.27.6.105:13337/mcp` | MCP 端点完整地址 |

---

## 端点 & 认证

```
POST ${BB_MCP_URL}
Authorization: Bearer ${BB_MCP_TOKEN}
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Session-Id: <握手后获得，后续请求必须携带>
```

---

## 初始化握手

每个 session 必须先发一次，响应头中的 `Mcp-Session-Id` 用于后续所有请求：

```bash
curl -X POST "${BB_MCP_URL:-http://10.27.6.105:13337/mcp}" \
  -H "Authorization: Bearer ${BB_MCP_TOKEN:-my-secret}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -D - \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "client", "version": "1.0"}
    }
  }'
```

> **推荐**：直接用 `call_mcp.py`，session 握手与缓存自动处理，无需手动管理。

---

## 工具调用格式

```bash
curl -X POST "${BB_MCP_URL:-http://10.27.6.105:13337/mcp}" \
  -H "Authorization: Bearer ${BB_MCP_TOKEN:-my-secret}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <sid>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "browser_open",
      "arguments": {"url": "https://example.com"}
    }
  }'
```

响应结构：
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [{"type": "text", "text": "{...}"}]
  }
}
```
`text` 字段为 JSON 字符串，需二次 parse。`call_mcp.py` 的 `call_tool()` 已自动完成解包。

---

## 完整工具列表

> 所有工具均支持可选的 `tab` 参数（短 ID，如 `"c416"`），省略时操作当前活动标签页。

### 导航类

| 工具名 | 必填参数 | 可选参数 |
|--------|---------|---------|
| `browser_open` | `url` | `tab` |
| `browser_back` | — | `tab` |
| `browser_forward` | — | `tab` |
| `browser_refresh` | — | `tab` |
| `browser_close` | — | `tab` |

### 观察类

| 工具名 | 必填参数 | 可选参数 |
|--------|---------|---------|
| `browser_snapshot` | — | `interactive`(bool), `compact`(bool), `maxDepth`(int), `selector`(CSS), `tab` |
| `browser_screenshot` | — | `tab` |
| `browser_get` | `attribute`（`text`/`url`/`title`/`value`/`html`） | `ref`（指定元素，省略则取页面级值）, `tab` |

### 交互类

| 工具名 | 必填参数 | 可选参数 |
|--------|---------|---------|
| `browser_click` | `ref` | `tab` |
| `browser_hover` | `ref` | `tab` |
| `browser_fill` | `ref`, `text` | `tab` |
| `browser_type` | `ref`, `text` | `tab` |
| `browser_check` | `ref` | `tab` |
| `browser_uncheck` | `ref` | `tab` |
| `browser_select` | `ref`, `value` | `tab` |
| `browser_press` | `key`（见下方格式说明） | `tab` |
| `browser_scroll` | `direction`（`up`/`down`/`left`/`right`） | `pixels`（默认 300）, `tab` |
| `browser_eval` | `script` | `tab` |

### 系统类

| 工具名 | 必填参数 | 可选参数 |
|--------|---------|---------|
| `browser_wait` | — | `ms`（默认 1000）, `tab` |
| `browser_dialog` | `dialogResponse`（`accept`/`dismiss`） | `promptText`（prompt 类型时的输入值）, `tab` |
| `browser_frame` | `selector`（CSS 选择器） | `tab` |
| `browser_frame_main` | — | `tab` |

### 标签页类

| 工具名 | 必填参数 | 可选参数 |
|--------|---------|---------|
| `browser_tab_list` | — | — |
| `browser_tab_new` | — | `url`（默认 about:blank） |
| `browser_tab_select` | — | `tab`（短 ID）, `index`（0-based） |
| `browser_tab_close` | — | `tab`（短 ID）, `index`（0-based） |
| `browser_close_all` | — | — |

### 网络/观测类

| 工具名 | 必填参数 | 可选参数 |
|--------|---------|---------|
| `browser_network` | — | `networkCommand`（`requests`/`clear`/`route`/`unroute`，默认 `requests`）, `filter`(URL 关键词), `since`, `method`, `status`, `limit`, `withBody`(bool), `tab` |
| `browser_console` | — | `consoleCommand`（`get`/`clear`，默认 `get`）, `filter`, `since`, `limit`, `tab` |
| `browser_errors` | — | `errorsCommand`（`get`/`clear`，默认 `get`）, `filter`, `since`, `limit`, `tab` |
| `browser_trace` | `traceCommand`（`start`/`stop`/`status`） | `tab` |
| `browser_history` | `historyCommand`（`search`/`domains`） | `query`（search 时使用）, `days`（默认 30） |

### Site 适配器类

| 工具名 | 必填参数 | 可选参数 |
|--------|---------|---------|
| `site_list` | — | — |
| `site_search` | `query` | — |
| `site_info` | `name`（如 `twitter/search`） | — |
| `site_recommend` | — | `days`（分析最近 N 天历史） |
| `site_run` | `name` | `args`（字符串数组，按序传给 adapter）, `namedArgs`（键值对）, `tab` |
| `site_update` | — | — |

---

## 参数说明

### `since` 增量查询（network / console / errors）

- `"last_action"` — 返回上次操作之后的新事件
- 数字（seq 序号）— 返回该序号之后的事件
- 响应中包含 `cursor` 字段，可作为下次查询的 `since` 值

```bash
# 第一次查询
--tool browser_network --args '{}'
# 返回：{"requests": [...], "cursor": 42}

# 增量查询（只返回新增请求）
--tool browser_network --args '{"since": 42}'
```

### `tab` 短 ID

- 格式：4 位以上十六进制字符串，如 `"c416"`
- 来源：`browser_tab_list`、`browser_open`、`browser_tab_new` 的响应中 `tab` 字段
- 省略时操作当前活动标签页

### `browser_press` 按键格式

- 单键：`"Enter"`、`"Tab"`、`"Escape"`、`"ArrowDown"`
- 组合键：`"Control+a"`、`"Shift+Tab"`、`"Meta+r"`

### `browser_screenshot` 返回格式

返回 `{"type": "image", "data": "<base64>", "mimeType": "image/png"}`，`data` 字段为 PNG 的 base64 编码。

---

## 故障排查

| 错误 | 原因 | 解决 |
|------|------|------|
| `Connection refused` / `timed out` | MCP Server 未启动或网络不通 | 确认远程主机 `bb-browser --mcp --http` 进程在运行；检查防火墙 |
| `401 Unauthorized` | token 错误 | 核对 `BB_MCP_TOKEN` 是否与远程启动时一致 |
| `503 Service Unavailable` | Chrome 未连接到 Daemon | 重启远程 bb-browser daemon |
| `Chrome is not connected` | Daemon 未连 Chrome | 重启 bb-browser daemon |
| `Session not found or expired` | 会话 ID 失效（服务端重启） | `call_mcp.py` 自动重握手；手动时删除 `~/.bb-browser/mcp-session` 重试 |
| 工具调用超时 | 操作耗时长 | exec timeout 设 ≥ 120 秒，截图/发帖建议 180 秒 |
