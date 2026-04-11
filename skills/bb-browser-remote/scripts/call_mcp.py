#!/usr/bin/env python3
"""
bb-browser 远程 MCP HTTP 调用工具

流程：
  1. POST /mcp  method=initialize  → 拿 Mcp-Session-Id（自动缓存复用）
  2. POST /mcp  method=tools/call  带 Mcp-Session-Id → 拿结果
  Session 缓存在 ~/.bb-browser/mcp-session，自动处理失效与清理。

用法:
  python3 call_mcp.py --init
  python3 call_mcp.py --tool browser_open --args '{"url":"https://x.com"}'
  python3 call_mcp.py --tool site_list
  python3 call_mcp.py --tool site_run --args '{"name":"reddit/hot","args":["rednote"]}'
  python3 call_mcp.py --tool browser_screenshot

环境变量:
  BB_MCP_URL    MCP 端点，默认 http://10.27.6.105:13337/mcp（可在 .env 中配置）
  BB_MCP_TOKEN  Bearer token，默认 my-secret（可在 .env 中配置）
  优先级：命令行参数 > 环境变量 > .env 文件 > 代码默认值
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.request
import urllib.error

# ── 配置 ──────────────────────────────────────────────────────────────────────

# Session 缓存文件：存 {"url": "...", "sid": "..."}
# url 字段用于检测 MCP_URL 变更，变更时自动失效
_SESSION_FILE = pathlib.Path.home() / ".bb-browser" / "mcp-session"

# 自动加载 .env（优先级：环境变量 > .env > 默认值）
_env_file = pathlib.Path(__file__).parent.parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

MCP_URL = os.environ.get("BB_MCP_URL", "http://10.27.6.105:13337/mcp")
MCP_TOKEN = os.environ.get("BB_MCP_TOKEN", "my-secret")

# 绕过本地代理，直连远程主机
_host = MCP_URL.split("//")[-1].split(":")[0].split("/")[0]
os.environ.pop("http_proxy", None)
os.environ.pop("HTTP_PROXY", None)
_no_proxy = os.environ.get("no_proxy", "")
if _host not in _no_proxy:
    os.environ["no_proxy"] = f"{_no_proxy},{_host}".strip(",")
    os.environ["NO_PROXY"] = os.environ["no_proxy"]


# ── HTTP 底层 ─────────────────────────────────────────────────────────────────

def _parse_response(resp) -> tuple[dict, str | None]:
    """从 HTTP 响应解析 JSON 结果（服务端已开启 enableJsonResponse，始终返回 JSON）。"""
    sid = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
    raw = resp.read().decode(errors="replace")
    return (json.loads(raw) if raw.strip() else {}), sid


def _post(payload: dict, session_id: str | None = None) -> tuple[dict, str | None]:
    """发送 JSON-RPC 请求，返回 (result, session_id)。HTTP 错误直接 exit。"""
    data = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        # MCP 规范要求同时声明两种 Accept，服务端据此决定响应格式
        # bb-browser 服务端已开启 enableJsonResponse，实际响应为 application/json
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {MCP_TOKEN}",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id

    req = urllib.request.Request(MCP_URL, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return _parse_response(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"连接失败: {e.reason}", file=sys.stderr)
        print(f"请确认远程主机 {MCP_URL} 可达，且 bb-browser --mcp --http 已启动", file=sys.stderr)
        sys.exit(1)


def _post_with_404(payload: dict, session_id: str) -> tuple[dict | None, bool]:
    """
    发送带 session 的请求，将 404 与其他错误区分返回。
    返回 (result, is_404)：404 时 result=None, is_404=True；其他错误直接 exit。
    """
    data = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",  # MCP 规范要求
        "Authorization": f"Bearer {MCP_TOKEN}",
        "Mcp-Session-Id": session_id,
    }
    req = urllib.request.Request(MCP_URL, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result, _ = _parse_response(resp)
            return result, False
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, True
        body = e.read().decode(errors="replace")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"连接失败: {e.reason}", file=sys.stderr)
        print(f"请确认远程主机 {MCP_URL} 可达，且 bb-browser --mcp --http 已启动", file=sys.stderr)
        sys.exit(1)


# ── MCP 协议 ──────────────────────────────────────────────────────────────────

def initialize() -> str:
    """向服务端发送 initialize 握手，返回 session_id。"""
    _, sid = _post({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "openclaw", "version": "1.0"},
        },
    })
    if not sid:
        print("错误：服务端未返回 Mcp-Session-Id", file=sys.stderr)
        sys.exit(1)
    return sid


# ── Session 缓存 ──────────────────────────────────────────────────────────────

def _load_cached_session() -> str | None:
    """读取缓存的 session ID；URL 不匹配或文件损坏时返回 None。"""
    try:
        data = json.loads(_SESSION_FILE.read_text())
        if data.get("url") == MCP_URL and data.get("sid"):
            return data["sid"]
    except Exception:
        pass
    return None


def _save_session(sid: str) -> None:
    """将 session ID 持久化到缓存文件；写入失败静默忽略。"""
    try:
        _SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SESSION_FILE.write_text(json.dumps({"url": MCP_URL, "sid": sid}))
    except Exception:
        pass


def _clear_session() -> None:
    """删除缓存文件（session 失效时调用）。"""
    try:
        _SESSION_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _get_session() -> str:
    """返回可用 session ID：优先复用缓存，无缓存时重新握手。"""
    sid = _load_cached_session()
    if sid:
        return sid
    sid = initialize()
    _save_session(sid)
    return sid


# ── 公共接口 ──────────────────────────────────────────────────────────────────

def _unwrap(raw: dict) -> object:
    """从 MCP JSON-RPC 响应中提取实际数据。

    MCP 响应结构：{"result": {"content": [{"type": "text", "text": "..."}]}}
    - text 类型：text 字段是 JSON 字符串时二次解析；是纯文本时直接返回。
    - image 类型：返回 {"type":"image","data":"...base64...","mimeType":"image/png"}
    isError=true 时将错误信息打印到 stderr 并 exit。
    """
    try:
        result = raw["result"]
        item = result["content"][0]
    except (KeyError, IndexError):
        return raw  # 结构完全异常，原样返回

    if result.get("isError"):
        print(f"工具执行错误: {item.get('text', item)}", file=sys.stderr)
        sys.exit(1)

    if item.get("type") == "image":
        return item  # {"type":"image","data":"...base64...","mimeType":"image/png"}

    text = item.get("text", "")
    if isinstance(text, str):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text  # 纯文本，直接返回
    return text


def call_tool(name: str, arguments: dict | None = None) -> object:
    """
    调用 MCP 工具，返回工具实际输出数据（已解包 MCP 协议层）。
    自动复用 session，session 失效时重新握手并重试一次。
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments or {},
        },
    }

    sid = _get_session()
    raw, is_404 = _post_with_404(payload, sid)

    if is_404:
        # Session 失效（服务端重启等）→ 重新握手，重试一次
        _clear_session()
        new_sid = initialize()
        _save_session(new_sid)
        raw, _ = _post(payload, session_id=new_sid)

    return _unwrap(raw)


# ── CLI 入口 ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="bb-browser MCP HTTP 客户端")
    parser.add_argument("--init", action="store_true", help="测试连接（发送初始化握手）")
    parser.add_argument("--tool", help="要调用的工具名")
    parser.add_argument("--args", help="工具参数（JSON 字符串）", default="{}")
    parser.add_argument("--url", help="覆盖 MCP URL")
    parser.add_argument("--token", help="覆盖 Bearer token")
    args = parser.parse_args()

    global MCP_URL, MCP_TOKEN
    if args.url:
        MCP_URL = args.url
    if args.token:
        MCP_TOKEN = args.token

    if not MCP_TOKEN:
        print("错误：需要提供 token（--token 参数 或 BB_MCP_TOKEN 环境变量）", file=sys.stderr)
        sys.exit(1)

    if args.init:
        sid = initialize()
        _save_session(sid)
        print(f"✅ 连接成功，session_id: {sid}")
        return

    if args.tool:
        try:
            tool_args = json.loads(args.args)
        except json.JSONDecodeError as e:
            print(f"参数 JSON 解析失败: {e}", file=sys.stderr)
            sys.exit(1)
        data = call_tool(args.tool, tool_args)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return

    parser.print_help()


if __name__ == "__main__":
    main()
