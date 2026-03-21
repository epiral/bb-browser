# Adapter 开发指南

## 开发流程概览

1. 用 `network` 命令逆向 API
2. 用 `eval` 测试 fetch 是否可行
3. 编写 adapter JS 文件
4. 保存到 `~/.bb-browser/sites/` 测试
5. 提交 PR 到社区仓库

<!-- 证据来源：packages/cli/src/index.ts:601-658 guide 命令输出 -->

## Step 1：逆向 API

```bash
# 清空旧记录
bb-browser network clear --tab <tabId>

# 刷新页面触发请求
bb-browser refresh --tab <tabId>

# 查看 API 请求（filter 是位置参数，不是 --filter）
bb-browser network requests "api" --with-body --json --tab <tabId>
```

重点关注：
- 请求 URL 和参数格式
- 认证方式（Cookie / Bearer token / CSRF token）
- 响应数据结构

## Step 2：测试 fetch

```bash
# 直接在浏览器中测试 fetch（Tier 1 验证）
bb-browser eval "fetch('/api/endpoint',{credentials:'include'}).then(r=>r.json())" --tab <tabId>
```

根据结果判断复杂度：
- **能直接拿到数据** → Tier 1（Cookie 认证，如 Reddit/GitHub/V2EX）
- **需要额外请求头** → Tier 2（如 Twitter：Bearer + CSRF token）
- **需要请求签名或注入** → Tier 3（如小红书：Pinia store / Webpack 模块）

## Step 3：编写 Adapter

### 元数据格式（`/* @meta */` 块）

<!-- 证据来源：site.ts:56-118 parseSiteMeta() -->

```javascript
/* @meta
{
  "name": "platform/command",
  "description": "功能描述",
  "domain": "www.example.com",
  "args": {
    "query": {"required": true, "description": "搜索关键词"},
    "count": {"required": false, "description": "返回数量"}
  },
  "capabilities": ["search"],
  "readOnly": true,
  "example": "bb-browser site platform/command value"
}
*/
async function(args) {
  // adapter 实现
}
```

### 元数据字段说明

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 是 | 唯一标识，格式 `platform/command` |
| `description` | 是 | 功能描述 |
| `domain` | 是 | 目标网站域名（用于自动 tab 匹配） |
| `args` | 是 | 参数定义，每个参数含 `required` 和 `description` |
| `capabilities` | 否 | 能力标签数组 |
| `readOnly` | 否 | 是否只读操作 |
| `example` | 否 | 使用示例 |

### 旧格式兼容

也支持 `// @tag value` 注释格式（向后兼容）：

```javascript
// @name platform/command
// @description 功能描述
// @domain www.example.com
// @args query,filter
// @example bb-browser site platform/command value
```

<!-- 证据来源：site.ts:100-117 旧格式解析 -->

## 三层复杂度示例

### Tier 1：Cookie 认证（~1 分钟）

直接 fetch，`credentials: 'include'` 自动带 Cookie。

```javascript
/* @meta
{
  "name": "reddit/search",
  "description": "Search Reddit posts",
  "domain": "www.reddit.com",
  "args": {"query": {"required": true, "description": "Search query"}},
  "readOnly": true,
  "example": "bb-browser site reddit/search 'local LLM'"
}
*/
async function(args) {
  if (!args.query) return {error: 'Missing argument: query'};
  const resp = await fetch(
    '/search.json?q=' + encodeURIComponent(args.query) + '&limit=10',
    {credentials: 'include'}
  );
  if (!resp.ok) return {error: 'HTTP ' + resp.status, hint: 'Not logged in?'};
  const data = await resp.json();
  return data.data.children.map(c => ({
    title: c.data.title,
    url: 'https://www.reddit.com' + c.data.permalink,
    score: c.data.score,
    subreddit: c.data.subreddit
  }));
}
```

### Tier 2：Bearer + CSRF token（~3 分钟）

需要从页面提取 token 构造请求头。

```javascript
/* @meta
{
  "name": "twitter/search",
  "description": "Search tweets",
  "domain": "twitter.com",
  "args": {"query": {"required": true, "description": "Search query"}},
  "readOnly": true
}
*/
async function(args) {
  // 从 cookie 提取 CSRF token
  const csrf = document.cookie.match(/ct0=([^;]+)/)?.[1];
  if (!csrf) return {error: 'CSRF token not found', hint: 'Not logged in?'};

  // 构造带认证的请求
  const resp = await fetch('/i/api/2/search/adaptive.json?q=' + encodeURIComponent(args.query), {
    credentials: 'include',
    headers: {
      'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs...',
      'x-csrf-token': csrf
    }
  });
  if (!resp.ok) return {error: 'HTTP ' + resp.status};
  return await resp.json();
}
```

### Tier 3：Webpack 注入 / Pinia store（~10 分钟）

需要访问页面内部状态或调用内部模块。

```javascript
/* @meta
{
  "name": "xiaohongshu/search",
  "description": "Search Xiaohongshu notes",
  "domain": "www.xiaohongshu.com",
  "args": {"query": {"required": true, "description": "Search query"}},
  "readOnly": true
}
*/
async function(args) {
  // 通过 Webpack 注入获取内部模块
  // 或通过 __vue_app__ 访问 Pinia store
  // 具体实现取决于目标网站的前端架构
  // ...
}
```

## Step 4：测试

```bash
# 保存到私有目录
# 文件路径：~/.bb-browser/sites/platform/command.js

# 测试运行
bb-browser site platform/command "test query" --json

# 验证输出格式
bb-browser site platform/command "test query"
```

## Step 5：贡献社区

```bash
# 方式 A：使用 gh CLI
git clone https://github.com/epiral/bb-sites && cd bb-sites
git checkout -b feat-platform
# 添加 adapter 文件
git push -u origin feat-platform
gh pr create --repo epiral/bb-sites

# 方式 B：使用 bb-browser 自身
bb-browser site github/fork epiral/bb-sites
git clone https://github.com/YOUR_USER/bb-sites && cd bb-sites
git checkout -b feat-platform
# 添加 adapter 文件
git push -u origin feat-platform
bb-browser site github/pr-create epiral/bb-sites --title "feat(platform): add adapters" --head "YOUR_USER:feat-platform"
```

## 错误处理规范

adapter 返回错误时，使用统一格式：

```javascript
// 参数缺失
return {error: 'Missing argument: query'};

// HTTP 错误 + 登录提示
return {error: 'HTTP 401', hint: 'Not logged in?'};

// 自定义错误
return {error: 'Rate limited', hint: 'Try again in 60 seconds'};
```

系统会自动检测 401/403/unauthorized/login 等关键词，生成登录提示。

<!-- 证据来源：site.ts:406-427 错误检测逻辑 -->

## 报告 Adapter Bug

```bash
# 通过 gh CLI
gh issue create --repo epiral/bb-sites --title "[adapter-name] 描述"

# 通过 bb-browser
bb-browser site github/issue-create epiral/bb-sites --title "[adapter-name] 描述"
```
