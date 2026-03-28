# Site 系统 — 把任何网站变成命令行 API

## 核心概念

Site 系统通过 adapter（适配器）将网站功能 CLI 化。每个 adapter 是一个 JS 文件，在用户真实浏览器中执行，复用登录态，返回结构化 JSON。

<!-- 证据来源：packages/cli/src/commands/site.ts -->

## 命令速查

```bash
# 列出所有可用 adapter（按平台分组）
bb-browser site list

# 搜索 adapter（模糊匹配名称、描述、域名）
bb-browser site search <query>

# 运行 adapter（简写，推荐）
bb-browser site <name> [args...]

# 运行 adapter（完整写法）
bb-browser site run <name> [args...]

# 更新社区 adapter 库（从 github.com/epiral/bb-sites 拉取）
bb-browser site update

# 查看 adapter 开发指南
bb-browser guide
```

## 参数传递

支持两种格式混合使用：

```bash
# 位置参数（按 adapter 定义的参数顺序）
bb-browser site reddit/thread https://www.reddit.com/r/LocalLLaMA/comments/...

# 命名参数（--flag value 格式）
bb-browser site github/pr-create epiral/bb-sites --title "feat: ..." --head "user:branch"

# 混合使用
bb-browser site twitter/search "AI agent" --count 20
```

<!-- 证据来源：site.ts:290-314 参数解析逻辑 -->

## Adapter 目录与优先级

```
~/.bb-browser/
├── sites/              # 私有 adapter（优先级高，覆盖同名社区 adapter）
│   └── platform/
│       └── command.js
└── bb-sites/           # 社区 adapter（通过 bb-browser site update 拉取）
    └── platform/
        └── command.js
```

私有 adapter 优先于社区同名 adapter。

<!-- 证据来源：site.ts:24-26 目录常量，site.ts:148-157 getAllSites() 合并逻辑 -->

## 自动 Tab 管理

运行 adapter 时，系统自动处理 tab：

1. 如果指定了 `--tab <tabId>`，直接使用该 tab
2. 否则，根据 adapter 的 `domain` 字段查找已打开的匹配 tab
3. 如果没有匹配的 tab，自动打开新 tab 并等待 3 秒加载

域名匹配规则：精确匹配或子域名匹配（如 `x.com` 匹配 `api.x.com`）。

<!-- 证据来源：site.ts:162-169 matchTabOrigin()，site.ts:342-368 tab 查找逻辑 -->

## 错误处理与登录提示

adapter 返回 `{error: "...", hint: "..."}` 时，系统自动检测登录相关错误（匹配 `401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth`），并提示用户先在浏览器中登录。

```bash
# 错误示例
[error] site twitter/search: HTTP 401
  Hint: Please log in to https://twitter.com in your browser first, then retry.
```

<!-- 证据来源：site.ts:406-427 错误处理逻辑 -->

## 36 平台完整列表

<!-- 证据来源：README.md "36 platforms, 103 commands"，具体 adapter 数量以 bb-browser site list 实际输出为准 -->

### 搜索引擎

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Google | `site google/search "query"` | 搜索 |
| Baidu | `site baidu/search "query"` | 百度搜索 |
| Bing | `site bing/search "query"` | 必应搜索 |
| DuckDuckGo | `site duckduckgo/search "query"` | DuckDuckGo 搜索 |
| Sogou WeChat | `site sogou/wechat "query"` | 搜狗微信文章搜索 |

### 社交媒体

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Twitter/X | `site twitter/search "query"` | 搜索推文 |
| Twitter/X | `site twitter/user <handle>` | 用户信息 |
| Reddit | `site reddit/thread <url>` | 帖子详情 |
| Reddit | `site reddit/search "query"` | 搜索 |
| Weibo | `site weibo/search "query"` | 微博搜索 |
| Weibo | `site weibo/hot` | 微博热搜 |
| Xiaohongshu | `site xiaohongshu/search "query"` | 小红书搜索 |
| Jike | `site jike/feed` | 即刻动态 |
| LinkedIn | `site linkedin/search "query"` | 搜索 |
| LinkedIn | `site linkedin/profile <url>` | 个人资料 |
| Hupu | `site hupu/hot` | 虎扑热帖 |

### 新闻资讯

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| BBC | `site bbc/headlines` | BBC 头条 |
| Reuters | `site reuters/search "query"` | 路透社搜索 |
| 36kr | `site 36kr/newsflash` | 36氪快讯 |
| Toutiao | `site toutiao/hot` | 今日头条热榜 |
| Eastmoney | `site eastmoney/news "query"` | 东方财富新闻 |

### 技术开发

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| GitHub | `site github/repo <owner/repo>` | 仓库信息 |
| GitHub | `site github/issues <owner/repo>` | Issue 列表 |
| GitHub | `site github/pr-create <repo> --title "..."` | 创建 PR |
| StackOverflow | `site stackoverflow/search "query"` | 搜索 |
| HackerNews | `site hackernews/top` | 热门帖子 |
| CSDN | `site csdn/search "query"` | CSDN 搜索 |
| cnblogs | `site cnblogs/search "query"` | 博客园搜索 |
| V2EX | `site v2ex/hot` | V2EX 热帖 |
| Dev.to | `site devto/search "query"` | Dev.to 搜索 |
| npm | `site npm/package <name>` | npm 包信息 |
| PyPI | `site pypi/package <name>` | PyPI 包信息 |
| arXiv | `site arxiv/search "query"` | 论文搜索 |

### 视频平台

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| YouTube | `site youtube/search "query"` | 搜索视频 |
| YouTube | `site youtube/transcript <video_id>` | 获取字幕 |
| Bilibili | `site bilibili/search "query"` | B站搜索 |
| Bilibili | `site bilibili/popular` | B站热门 |

### 影音娱乐

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Douban | `site douban/movie <name>` | 豆瓣电影 |
| Douban | `site douban/top250` | 豆瓣 Top250 |
| IMDb | `site imdb/search "query"` | IMDb 搜索 |
| Genius | `site genius/search "query"` | 歌词搜索 |
| Qidian | `site qidian/search "query"` | 起点小说搜索 |

### 财经股票

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Eastmoney | `site eastmoney/stock "茅台"` | 股票查询 |
| Yahoo Finance | `site yahoo-finance/stock <ticker>` | 股票行情 |

### 求职招聘

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| BOSS Zhipin | `site boss/search "query"` | BOSS 直聘搜索 |
| BOSS Zhipin | `site boss/detail <url>` | 职位详情 |

### 知识百科

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Wikipedia | `site wikipedia/search "query"` | 维基百科搜索 |
| Wikipedia | `site wikipedia/summary "topic"` | 摘要 |
| Zhihu | `site zhihu/hot` | 知乎热榜 |
| Zhihu | `site zhihu/question <id>` | 问题详情 |
| Open Library | `site openlibrary/search "query"` | 图书搜索 |

### 消费购物

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| SMZDM | `site smzdm/search "query"` | 什么值得买搜索 |

### 实用工具

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Youdao | `site youdao/translate "text"` | 有道翻译 |
| GSMArena | `site gsmarena/search "phone"` | 手机参数 |
| Product Hunt | `site producthunt/trending` | 热门产品 |
| Ctrip | `site ctrip/search "destination"` | 携程搜索 |

## 常用场景示例

### 信息检索

```bash
# 搜索技术话题
bb-browser site twitter/search "Claude Code"
bb-browser site reddit/search "local LLM"
bb-browser site hackernews/top

# 查看热榜
bb-browser site zhihu/hot
bb-browser site weibo/hot
bb-browser site v2ex/hot

# 查询股票
bb-browser site eastmoney/stock "茅台"
```

### 开发辅助

```bash
# GitHub 操作
bb-browser site github/repo anthropics/claude-code
bb-browser site github/issues owner/repo

# 查包信息
bb-browser site npm/package bb-browser
bb-browser site pypi/package requests

# 搜索技术问题
bb-browser site stackoverflow/search "async await error handling"
```

### 内容获取

```bash
# 获取 YouTube 字幕
bb-browser site youtube/transcript dQw4w9WgXcQ

# 获取 Reddit 帖子完整内容
bb-browser site reddit/thread https://www.reddit.com/r/LocalLLaMA/comments/...

# 论文搜索
bb-browser site arxiv/search "transformer attention mechanism"
```

## 与 --json 配合

所有 site 命令都支持 `--json` 输出结构化数据：

```bash
bb-browser site zhihu/hot --json
bb-browser site twitter/search "AI" --json
```

## 更多信息

- 创建自定义 adapter：参见 [adapter-development.md](adapter-development.md)
- 社区 adapter 仓库：https://github.com/epiral/bb-sites
