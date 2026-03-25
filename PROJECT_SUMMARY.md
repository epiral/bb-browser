# bb-browser 项目分析总结

## 项目概览

**项目名称**：bb-browser (BadBoy Browser)  
**版本**：0.10.1  
**核心价值**：Your browser is the API. 让 AI 代理直接使用你真实浏览器的登录状态访问互联网，无需 API keys、bots 或 scrapers。

## 核心架构

```
CLI (packages/cli) ──HTTP──▶ Daemon (packages/daemon) ──SSE──▶ Chrome Extension (packages/extension)
                                                                      │
                                                                      ▼ chrome.debugger (CDP)
                                                                 User's Real Browser
```

- **共享协议**：`packages/shared/src/protocol.ts`
- **MCP 支持**：`packages/mcp/` (Claude Code / Cursor 集成)
- **构建工具**：Turbo + tsup + vite

## 仓库结构

```
bb-browser/
├── packages/
│   ├── cli/          # CLI 入口（bb-browser 命令）
│   ├── daemon/       # HTTP 守护进程（路由命令）
│   ├── extension/    # Chrome Extension（CDP 连接真实浏览器）
│   ├── mcp/          # MCP Server（用于 Claude Code / Cursor）
│   └── shared/       # 共享类型与协议定义
├── skills/
│   ├── bb-browser/   # bb-browser 主 Skill
│   └── bb-browser-openclaw/  # OpenClaw 集成 Skill
├── .github/          # GitHub Actions 工作流
├── AGENTS.md         # Agent 开发指南与约定
├── README.md         # 英文文档
└── README.zh-CN.md   # 中文文档
```

## 核心功能

### 1. Site 系统 - 36 个平台，103 个命令

社区驱动的 adapter 系统（[bb-sites](https://github.com/epiral/bb-sites)），一个 JS 文件对应一个命令。

**覆盖分类**：
- 搜索：Google, Baidu, Bing, DuckDuckGo, 搜狗微信
- 社交：Twitter/X, Reddit, 微博, 小红书, 即刻, LinkedIn, 虎扑
- 新闻：BBC, Reuters, 36kr, 头条, 东方财富
- 开发：GitHub, StackOverflow, HackerNews, CSDN, 博客园, V2EX, Dev.to, npm, PyPI, arXiv
- 视频：YouTube, Bilibili
- 娱乐：豆瓣, IMDb, Genius, 起点
- 财经：雪球, 东方财富, Yahoo Finance
- 招聘：BOSS直聘, LinkedIn
- 知识：Wikipedia, 知乎, Open Library
- 购物：什么值得买
- 工具：有道翻译, GSMArena, Product Hunt, 携程

### 2. 完整的浏览器自动化

```bash
bb-browser open https://example.com
bb-browser snapshot -i                # 获取可交互元素（@ref）
bb-browser click @3                   # 点击元素
bb-browser fill @5 "hello"            # 填写输入
bb-browser eval "document.title"      # 执行 JS
bb-browser fetch URL --json           # 带登录态的 fetch
bb-browser network requests --with-body  # 捕获网络请求
bb-browser screenshot                  # 截图
```

### 3. MCP 集成

与 Claude Code / Cursor 等 AI 工具无缝集成：
```json
{
  "mcpServers": {
    "bb-browser": {
      "command": "npx",
      "args": ["-y", "bb-browser", "--mcp"]
    }
  }
}
```

### 4. OpenClaw 原生支持

无需 Chrome Extension，直接通过 OpenClaw 内置浏览器运行：
```bash
bb-browser site reddit/hot --openclaw
```

## 技术栈

| 层级 | 技术选型 |
|------|----------|
| 语言 | TypeScript |
| 包管理 | pnpm (workspaces) |
| 构建 | Turbo, tsup, vite |
| 协议 | HTTP + SSE |
| 浏览器 | chrome.debugger (CDP) |
| MCP | @modelcontextprotocol/sdk |
| 发布 | Release Please |

## 开发约定（来自 AGENTS.md）

### 添加新命令的 5 个位置

1. `packages/shared/src/protocol.ts` - ActionType + Request + ResponseData
2. `extension/manifest.json` - 权限（如需新 API）
3. `packages/extension/src/background/command-handler.ts` - 处理器实现
4. `packages/cli/src/commands/<name>.ts` - CLI 命令（遵循 `trace.ts` 模式）
5. `packages/cli/src/index.ts` - 导入、帮助文本、flag 解析、case 路由

### 代码规范

- 提交信息：`<type>(<scope>): <summary>`（英文）
- 类型：`fix` / `feat` / `refactor` / `chore` / `docs`
- 用户可见字符串：中文
- 代码/注释：英文
- 构建：根目录执行 `pnpm build`

### UX 文案规范（Agent & Human）

- `site list` 描述格式：`{动作} ({English keywords}: {core return fields})`
- JSON 字段命名：完整英文单词（`changePercent` 而非 `chgPct`）
- 错误结构必须包含三个字段：`error`（技术原因）、`hint`（人类可读解释）、`action`（可执行修复命令）

## 与其他方案对比

| | Playwright / Selenium | Scraping libs | bb-browser |
|---|---|---|---|
| 浏览器 | Headless, 隔离 | 无浏览器 | 你的真实 Chrome |
| 登录状态 | 无，需重新登录 | Cookie 提取 | 已存在 |
| 反机器人 | 易被检测 | 猫鼠游戏 | 不可见 — 它就是用户 |

## 关键文件速查

| 文件 | 用途 |
|------|------|
| `AGENTS.md` | Agent 开发指南 + 代码约定 |
| `packages/shared/src/protocol.ts` | 协议定义（ActionType, Request, Response） |
| `packages/cli/src/index.ts` | CLI 入口与命令路由 |
| `packages/extension/src/background/command-handler.ts` | Extension 命令处理器 |
| `skills/bb-browser/SKILL.md` | bb-browser Skill 完整文档 |

---

_生成时间：2026-03-25_
