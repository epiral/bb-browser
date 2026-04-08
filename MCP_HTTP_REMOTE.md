# bb-browser MCP HTTP 远程模式

## 背景

**问题**：OpenClaw 部署在远程服务器，无法访问外网，但本机有 Chrome 浏览器和外网访问权限。

**解决思路**：在本机启动 bb-browser，通过 HTTP 将 MCP 接口暴露给远程 OpenClaw 调用。

**原理**：MCP 支持 `StreamableHTTPServerTransport`，通过 `--http` 启动模式即可让远程客户端通过 HTTP 调用 MCP。

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

仓库根目录已有 [`start-bb-browser.sh`](start-bb-browser.sh)，直接使用：

```bash
chmod +x start-bb-browser.sh
BB_MCP_TOKEN=my-secret ./start-bb-browser.sh
```

脚本内容如下，支持通过环境变量覆盖端口和 token：

```bash
#!/bin/bash

BB_MCP_TOKEN="${BB_MCP_TOKEN:-my-secret}"
BB_MCP_PORT="${BB_MCP_PORT:-13337}"
BB_CHROME_PORT="${BB_CHROME_PORT:-19825}"

# 清理旧进程
pkill -f "bb-browser" 2>/dev/null || true
sleep 2

# 启动浏览器（后台静默）
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port="$BB_CHROME_PORT" \
  --user-data-dir="$HOME/.bb-browser/browser/user-data" \
  --no-first-run --no-default-browser-check \
  about:blank > /dev/null 2>&1 &

sleep 3

# 启动 daemon（自动发现 Chrome）
bb-browser daemon &
DAEMON_PID=$!
sleep 3

# 启动 MCP HTTP Server（后台）
bb-browser --mcp --http \
  --http-host 0.0.0.0 \
  --http-port "$BB_MCP_PORT" \
  --http-token "$BB_MCP_TOKEN" &
MCP_PID=$!

echo "   bb-browser started:"
echo "   Chrome CDP: 127.0.0.1:$BB_CHROME_PORT"
echo "   Daemon PID: $DAEMON_PID"
echo "   MCP HTTP: 0.0.0.0:$BB_MCP_PORT (token: $BB_MCP_TOKEN)"
echo "   MCP PID: $MCP_PID"

# 保持脚本运行，Ctrl+C 时优雅关闭
trap "kill -9 $DAEMON_PID $MCP_PID 2>/dev/null; exit" SIGINT SIGTERM

wait
```

启动后输出：
```
[Daemon] HTTP server listening on http://127.0.0.1:19824
[Daemon] Auth token: d2849755993ad1dbf651ae67044f3680
[Daemon] Connecting to Chrome CDP at 127.0.0.1:19825...
[Daemon] CDP connected, monitoring 1 tab(s)
   bb-browser started:
   Chrome CDP: 127.0.0.1:19825
   Daemon PID: 39508
   MCP HTTP: 0.0.0.0:13337 (token: my-secret)
   MCP PID: 39524
[bb-browser MCP] HTTP server listening on http://0.0.0.0:13337/mcp (token: my-secret)
[bb-browser MCP] Claude Code / Cursor mcp.json config:
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

> `Ctrl+C` 优雅关闭 daemon 和 MCP Server，Edge 会继续在后台运行（下次启动更快）。

---

### 手动分步启动

如果不用脚本，可以手动分步执行：

```bash
# 1. 启动 Edge
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port=19825 \
  --user-data-dir="$HOME/.bb-browser/browser/user-data" \
  --no-first-run --no-default-browser-check about:blank \
  > /dev/null 2>&1 &

# 2. 启动 Daemon
bb-browser daemon &

# 3. 启动 MCP HTTP Server（前台保持运行）
bb-browser --mcp --http --http-host 0.0.0.0 --http-port 13337 --http-token my-secret
```

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

使用仓库根目录的 [`start-bb-browser.sh`](start-bb-browser.sh)：

```bash
chmod +x start-bb-browser.sh
BB_MCP_TOKEN=my-secret-token ./start-bb-browser.sh
```

支持通过环境变量覆盖端口和 token（`BB_MCP_TOKEN`、`BB_MCP_PORT`、`BB_CHROME_PORT`）。

---

## 可用的 MCP 工具

OpenClaw 连接后可调用的工具：

| 工具名 | 说明 |
|--------|------|
| `browser_open` | 打开 URL（自动新建标签页） |
| `browser_snapshot` | 获取页面可访问性树（含 ref 编号） |
| `browser_screenshot` | 截图（返回 PNG） |
| `browser_get` | 获取元素属性或页面 url/title |
| `browser_click` | 点击元素 |
| `browser_hover` | 悬停元素 |
| `browser_fill` | 填充输入框（清空后填入） |
| `browser_type` | 逐字符输入（不清空） |
| `browser_check` | 勾选复选框 |
| `browser_uncheck` | 取消勾选复选框 |
| `browser_select` | 下拉框选择 |
| `browser_press` | 发送按键（支持组合键，如 Control+a） |
| `browser_scroll` | 滚动页面 |
| `browser_eval` | 执行 JavaScript |
| `browser_wait` | 等待指定毫秒 |
| `browser_close` | 关闭当前标签页 |
| `browser_close_all` | 关闭本次会话打开的所有标签页 |
| `browser_back` | 后退 |
| `browser_forward` | 前进 |
| `browser_refresh` | 刷新页面 |
| `browser_tab_list` | 列出所有标签页 |
| `browser_tab_new` | 新建标签页 |
| `browser_tab_select` | 切换标签页 |
| `browser_tab_close` | 关闭指定标签页 |
| `browser_network` | 获取/管理网络请求（支持 since 增量查询） |
| `browser_console` | 获取/清空控制台消息 |
| `browser_errors` | 获取/清空 JS 错误 |
| `browser_trace` | 录制用户操作 |
| `browser_history` | 搜索浏览历史 |
| `browser_dialog` | 处理弹窗（alert/confirm/prompt） |
| `browser_frame` | 切换到 iframe |
| `browser_frame_main` | 切换回主框架 |
| `site_list` | 列出可用 site 适配器 |
| `site_search` | 搜索适配器 |
| `site_info` | 获取适配器详情 |
| `site_recommend` | 基于浏览历史推荐适配器 |
| `site_run` | 运行 site 适配器 |
| `site_update` | 更新社区适配器库 |

---

## 故障排查

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| `Connection refused` | 本机 MCP Server 未启动 | 检查 `bb-browser --mcp --http` 进程是否在运行 |
| `401 Unauthorized` | token 错误 | 核对 OpenClaw 配置中的 token 是否与启动时一致 |
| `503 Service Unavailable` | Chrome 未连接到 Daemon | 检查 `bb-browser daemon` 和 Chrome 是否运行 |
| `Network timeout` | 防火墙或网络不通 | 检查防火墙规则，或改用 SSH 隧道 / Tailscale |
| 工具调用返回 `Chrome is not connected` | Daemon 没有连上 Chrome | 重启 `bb-browser daemon` |

---

## 相关文件

- [`packages/mcp/src/index.ts`](packages/mcp/src/index.ts) — MCP 服务器实现
- [`packages/cli/src/index.ts`](packages/cli/src/index.ts) — CLI 入口
- [`packages/daemon/src/index.ts`](packages/daemon/src/index.ts) — Daemon 实现
- [`skills/bb-browser-openclaw/SKILL.md`](skills/bb-browser-openclaw/SKILL.md) — OpenClaw 使用说明
