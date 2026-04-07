# bb-browser MCP HTTP 远程模式

## 背景

**问题**：OpenClaw 部署在远程服务器，无法访问外网，但本机有 Chrome 浏览器和外网访问权限。

**解决思路**：在本机启动 bb-browser，通过 HTTP 将 MCP 接口暴露给远程 OpenClaw 调用。

**原有限制**：MCP 原本只支持 `StdioServerTransport`（本地进程间通信），无法跨网络访问。

**本次改造**：新增 `--http` 启动模式，使用 `StreamableHTTPServerTransport`，让远程客户端可通过 HTTP 调用 MCP。

---

## 代码改动

### 改动 1：`packages/mcp/src/index.ts`

新增 HTTP 传输模式和参数解析，并修复进程退出问题；随后修复了多 session 并发 bug。

**1.1 新增 HTTP 模式**

```diff
+ import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
+ import { createServer } from "node:http";
+ import { randomBytes } from "node:crypto";

  export async function startMcpServer() {
    const transport = new StdioServerTransport();  // 原有 stdio 模式不变
    await server.connect(transport);
  }

+ // 新增：HTTP 模式，允许远程客户端通过网络调用 MCP
+ export async function startMcpHttpServer(options: {
+   host: string;
+   port: number;
+   token?: string;
+ }): Promise<void> {
+   // ... 启动 HTTP server，打印日志 ...
+
+   // 保持进程持续运行，直到 SIGINT/SIGTERM（否则进程会在启动后立即退出）
+   await new Promise<void>((resolve) => {
+     process.on("SIGINT", () => { httpServer.close(); resolve(); });
+     process.on("SIGTERM", () => { httpServer.close(); resolve(); });
+   });
+ }
+
+ // 启动时根据参数选择模式
+ if (process.argv.includes("--http")) {
+   startMcpHttpServer({ host, port, token });   // HTTP 模式（远程）
+ } else {
+   startMcpServer();                             // stdio 模式（本地，默认）
+ }
```

> **注意**：`startMcpHttpServer` 末尾等待 SIGINT/SIGTERM 信号是关键——没有这个 `await`，Node.js 进程在 `httpServer.listen` 回调执行完后会立即退出，导致服务器只打印日志就关闭。

**1.2 修复多 session 并发 bug（`McpServer` 单例问题）**

**根因**：原来 `server` 是全局单例，每次新 HTTP session 建立时都调用 `server.connect(transport)`，但 `McpServer` 不支持绑定多个 transport——第二个 session 的 `connect()` 会覆盖内部状态，导致第一个 session 的工具响应永远发不回去，OpenClaw 一直挂起等待。

```diff
- // 全局单例（bug：多 session 共享同一 McpServer 实例）
- const server = new McpServer({ name: "bb-browser", version: ... }, { instructions: ... });
- // ... 注册工具 ...
-
- // HTTP session 建立时：
- server.connect(transport)   // ← 第 2 个 session 会覆盖第 1 个的状态！

+ // 工厂函数：每个 HTTP session 创建独立的 McpServer 实例
+ function createMcpServer() {
+   // per-session tab 追踪（不再全局共享）
+   const sessionOpenedTabs = new Set<string>();
+   function rememberSessionTab(...) { ... }
+   function forgetSessionTab(...) { ... }
+
+   const server = new McpServer({ name: "bb-browser", version: ... }, { instructions: ... });
+   // ... 注册工具 ...
+   return server;
+ }
+
+ // HTTP session 建立时：
+ const sessionServer = createMcpServer();  // ← 每个 session 独立实例
+ sessionServer.connect(transport);
```

顺带修复：`sessionOpenedTabs`（记录本次 session 打开的 tab）也挪进了工厂函数内部，实现真正的 per-session 隔离——之前是全局 `Set`，所有 session 共享。

### 改动 2：`packages/cli/src/index.ts`

修复 `--mcp` 启动时透传参数（原来丢弃了 `--http` 等额外参数）：

```diff
  if (process.argv.includes("--mcp")) {
    const mcpPath = fileURLToPath(new URL("./mcp.js", import.meta.url));
    const { spawn } = await import("node:child_process");
-   const child = spawn(process.execPath, [mcpPath], { stdio: "inherit" });
+   // 透传 --http / --http-host / --http-port / --http-token 给 MCP 进程
+   const mcpArgv = process.argv.slice(2).filter(a => a !== "--mcp");
+   const child = spawn(process.execPath, [mcpPath, ...mcpArgv], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
```

---

## 架构图

```
OpenClaw 远程服务器（无外网）
         │
         │  HTTP POST /mcp
         │  Authorization: Bearer <token>
         ▼
本机 MCP HTTP Server  ←  bb-browser --mcp --http --http-host 0.0.0.0
  (0.0.0.0:13337)
         │
         │  本地调用
         ▼
本机 bb-browser Daemon
  (127.0.0.1:19824)
         │
         │  CDP WebSocket
         ▼
本机 Chrome 浏览器（有外网访问权限）
```

---

## 使用方法

### 前置准备：构建并安装

```bash
cd bb-browser
pnpm build
npm install -g .
```

安装完成后 `bb-browser` 命令即可全局使用。

---

### 一键启动脚本（推荐）

将以下内容保存为 `start-bb-browser.sh`：

```bash
#!/bin/bash
# 1. 启动 Edge（后台，日志静默）
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port=19825 \
  --user-data-dir="$HOME/.bb-browser/browser/user-data" \
  --no-first-run \
  --no-default-browser-check \
  about:blank \
  > /dev/null 2>&1 &

echo "[1/2] Edge 启动中，等待 2 秒..."
sleep 2

# 2. 启动 MCP HTTP Server（前台保持运行，daemon 会自动启动）
echo "[2/2] 启动 MCP HTTP Server..."
bb-browser --mcp --http \
  --http-host 0.0.0.0 \
  --http-port 13337 \
  --http-token "${BB_MCP_TOKEN:-my-secret}"
```

```bash
chmod +x start-bb-browser.sh
./start-bb-browser.sh
```

启动后输出：
```
[2/2] 启动 MCP HTTP Server...
[bb-browser MCP] HTTP server listening on http://0.0.0.0:13337/mcp (token: my-secret)
[bb-browser MCP] Remote OpenClaw mcp.json config:
{
  "mcpServers": {
    "bb-browser": {
      "type": "http",
      "url": "http://<your-local-ip>:13337/mcp",
      "headers": {
        "Authorization": "Bearer my-secret"
      }
    }
  }
}
```

> `Ctrl+C` 停止 MCP Server。Edge 会继续在后台运行（下次启动更快）。

---

### 手动分步启动

如果不用脚本，也可以手动开 **2 个终端**：

**终端 1 — 启动 Edge：**
```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port=19825 \
  --user-data-dir="$HOME/.bb-browser/browser/user-data" \
  --no-first-run --no-default-browser-check about:blank \
  > /dev/null 2>&1 &
```

**终端 2 — 启动 MCP HTTP Server（保持运行）：**
```bash
bb-browser --mcp --http --http-host 0.0.0.0 --http-port 13337 --http-token my-secret
```

> Daemon 不需要手动启动，MCP Server 收到请求时会自动拉起。

---

### 获取本机 IP

```bash
ipconfig getifaddr en0   # Wi-Fi
ipconfig getifaddr en1   # 有线（备用）
```

---

### 配置 OpenClaw

把本机 IP 填入 OpenClaw 的 MCP 配置（`mcp.json` 或 IDE 设置）：

```json
{
  "mcpServers": {
    "bb-browser": {
      "type": "http",
      "url": "http://192.168.1.100:13337/mcp",
      "headers": {
        "Authorization": "Bearer my-secret"
      }
    }
  }
}
```

---

### 验证连接

```bash
# 第一步：初始化，获取 session ID
SESSION=$(curl -si -X POST http://127.0.0.1:13337/mcp \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')

echo "Session: $SESSION"

# 第二步：调用工具（打开 x.com）
curl -s -X POST http://127.0.0.1:13337/mcp \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"https://x.com"}}}'
```

成功响应示例：
```
event: message
data: {"result":{"content":[{"type":"text","text":"..."}]},"jsonrpc":"2.0","id":2}
```

> **注意**：curl 需要带 `Accept: application/json, text/event-stream` 头，否则返回 `Not Acceptable` 错误（这是 MCP StreamableHTTP 协议要求，OpenClaw 会自动处理）。

---

## 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--http` | 无（必须显式指定） | 启用 HTTP 模式 |
| `--http-host` | `0.0.0.0` | 监听地址（`0.0.0.0` 表示所有网卡） |
| `--http-port` | `13337` | 监听端口 |
| `--http-token` | 自动生成 32 字节随机值 | Bearer 认证 token |

> 不带 `--http` 时，仍然使用原有的 stdio 模式（用于 Claude Code / Cursor 本地配置）。

---

## 网络安全

### 防火墙（推荐）

只允许 OpenClaw 服务器 IP 访问：

```bash
# macOS（用 pf 或应用层防火墙）
# Linux
sudo ufw allow from <openclaw-server-ip> to any port 13337
```

### 通过 SSH 隧道（最安全）

不开放端口，改用 SSH 隧道转发：

```bash
# 在 OpenClaw 服务器上执行，将远端 13337 端口转发到本机
ssh -R 13337:127.0.0.1:13337 user@openclaw-server

# OpenClaw mcp.json 配置改为 localhost
{
  "mcpServers": {
    "bb-browser": {
      "type": "http",
      "url": "http://127.0.0.1:13337/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

### 通过 Tailscale（推荐，零配置）

```bash
# 本机和 OpenClaw 服务器都安装 Tailscale
tailscale up

# 获取本机 Tailscale IP
tailscale ip -4   # 例如：100.64.1.10

# OpenClaw mcp.json 配置
{
  "mcpServers": {
    "bb-browser": {
      "type": "http",
      "url": "http://100.64.1.10:13337/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

---

## 持久化运行

### 方式 1：systemd（Linux 本机）

```ini
# /etc/systemd/system/bb-browser-mcp.service
[Unit]
Description=bb-browser MCP HTTP Server
After=network.target

[Service]
Type=simple
User=your-user
ExecStart=/usr/local/bin/bb-browser --mcp --http \
  --http-host 0.0.0.0 \
  --http-port 13337 \
  --http-token my-secret-token
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable bb-browser-mcp
sudo systemctl start bb-browser-mcp
```

### 方式 2：pm2（跨平台）

```bash
pm2 start "bb-browser --mcp --http --http-host 0.0.0.0 --http-token mysecret" \
  --name bb-browser-mcp

pm2 save
pm2 startup   # 设置开机自启
```

### 方式 3：一键启动脚本

```bash
#!/bin/bash
# start-bb-browser.sh

# 1. 启动 Chrome
open -a "Google Chrome" --args --remote-debugging-port=19825

# 等待 Chrome 启动
sleep 2

# 2. 启动 Daemon（后台）
bb-browser daemon &

# 等待 Daemon 连接 Chrome
sleep 3

# 3. 启动 MCP HTTP Server（前台，输出日志）
bb-browser --mcp --http \
  --http-host 0.0.0.0 \
  --http-port 13337 \
  --http-token "${BB_MCP_TOKEN:-$(openssl rand -hex 16)}"
```

```bash
chmod +x start-bb-browser.sh
BB_MCP_TOKEN=my-secret-token ./start-bb-browser.sh
```

---

## 可用的 MCP 工具

OpenClaw 连接后可调用的工具：

| 工具名 | 说明 |
|--------|------|
| `browser_open` | 打开 URL |
| `browser_snapshot` | 获取页面可访问性树 |
| `browser_click` | 点击元素 |
| `browser_fill` | 填充输入框 |
| `browser_type` | 逐字符输入 |
| `browser_press` | 发送按键 |
| `browser_scroll` | 滚动页面 |
| `browser_screenshot` | 截图 |
| `browser_eval` | 执行 JavaScript |
| `browser_get` | 获取元素属性 |
| `browser_tab_list` | 列出标签页 |
| `browser_tab_new` | 新建标签页 |
| `browser_network` | 获取网络请求 |
| `browser_console` | 获取控制台消息 |
| `browser_errors` | 获取 JS 错误 |
| `site_list` | 列出可用 site 适配器 |
| `site_search` | 搜索适配器 |
| `site_info` | 获取适配器详情 |
| `site_run` | 运行 site 适配器 |
| `site_update` | 更新社区适配器库 |
| `browser_close_all` | 关闭本次会话打开的标签页 |

---

## 故障排查

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| `Connection refused` | 本机 MCP Server 未启动 | 检查 `bb-browser --mcp --http` 进程是否在运行 |
| `401 Unauthorized` | token 错误 | 核对 OpenClaw 配置中的 token 是否与启动时一致 |
| `503 Service Unavailable` | Chrome 未连接到 Daemon | 检查 `bb-browser daemon` 和 Chrome 是否运行 |
| `Network timeout` | 防火墙或网络不通 | 检查防火墙规则，或改用 SSH 隧道 / Tailscale |
| 工具调用返回 `Chrome is not connected` | Daemon 没有连上 Chrome | 重启 `bb-browser daemon` |
| 工具调用无响应、OpenClaw 一直挂起 | `McpServer` 单例被多 session 共享，旧版本 bug | 升级到最新版本（已修复：每 session 独立 `McpServer` 实例） |

---

## 相关文件

- [`packages/mcp/src/index.ts`](packages/mcp/src/index.ts) — MCP 服务器实现（本次主要改动）
- [`packages/cli/src/index.ts`](packages/cli/src/index.ts) — CLI 入口（透传参数修复）
- [`packages/daemon/src/index.ts`](packages/daemon/src/index.ts) — Daemon 实现
- [`skills/bb-browser-openclaw/SKILL.md`](skills/bb-browser-openclaw/SKILL.md) — OpenClaw 使用说明
