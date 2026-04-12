#!/bin/bash

BB_DAEMON_TOKEN="${BB_DAEMON_TOKEN:-my-secret}"
BB_DAEMON_PORT="${BB_DAEMON_PORT:-19824}"
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

# 启动 daemon（自动发现 Chrome，对外监听供 skill 直连）
bb-browser daemon \
  --host 0.0.0.0 \
  --port "$BB_DAEMON_PORT" \
  --token "$BB_DAEMON_TOKEN" \
  --cdp-port "$BB_CHROME_PORT" &
DAEMON_PID=$!

echo "   bb-browser started:"
echo "   Chrome CDP:  127.0.0.1:$BB_CHROME_PORT"
echo "   Daemon HTTP: 0.0.0.0:$BB_DAEMON_PORT (token: $BB_DAEMON_TOKEN)"
echo "   Daemon PID:  $DAEMON_PID"
echo ""
echo "   skill .env:"
echo "     BB_DAEMON_URL=http://<your-ip>:$BB_DAEMON_PORT"
echo "     BB_DAEMON_TOKEN=$BB_DAEMON_TOKEN"

# 保持脚本运行，Ctrl+C 时优雅关闭
trap "kill -9 $DAEMON_PID 2>/dev/null; exit" SIGINT SIGTERM

wait
