#!/usr/bin/env python3
"""
bb-browser daemon 客户端

直接调用 daemon REST API：
  POST /command  → 所有浏览器操作（open/snapshot/click/eval/...）
  POST /site     → site adapter（run/list/info/recommend/update/search）
  GET  /status   → daemon 健康检查

用法:
  python3 call_daemon.py --action open --args '{"url":"https://x.com"}'
  python3 call_daemon.py --action snapshot --args '{"interactive":true}'
  python3 call_daemon.py --action eval --args '{"script":"document.title"}'
  python3 call_daemon.py --site run --args '{"name":"zhihu/hot"}'
  python3 call_daemon.py --site list
  python3 call_daemon.py --site info --args '{"name":"twitter/search"}'
  python3 call_daemon.py --site run --args '{"name":"twitter/search","args":["Claude Code"]}'
  python3 call_daemon.py --status

环境变量（优先级：命令行 > 环境变量 > .env 文件 > 默认值）:
  BB_DAEMON_URL    daemon 地址，默认 http://10.27.6.105:19824
  BB_DAEMON_TOKEN  Bearer token，默认 my-secret

注意：exec timeout 建议 ≥ 60 秒，截图/发帖等操作建议 120 秒。
"""

import argparse
import json
import os
import pathlib
import sys
import uuid
import urllib.request
import urllib.error

# ── 配置 ──────────────────────────────────────────────────────────────────────

# 自动加载 .env（优先级：环境变量 > .env > 默认值）
_env_file = pathlib.Path(__file__).parent.parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

DAEMON_URL = os.environ.get("BB_DAEMON_URL", "http://10.27.6.105:19824")
DAEMON_TOKEN = os.environ.get("BB_DAEMON_TOKEN", "my-secret")


def _apply_proxy_bypass() -> None:
    """绕过代理，直连 daemon 主机。在 DAEMON_URL 最终确定后调用。"""
    _host = DAEMON_URL.split("//")[-1].split(":")[0].split("/")[0]
    os.environ.pop("http_proxy", None)
    os.environ.pop("HTTP_PROXY", None)
    _no_proxy = os.environ.get("no_proxy", "")
    if _host not in _no_proxy:
        os.environ["no_proxy"] = f"{_no_proxy},{_host}".strip(",")
        os.environ["NO_PROXY"] = os.environ["no_proxy"]


# ── HTTP 底层 ─────────────────────────────────────────────────────────────────

def _post(endpoint: str, body: dict, timeout: int = 60) -> dict:
    """发送 POST 请求，返回解析后的 JSON。失败直接 exit。"""
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{DAEMON_URL}{endpoint}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DAEMON_TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode(errors="replace"))
    except urllib.error.HTTPError as e:
        body_str = e.read().decode(errors="replace")
        print(f"HTTP {e.code}: {body_str}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"连接失败: {e.reason}", file=sys.stderr)
        print(
            f"请确认远程主机 {DAEMON_URL} 可达，且 bb-browser daemon 已启动",
            file=sys.stderr,
        )
        sys.exit(1)


def _get(endpoint: str, timeout: int = 10) -> dict:
    """发送 GET 请求，返回解析后的 JSON。"""
    req = urllib.request.Request(
        f"{DAEMON_URL}{endpoint}",
        headers={"Authorization": f"Bearer {DAEMON_TOKEN}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode(errors="replace"))
    except urllib.error.HTTPError as e:
        body_str = e.read().decode(errors="replace")
        print(f"HTTP {e.code}: {body_str}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"连接失败: {e.reason}", file=sys.stderr)
        sys.exit(1)


# ── 公共接口 ──────────────────────────────────────────────────────────────────

def browser_command(action: str, args: dict | None = None, timeout: int = 60) -> dict:
    """
    调用浏览器命令（POST /command）。
    返回完整 daemon 响应：{"success": true/false, "data": {...}, ...}
    """
    payload = {"id": str(uuid.uuid4()), "action": action, **(args or {})}
    result = _post("/command", payload, timeout=timeout)
    if not result.get("success"):
        err = result.get("error", "Unknown error")
        hint = result.get("hint", "")
        print(f"命令失败: {err}", file=sys.stderr)
        if hint:
            print(f"提示: {hint}", file=sys.stderr)
        sys.exit(1)
    return result


def site_command(command: str, args: dict | None = None, timeout: int = 60) -> dict:
    """
    调用 site adapter（POST /site）。
    command: list | run | info | recommend | update | search
    返回完整响应：{"success": true/false, "data": {...}}
    """
    payload = {"command": command, **(args or {})}
    result = _post("/site", payload, timeout=timeout)
    if not result.get("success"):
        err = result.get("error", "Unknown error")
        hint = result.get("hint", "")
        print(f"site 命令失败: {err}", file=sys.stderr)
        if hint:
            print(f"提示: {hint}", file=sys.stderr)
        sys.exit(1)
    return result


def daemon_status(timeout: int = 10) -> dict:
    """获取 daemon 状态（GET /status）。"""
    return _get("/status", timeout=timeout)


# ── CLI 入口 ──────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="bb-browser daemon 客户端",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s --action open --args '{"url":"https://x.com"}'
  %(prog)s --action snapshot --args '{"interactive":true}'
  %(prog)s --action eval --args '{"script":"document.title"}'
  %(prog)s --action click --args '{"ref":"e3","tabId":"c416"}'
  %(prog)s --site run --args '{"name":"zhihu/hot"}'
  %(prog)s --site run --args '{"name":"twitter/search","args":["Claude"]}'
  %(prog)s --site list
  %(prog)s --site info --args '{"name":"twitter/search"}'
  %(prog)s --status
""",
    )
    parser.add_argument("--action", help="浏览器命令 action（open/snapshot/click/fill/eval/...）")
    parser.add_argument("--site", help="site adapter 子命令（run/list/info/recommend/update/search）")
    parser.add_argument("--args", default="{}", help="JSON 参数字符串（默认 {}）")
    parser.add_argument("--timeout", type=int, default=60, help="请求超时秒数（默认 60）")
    parser.add_argument("--status", action="store_true", help="查看 daemon 状态")
    parser.add_argument("--url", help="覆盖 daemon URL（优先于环境变量）")
    parser.add_argument("--token", help="覆盖 Bearer token（优先于环境变量）")
    opts = parser.parse_args()

    global DAEMON_URL, DAEMON_TOKEN
    if opts.url:
        DAEMON_URL = opts.url
    if opts.token:
        DAEMON_TOKEN = opts.token
    # 在 URL 最终确定后再设置代理绕过（命令行 --url 优先于 .env）
    _apply_proxy_bypass()

    try:
        params = json.loads(opts.args)
    except json.JSONDecodeError as e:
        print(f"参数 JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(1)

    if opts.status:
        result = daemon_status(timeout=opts.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if opts.action:
        result = browser_command(opts.action, params, timeout=opts.timeout)
        # 对于 screenshot 特殊处理：直接输出 image 结构让调用方处理 base64
        data = result.get("data", {})
        if opts.action == "screenshot" and isinstance(data, dict) and "dataUrl" in data:
            data_url = data["dataUrl"]
            b64 = data_url.replace("data:image/png;base64,", "") if isinstance(data_url, str) else ""
            print(json.dumps({"type": "image", "data": b64, "mimeType": "image/png"}, ensure_ascii=False))
        else:
            print(json.dumps(data if data is not None else result, ensure_ascii=False, indent=2))
        return

    if opts.site:
        result = site_command(opts.site, params, timeout=opts.timeout)
        data = result.get("data")
        print(json.dumps(data if data is not None else result, ensure_ascii=False, indent=2))
        return

    parser.print_help()


if __name__ == "__main__":
    main()
