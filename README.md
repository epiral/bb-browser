<div align="center">

# bb-browser

### BadBoy Browser

**Your browser is the API. No keys. No bots. No scrapers.**

[![npm](https://img.shields.io/npm/v/bb-browser?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/bb-browser)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · [中文](README.zh-CN.md)

</div>

---

You're already logged into Twitter, Reddit, YouTube, Zhihu, Bilibili, LinkedIn, GitHub — bb-browser lets AI agents **use that directly**.

```bash
bb-browser site twitter/search "AI agent"       # search tweets
bb-browser site zhihu/hot                        # trending on Zhihu
bb-browser site arxiv/search "transformer"       # search papers
bb-browser site eastmoney/stock "茅台"            # real-time stock quote
bb-browser site boss/search "AI engineer"        # search jobs
bb-browser site wikipedia/summary "Python"       # Wikipedia summary
bb-browser site youtube/transcript VIDEO_ID      # full transcript
bb-browser site stackoverflow/search "async"     # search SO questions
```

**103 commands across 36 platforms.** All using your real browser's login state. [Full list →](https://github.com/epiral/bb-sites)

## The idea

The internet was built for browsers. AI agents have been trying to access it through APIs — but 99% of websites don't offer one.

bb-browser flips this: **instead of forcing websites to provide machine interfaces, let machines use the human interface directly.** The adapter runs `eval` inside your browser tab, calls `fetch()` with your cookies, or invokes the page's own webpack modules. The website thinks it's you. Because it **is** you.

| | Playwright / Selenium | Scraping libs | bb-browser |
|---|---|---|---|
| Browser | Headless, isolated | No browser | Your real Chrome |
| Login state | None, must re-login | Cookie extraction | Already there |
| Anti-bot | Detected easily | Cat-and-mouse | Invisible — it IS the user |
| Complex auth | Can't replicate | Reverse engineer | Page handles it itself |

## Quick Start

### Install

```bash
npm install -g bb-browser
```

### Use

```bash
bb-browser site update        # pull community adapters
bb-browser site recommend     # see which adapters match your browsing habits
bb-browser site zhihu/hot     # go
```

### OpenClaw (no extension needed)

If you use [OpenClaw](https://openclaw.ai), bb-browser runs directly through OpenClaw's built-in browser — no Chrome extension or daemon required:

```bash
bb-browser site reddit/hot --openclaw
bb-browser site xueqiu/hot-stock 5 --openclaw --jq '.items[] | {name, changePercent}'
```

Skill on ClawHub: [bb-browser-openclaw](https://clawhub.ai/yan5xu/bb-browser)

### MCP (Claude Code / Cursor)

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

## 36 platforms, 103 commands

Community-driven via [bb-sites](https://github.com/epiral/bb-sites). One JS file per command.

| Category | Platforms | Commands |
|----------|-----------|----------|
| **Search** | Google, Baidu, Bing, DuckDuckGo, Sogou WeChat | search |
| **Social** | Twitter/X, Reddit, Weibo, Xiaohongshu, Jike, LinkedIn, Hupu | search, feed, thread, user, notifications, hot |
| **News** | BBC, Reuters, 36kr, Toutiao, Eastmoney | headlines, search, newsflash, hot |
| **Dev** | GitHub, StackOverflow, HackerNews, CSDN, cnblogs, V2EX, Dev.to, npm, PyPI, arXiv | search, issues, repo, top, thread, package |
| **Video** | YouTube, Bilibili | search, video, transcript, popular, comments, feed |
| **Entertainment** | Douban, IMDb, Genius, Qidian | movie, search, top250 |
| **Finance** | Xueqiu, Eastmoney, Yahoo Finance | stock, hot stocks, feed, watchlist, search |
| **Jobs** | BOSS Zhipin, LinkedIn | search, detail, profile |
| **Knowledge** | Wikipedia, Zhihu, Open Library | search, summary, hot, question |
| **Shopping** | SMZDM | search deals |
| **Tools** | Youdao, GSMArena, Product Hunt, Ctrip | translate, phone specs, trending products |

## 10 minutes to add any website

```bash
bb-browser guide    # full tutorial
```

Tell your AI agent: *"turn XX website into a CLI"*. It reads the guide, reverse-engineers the API with `network --with-body`, writes the adapter, tests it, and submits a PR. All autonomously.

Three tiers of adapter complexity:

| Tier | Auth method | Example | Time |
|------|-------------|---------|------|
| **1** | Cookie (fetch directly) | Reddit, GitHub, V2EX | ~1 min |
| **2** | Bearer + CSRF token | Twitter, Zhihu | ~3 min |
| **3** | Webpack injection / Pinia store | Twitter search, Xiaohongshu | ~10 min |

We tested this: **20 AI agents ran in parallel, each independently reverse-engineered a website and produced a working adapter.** The marginal cost of adding a new website to the agent-accessible internet is approaching zero.

## What this means for AI agents

Without bb-browser, an AI agent's world is: **files + terminal + a few APIs with keys.**

With bb-browser: **files + terminal + the entire internet.**

An agent can now, in under a minute:

```bash
# Cross-platform research on any topic
bb-browser site arxiv/search "retrieval augmented generation"
bb-browser site twitter/search "RAG"
bb-browser site github search rag-framework
bb-browser site stackoverflow/search "RAG implementation"
bb-browser site zhihu/search "RAG"
bb-browser site 36kr/newsflash
```

Six platforms, six dimensions, structured JSON. Faster and broader than any human researcher.

## Also a full browser automation tool

```bash
bb-browser open https://example.com
bb-browser snapshot -i                # accessibility tree
bb-browser click @3                   # click element
bb-browser fill @5 "hello"            # fill input
bb-browser eval "document.title"      # run JS
bb-browser fetch URL --json           # authenticated fetch
bb-browser network requests --with-body --json  # capture traffic
bb-browser screenshot                 # take screenshot
```

All commands support `--json` output, `--jq <expr>` for inline filtering, and `--tab <id>` for concurrent multi-tab operations.

```bash
bb-browser site xueqiu/hot-stock 5 --jq '.items[] | {name, changePercent}'
# {"name":"云天化","changePercent":"2.08%"}
# {"name":"东芯股份","changePercent":"-7.60%"}

bb-browser site info xueqiu/stock   # view adapter args, example, domain
```

## Daemon configuration

The daemon binds to `127.0.0.1:19824` by default. You can customize the host with `--host`:

```bash
bb-browser daemon --host 127.0.0.1    # IPv4 only (fix macOS IPv6 issues)
bb-browser daemon --host 0.0.0.0      # listen on all interfaces (for Tailscale / ZeroTier remote access)
```

## Cross-machine CDP (WSL2 ↔ Windows host)

Some sites refuse to load in a fresh chromium (anti-bot, UA-based redirect loops) or require an existing logged-in session that lives in a different browser on a different machine. You can point `bb-browser` at any reachable Chrome by combining `--cdp-host` / `--cdp-port` with `BB_BROWSER_HOME` for daemon isolation.

### Example: drive Windows-host Chrome from WSL2

**On Windows.** Launch Chrome with remote debugging:

```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Chrome 111+ silently ignores `--remote-debugging-address=0.0.0.0` and force-binds CDP to `127.0.0.1`. Forward to a LAN-reachable port via portproxy (PowerShell as Administrator):

```powershell
netsh interface portproxy add v4tov4 `
  listenaddress=0.0.0.0 listenport=9223 `
  connectaddress=127.0.0.1 connectport=9222

New-NetFirewallRule -DisplayName "WSL CDP 9223" `
  -Direction Inbound -LocalPort 9223 -Protocol TCP `
  -Action Allow -RemoteAddress 172.16.0.0/12
```

> ⚠️ Anyone reachable on the listen address can drive your Chrome. Restrict `-RemoteAddress` to the WSL2 subnet (or your VPN).

**In WSL2.** Run a second daemon on a different HTTP port, isolated by `BB_BROWSER_HOME` so it doesn't collide with any local daemon:

```bash
WIN_HOST=$(ip route show default | awk '{print $3}')
export BB_BROWSER_HOME=~/.bb-browser-windows
bb-browser daemon --port 19834 --cdp-host "$WIN_HOST" --cdp-port 9223
```

From any other shell, point `BB_BROWSER_HOME` to choose which Chrome you talk to:

```bash
# default daemon → local chromium
bb-browser tab list

# Windows-host Chrome
BB_BROWSER_HOME=~/.bb-browser-windows bb-browser tab list
```

The two daemons can run side-by-side. WSL2's host IP can change across restarts; re-detect with `ip route show default` and re-launch the second daemon.

## Architecture

```
AI Agent (Claude Code, Codex, Cursor, etc.)
       │ CLI or MCP (stdio)
       ▼
bb-browser CLI ──HTTP──▶ Daemon ──CDP WebSocket──▶ Your Real Browser
                           │
                    ┌──────┴──────┐
                    │ Per-tab     │
                    │ event cache │
                    │ (network,   │
                    │  console,   │
                    │  errors)    │
                    └─────────────┘
```

## License

[MIT](LICENSE)
