# 远程主机管理与故障排查

## 启动服务

在远程主机上执行以下命令，启动 Edge 浏览器和 bb-browser MCP HTTP 服务：

```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port="${BB_CHROME_PORT:-19825}" \
  --user-data-dir="$HOME/.bb-browser/browser/user-data" \
  --no-first-run --no-default-browser-check about:blank \
  > /dev/null 2>&1 &
sleep 3
bb-browser --mcp --http \
  --http-host 0.0.0.0 \
  --http-port "${BB_MCP_PORT:-13337}" \
  --http-token "${BB_MCP_TOKEN:-my-secret}"
```

**环境变量说明：**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BB_MCP_TOKEN` | `my-secret` | Bearer token |
| `BB_MCP_PORT` | `13337` | MCP HTTP 监听端口 |
| `BB_CHROME_PORT` | `19825` | Chrome 远程调试端口（CDP） |
| `BB_DAEMON_PORT` | `19824` | bb-browser daemon 内部端口 |

## 验证连接

```bash
python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
  --tool browser_tab_list --args '{}'
```

## 断联修复

```bash
# 端口被占用时，杀掉残留进程后重启 daemon
lsof -ti:"${BB_DAEMON_PORT:-19824}" | xargs kill -9
bb-browser daemon
```

## 故障排查

| 错误 | 原因 | 解决 |
|---|---|---|
| `Chrome is not connected` | daemon 未连 Chrome | `lsof -ti:"${BB_DAEMON_PORT:-19824}" \| xargs kill -9 && bb-browser daemon` |
| `EADDRINUSE 19824` | 端口残留 | `lsof -ti:"${BB_DAEMON_PORT:-19824}" \| xargs kill -9` |
| `Connection refused` | MCP server 未启动 | 在远程主机重新执行启动命令 |
| `401 Unauthorized` | token 错误 | 确认 `BB_MCP_TOKEN` 与服务端一致 |
| `Missing TwitterUserNotSuspended` | Twitter 登录态失效 | 在远程浏览器重新登录 x.com |
| CAPTCHA 触发 | Reddit 账号被标记 | 在远程浏览器手动发一次帖完成验证 |
| 代理干扰 | OpenClaw 服务器有 HTTP 代理 | 脚本已自动绕过，无需手动处理 |
