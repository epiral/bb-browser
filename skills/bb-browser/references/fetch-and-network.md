# Fetch 与 Network 高级功能

## fetch 命令 — 带登录态的 curl

本质：在浏览器上下文中执行 `fetch()`，自动携带 Cookie 和登录态。

<!-- 证据来源：packages/cli/src/commands/fetch.ts 注释 "curl，但带浏览器登录态" -->

### 基本用法

```bash
# GET 请求（绝对路径）
bb-browser fetch https://www.reddit.com/api/me.json

# GET 请求（相对路径，使用当前 tab 的 origin）
bb-browser fetch /api/me.json

# POST 请求
bb-browser fetch https://api.example.com/data --method POST --body '{"key":"value"}'

# 自定义请求头
bb-browser fetch https://api.example.com/data --headers '{"Authorization":"Bearer token"}'

# 保存到文件
bb-browser fetch https://api.example.com/data --output response.json

# JSON 格式输出
bb-browser fetch https://www.reddit.com/api/me.json --json
```

### 完整选项

| 选项 | 说明 |
|------|------|
| `--method <GET\|POST\|...>` | HTTP 方法，默认 GET |
| `--body <json>` | 请求体（仅 POST/PUT 等） |
| `--headers <json>` | 自定义请求头（必须是合法 JSON） |
| `--output <file>` | 保存响应到文件 |
| `--json` | JSON 格式输出 |
| `--tab <tabId>` | 指定操作的 tab（全局选项，非 fetch 专属） |

<!-- 证据来源：fetch.ts:18-25 FetchOptions 接口，--tab 由 index.ts:215-218 全局解析 -->

### 自动域名路由机制

fetch 命令会自动处理 tab 匹配：

1. **相对路径**（如 `/api/me.json`）：使用当前活动 tab 的 origin
2. **绝对路径**（如 `https://www.reddit.com/...`）：
   - 先查找已打开的匹配域名 tab
   - 没有则自动打开新 tab 并等待 3 秒
   - 在匹配的 tab 上下文中执行 fetch

<!-- 证据来源：fetch.ts:42-62 ensureTabForOrigin()，fetch.ts:123-139 路由逻辑 -->

### 响应处理

- JSON 响应自动解析为对象
- 非 JSON 响应返回文本
- `--output` 时自动格式化写入文件

<!-- 证据来源：fetch.ts:84-106 buildFetchScript() 中的 content-type 判断 -->

### 典型场景

```bash
# 检查登录状态
bb-browser fetch https://www.reddit.com/api/me.json

# 调用内部 API
bb-browser fetch https://internal.company.com/api/dashboard --json

# 提交表单数据
bb-browser fetch https://api.example.com/submit \
  --method POST \
  --body '{"name":"test","value":123}' \
  --headers '{"Content-Type":"application/json"}'

# 下载数据到文件
bb-browser fetch https://api.example.com/export.csv --output data.csv
```

---

## network 命令 — 网络监控与拦截

<!-- 证据来源：packages/cli/src/commands/network.ts -->

### 子命令一览

```bash
# 查看网络请求
bb-browser network requests [filter] [--with-body] [--json]

# 拦截请求（阻止）
bb-browser network route <url> --abort

# 拦截请求（mock 响应）
bb-browser network route <url> --body '{"mock":"data"}'

# 移除指定拦截规则
bb-browser network unroute <url>

# 移除所有拦截规则
bb-browser network unroute

# 清空请求记录
bb-browser network clear
```

### network requests 详解

```bash
# 查看所有请求
bb-browser network requests

# 按关键词过滤（匹配 URL）
bb-browser network requests "api"

# 包含完整请求/响应体
bb-browser network requests --with-body

# 组合使用
bb-browser network requests "api" --with-body --json
```

输出格式：
```
GET https://api.example.com/data
  类型: fetch, 状态: 200 OK
  请求头: 5, 响应头: 8        # --with-body 时显示
  请求体: {"query":"test"}    # --with-body 时显示
  响应体: {"result":[...]}    # --with-body 时显示
```

<!-- 证据来源：network.ts:46-77 requests 输出逻辑 -->

### network route 详解

拦截匹配 URL 的请求：

```bash
# 阻止广告/追踪请求
bb-browser network route "*analytics*" --abort

# Mock API 响应（用于测试）
bb-browser network route "*/api/user" --body '{"name":"test","role":"admin"}'

# 添加多条规则
bb-browser network route "*tracker*" --abort
bb-browser network route "*/api/config" --body '{"feature_flag":true}'
```

<!-- 证据来源：network.ts:79-92 route 输出逻辑 -->

### network unroute

```bash
# 移除指定规则
bb-browser network unroute "*analytics*"

# 移除所有规则
bb-browser network unroute
```

<!-- 证据来源：network.ts:94-101 unroute 输出逻辑 -->

### network clear

```bash
# 清空请求记录（重新开始监控）
bb-browser network clear
```

<!-- 证据来源：network.ts:103-106 clear 输出逻辑 -->

### API 逆向工程工作流

这是 fetch + network 最强大的组合用法，用于发现网站内部 API：

```bash
# 1. 清空旧记录
bb-browser network clear

# 2. 刷新页面触发请求
bb-browser refresh

# 3. 查看 API 请求（过滤 + 完整体）
bb-browser network requests "api" --with-body --json

# 4. 找到目标 API 后，用 fetch 测试
bb-browser fetch /api/discovered-endpoint --json

# 5. 确认可行后，编写 site adapter
# 参见 adapter-development.md
```

### 全局 --tab 选项

所有 network 子命令都支持 `--tab <tabId>`，指定监控哪个 tab 的网络活动：

```bash
bb-browser network requests --tab 123
bb-browser network route "*api*" --abort --tab 456
bb-browser network clear --tab 123
```
