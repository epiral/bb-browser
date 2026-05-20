# CLAUDE.md

## Trace Export — 已完成改进（2026-05-18）

以下原 roadmap 项已全部实现，记录于此供历史回溯。当前如需新增改进，请在文末"后续待改进项"追加。

### ✅ P1: 导航事件录制

- `trace-inject.ts` 监听 `popstate` 和 `hashchange`，捕获 SPA 内导航
- `cdp-connection.ts` 在 `Page.frameNavigated`（仅主框架）时发出 `navigation` trace 事件
- `tab-state.ts` 的 `addTraceNavigation` 按 URL 去重，避免 CDP redirect 链产生重复
- 导出脚本中渲染为 `page.goto(url)`；与 `activeTab.url` 相同的首条 navigation 会被跳过避免双重 goto

### ✅ P1: 选择器可移植性

ExportDialog 提供三个模式：
- **Auto**：`ref` → `cssSelector` → `xpath`（保留 bb-browser ref 优先级）
- **CSS**：`cssSelector` → `xpath`，便于在标准 Playwright/Selenium 环境运行
- **XPath**：仅用 `xpath`，跨 DOM 变化更稳定

JS/Playwright 在 XPath 模式下使用 `xpath=...` 前缀；Python 切换到 `By.XPATH`。

### ✅ P2: 步骤间等待机制

ExportDialog 新增"智能等待"开关（默认开启）：
- JS / Playwright：在 click/fill/select/check 前插入 `page.waitForSelector(sel)` 或 `locator(sel).waitFor()`
- Python：插入 `wait.until(EC.presence_of_element_located((by, sel)))`

### ✅ P2: 字符串转义

`esc()` 替换为 `q(str)` → 返回 `JSON.stringify(str)`，自动处理换行、制表符、Unicode、引号、反斜杠。生成的字符串字面量从单引号迁移到双引号。

### ✅ P3: Ring Buffer 上限

`TRACE_CAPACITY` 通过 `BB_TRACE_CAPACITY` 环境变量配置（默认 1000，最小 100）。缓冲首次写满时打印一次性 warning 到 daemon stderr：
```
[bb-browser] trace buffer full for tab <shortId> (cap=1000); oldest events will be discarded. Set BB_TRACE_CAPACITY to raise the limit.
```

---

## 后续待改进项

（暂无。在此追加新的 roadmap 条目。）
