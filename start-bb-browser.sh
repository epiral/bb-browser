#!/bin/bash

BB_MCP_TOKEN="${BB_MCP_TOKEN:-my-secret}"
BB_MCP_PORT="${BB_MCP_PORT:-13337}"
BB_CHROME_PORT="${BB_CHROME_PORT:-19825}"

# 清理旧进程
pkill -f "bb-browser" 2>/dev/null || true
sleep 2

# 启动浏览器
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

# 启动 MCP HTTP server
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