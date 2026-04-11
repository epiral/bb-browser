---
name: bb-browser-remote
description: 浏览器自动化与多平台内容操作工具。复用用户本机浏览器的真实登录态，无需额外认证。两类核心能力：① Site 系统——36 个平台（Twitter/X、Reddit、小红书、微博、Pinterest、YouTube、B站、知乎、GitHub、Google 等）一键调用，支持发帖、搜索、热榜、评论等操作；② 通用浏览器控制——打开任意页面、截图、点击、填表、执行 JS、抓取带登录态内容。只要涉及浏览器操作、平台数据抓取、社交媒体发帖/搜索，优先使用此 skill。
allowed-tools: Bash
---

# bb-browser-remote

通过 MCP HTTP 协议调用用户本机运行的 bb-browser，实现所有浏览器自动化与多平台操作。

## 核心价值

**优先用这个 skill，当任务涉及：**
- **平台数据抓取** — Twitter 热帖、知乎热榜、Reddit 讨论、B站视频、GitHub 仓库信息等
- **社交媒体操作** — 发帖、搜索、评论（需提前在浏览器登录对应平台）
- **登录后页面** — 需要账号登录才能访问的内部系统、个人数据、付费内容
- **页面自动化** — 表单填写、按钮点击、数据提取、批量操作
- **截图/可视化** — 网页截图、页面状态记录

**不需要用这个 skill，当：**
- 任务只需普通 HTTP 请求（无需登录态）→ 直接用 `curl` 或 `fetch`
- 数据来自公开 API → 直接调 API

---

## 环境配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `BB_MCP_TOKEN` | `my-secret` | Bearer token，不设则用默认值 |
| `BB_MCP_URL` | `http://10.27.6.105:13337/mcp` | MCP 端点，可替换主机/端口 |

脚本路径：`~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py`

> 所有硬编码默认值（token、主机、端口）均可通过环境变量覆盖，无需修改脚本。

---

## 标准调用方式

所有操作统一用 Python 脚本调用，**exec timeout 必须设 120 秒，复杂操作设 180 秒**：

```bash
python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
  --tool <工具名> --args '<JSON参数>'
```

如需覆盖 token 或地址，用环境变量前缀：
```bash
BB_MCP_TOKEN=other-token BB_MCP_URL=http://1.2.3.4:13337/mcp \
  python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
  --tool <工具名> --args '<JSON参数>'
```

多个参数的 JSON 示例（避免 shell 引号问题，推荐用 Python heredoc）：

```bash
python3 - <<'EOF'
import subprocess, json, os
args = json.dumps({"name": "twitter/post", "args": ["推文内容"]})
result = subprocess.run(
    ["python3", os.path.expanduser("~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py"),
     "--tool", "site_run", "--args", args],
    capture_output=True, text=True
)
print(result.stdout)
EOF
```

---

## 浏览器基础工具速查

> 完整参数说明见 [references/api.md](references/api.md)

### 导航
| 工具名 | 用途 |
|---|---|
| `browser_open` | 打开 URL（无 tab 时新建标签页） |
| `browser_back` | 浏览器后退 |
| `browser_forward` | 浏览器前进 |
| `browser_refresh` | 刷新当前页面 |
| `browser_close` | 关闭当前标签页 |

### 观察
| 工具名 | 用途 |
|---|---|
| `browser_snapshot` | 获取页面可访问性树（返回 ref 编号） |
| `browser_screenshot` | 截图当前页面 |
| `browser_get` | 获取元素文本/属性或页面级值（url/title/text） |

### 交互
| 工具名 | 用途 |
|---|---|
| `browser_click` | 点击元素 |
| `browser_hover` | 悬停元素 |
| `browser_fill` | 清空并填充输入框 |
| `browser_type` | 逐字符输入（不清空已有内容） |
| `browser_check` / `browser_uncheck` | 勾选/取消复选框 |
| `browser_select` | 下拉框选值 |
| `browser_press` | 发送按键（支持组合键如 `Control+a`） |
| `browser_scroll` | 滚动页面 |
| `browser_eval` | 执行 JavaScript |

### 系统
| 工具名 | 用途 |
|---|---|
| `browser_wait` | 等待指定毫秒数 |
| `browser_dialog` | 预设对话框响应（alert/confirm/prompt） |
| `browser_frame` | 切换到 iframe |
| `browser_frame_main` | 切回主 frame |

### 标签页
| 工具名 | 用途 |
|---|---|
| `browser_tab_list` | 列出所有标签页 |
| `browser_tab_new` | 新建标签页 |
| `browser_tab_select` | 切换到指定标签页 |
| `browser_tab_close` | 关闭指定标签页 |
| `browser_close_all` | 关闭本次会话打开的所有标签页 |

### 网络/观测
| 工具名 | 用途 |
|---|---|
| `browser_network` | 查看/管理网络请求，支持增量查询（`since`） |
| `browser_console` | 获取或清除控制台消息 |
| `browser_errors` | 获取或清除 JS 错误 |
| `browser_trace` | 录制用户操作 |
| `browser_history` | 搜索浏览历史或列出常访问域名 |

---

## Site 适配器（平台命令系统）

```bash
# 列出所有支持的平台和命令
--tool site_list --args '{}'

# 搜索适配器
--tool site_search --args '{"query":"twitter"}'

# 查看适配器详情（含参数说明和示例）
--tool site_info --args '{"name":"twitter/search"}'

# 基于浏览历史推荐适配器
--tool site_recommend --args '{}'

# 运行平台命令
--tool site_run --args '{"name":"平台/命令","args":["参数1","参数2"]}'
```

常用平台速查（Twitter、Reddit、小红书、微博、B站等）：参见 [references/platforms.md](references/platforms.md)

---

## 多步骤操作标准流程

```bash
# 1. 打开页面
--tool browser_open --args '{"url":"https://example.com/login"}'

# 2. 获取可交互元素（返回 ref 编号，如 e1/e2/e3）
--tool browser_snapshot --args '{"interactive":true}'

# 3. 填写输入框（参数名是 text，不是 value）
--tool browser_fill --args '{"ref":"e2","text":"myusername"}'

# 4. 点击按钮
--tool browser_click --args '{"ref":"e1"}'

# 5. 等待页面加载（参数名是 ms，不是 time）
--tool browser_wait --args '{"ms":2000}'

# 6. 页面变化后必须重新 snapshot（旧 ref 失效）
--tool browser_snapshot --args '{"interactive":true}'
```

---

## 注意事项

- **exec timeout 必须 ≥ 120 秒**，MCP 两步握手 + 解析耗时较长
- **复杂操作（发帖/截图）建议 180 秒**
- 远程浏览器的登录态存储在 `$HOME/.bb-browser/browser/user-data`，勿删除
- 代理绕过已内置在脚本中，无需额外配置
- **参数名速查**：`browser_fill` 用 `text`、`browser_scroll` 用 `pixels`、`browser_wait` 用 `ms`、`browser_eval` 用 `script`
- **页面变化后必须重新 snapshot**，旧 ref 失效
- **遇到弹窗**：在触发前调用 `browser_dialog {"dialogResponse":"accept"}` 预设响应
- **遇到 iframe**：用 `browser_frame {"selector":"..."}` 切换，操作完用 `browser_frame_main` 切回

---

## 常见任务示例

> 以下示例均使用完整调用命令，可直接在 bash 中执行。

### 1. 抓取平台热榜（Site 系统，一步完成）

```bash
# 知乎热榜
python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
  --tool site_run --args '{"name":"zhihu/hot"}'

# Reddit 指定 subreddit 热帖
python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
  --tool site_run --args '{"name":"reddit/hot","args":["LocalLLaMA"]}'

# Twitter 搜索
python3 ~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py \
  --tool site_run --args '{"name":"twitter/search","args":["Claude Code"]}'
```

### 2. 网页表单填写（多步骤浏览器操作）

```bash
SCRIPT=~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py

# 1. 打开页面
python3 $SCRIPT --tool browser_open --args '{"url":"https://example.com/login"}'

# 2. 获取可交互元素（ref 编号）
python3 $SCRIPT --tool browser_snapshot --args '{"interactive":true}'

# 3. 填写表单（参数名是 text，不是 value）
python3 $SCRIPT --tool browser_fill --args '{"ref":"e2","text":"myusername"}'
python3 $SCRIPT --tool browser_fill --args '{"ref":"e3","text":"mypassword"}'

# 4. 点击提交
python3 $SCRIPT --tool browser_click --args '{"ref":"e1"}'

# 5. 等待跳转
python3 $SCRIPT --tool browser_wait --args '{"ms":2000}'

# 6. 页面变化后重新 snapshot（旧 ref 已失效）
python3 $SCRIPT --tool browser_snapshot --args '{"interactive":true}'

# 7. 完成后关闭本次会话打开的 tab
python3 $SCRIPT --tool browser_close_all --args '{}'
```

### 3. 截图并保存 base64

```python
import subprocess, json, base64, os

result = subprocess.run(
    ["python3", os.path.expanduser("~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py"),
     "--tool", "browser_screenshot", "--args", "{}"],
    capture_output=True, text=True
)
data = json.loads(result.stdout)
# data = {"type": "image", "data": "<base64>", "mimeType": "image/png"}
with open("screenshot.png", "wb") as f:
    f.write(base64.b64decode(data["data"]))
print("截图已保存到 screenshot.png")
```

### 4. 用 eval 提取页面正文

```bash
SCRIPT=~/.openclaw/skills/bb-browser-remote/scripts/call_mcp.py

python3 $SCRIPT --tool browser_open --args '{"url":"https://example.com/article"}'
python3 $SCRIPT --tool browser_eval \
  --args '{"script":"document.querySelector(\"article\").innerText"}'
python3 $SCRIPT --tool browser_close_all --args '{}'
```

---

## 深入文档

| 文档 | 说明 |
|---|---|
| [references/api.md](references/api.md) | 完整参数表、HTTP 原始协议、`since` 增量查询、故障排查 |
| [references/platforms.md](references/platforms.md) | 各平台操作速查：Twitter、Reddit、小红书、微博、B站、知乎等 12 个平台完整示例 |
| [references/remote-ops.md](references/remote-ops.md) | 远程主机管理：启动命令、断联修复、故障排查 |
| [references/ndjson-store.md](references/ndjson-store.md) | 增量 NDJSON 存储工具：去重写入任意 JSON 数据到本地文件 |
