# bb-browser System Tray Daemon — 详细设计

> **范围**：MVP 1–3，按"五层 UI 分工"组织。
>
> - **MVP 1**：托盘图标 + 弹窗 + 右键菜单 + Toast + 多端口控制 + 自愈
> - **MVP 2**：控制面板（Tauri 窗口）+ TraceStudio 迁移 + 三层数据源 UI
> - **MVP 3**：人类干预录制 + 中文注释导出
>
> 暂不做的特性（团队共享、远程、CI/CD 指标、WSL、Watchdog 进程、4 级沙箱 等）见 [system-tray-future.md](system-tray-future.md)。

---

## 1. 产品定位与设计哲学

### 1.1 产品定位

把 bb-browser daemon 从「CLI 黑盒」演进为 **「Windows 系统级 AI 浏览器代理服务」** — 可见、可控、可自愈。

**MVP 目标用户**：单机单用户的 AI 应用开发者（用 Claude Code / Cursor / Cline 等 MCP 客户端开发 agent）。

### 1.2 托盘设计哲学（核心，所有设计取舍的基准）

**3 秒哲学**：用户按下托盘 → 完成核心操作 ≤ 3 步、≤ 3 秒。任何破坏这条的设计（启动动画、引导步骤、Tab 切换、确认对话框）需要单独论证。

**Tray-centric 而非 Form-centric**：托盘图标是主控制器；弹窗和控制面板都只是它"在需要时召唤出来的临时面板"，而不是把一个大窗口最小化进托盘。

**克制的弹出层 + 高密度信息 + 即时操作**：
- 弹窗宽度 320–420px、高度 ≤ 屏幕 60%
- 视觉轻盈（Desktop Acrylic 半透明）
- 键盘友好（Esc 关闭、Tab 切焦点、所有列表上下选）
- 无确认对话框 — 乐观执行 + Toast 撤销

**参考标杆**（截图建议拉到 Figma 做对照）：

| 类别 | 参考 | 取法 |
|------|------|------|
| 高密度列表 + 默认聚焦搜索 | 1Password / Bitwarden | Body 列表样式 |
| 状态开关 + 节点列表 + 设置入口 | Tailscale / Cloudflare WARP | Header 状态展示、三段式布局 |
| 图标即状态 | Stats / iStat Menus | 托盘图标承载实时状态而不仅是 logo |
| 现代化右键菜单 | ShareX / Snipaste | 分组分隔线、快捷键标注 |
| Fluent Design 原生感 | Windows 11 快速设置 | Acrylic、圆角 8px、控件间距 8/12/16 |

---

## 2. 五层 UI 分工

bb-browser 的全部 UI 分布在 **5 个层级**，每层有严格的职责边界。设计时优先问"这功能应该在哪一层"，再问"怎么做"。

| 层 | 容器 | 用途 | MVP | 内容举例 | 不放什么 |
|:--:|------|------|:---:|---------|---------|
| **1** | 托盘图标 | 状态指示 | 1 | 3 色状态、ToolTip | 任何交互逻辑 |
| **2** | 托盘弹窗 (左键) | **3 秒高频操作** | 1 | 状态摘要、端口/Token、最近命令、打开控制面板 | Trace 录制、完整日志、长列表 |
| **3** | 右键菜单 | **低频运维** | 1 | 重启 daemon、打开日志、设置、退出 | 高频操作、需展示数据的功能 |
| **4** | 控制面板 (Tauri 窗口) | **深度交互** | 2 | Trace 录制、日志查看、完整命令历史 | 一眼可懂的小操作 |
| **5** | Toast 通知 | **异步事件提醒** | 1 | 端口回退、daemon 重启、CDP 断开 | 持续状态（用图标传达） |

**分层决策表**：

| 用户需求 | 应该在哪层？ | 理由 |
|---------|-------------|------|
| "daemon 状态怎么样？" | 层 1 图标 | 瞥一眼即可 |
| "现在用哪个端口？" | 层 2 弹窗 | 信息密度足够，3 秒可见 |
| "复制 Token 给 MCP 客户端配置" | 层 2 弹窗 | 高频且需文字 |
| "刚才 agent 做了什么？" | 层 2 弹窗（最近 3 条） + 层 4 完整列表 | 弹窗给摘要、控制面板给详情 |
| "重启 daemon" | 层 3 右键 + 层 2 弹窗 Footer | 低频但重要 — 两个入口都给 |
| "录制一段 Trace" | 层 4 控制面板 | 操作复杂、超 3 秒 |
| "改端口号" | 层 3 右键 → 设置 | 低频，专用窗口 |
| "端口被占用了" | 层 5 Toast | 异步事件、可点击跳转 |

---

## 3. 托盘图标设计（层 1）

### 3.1 状态机 — 3 色

| 颜色 | 含义 | 触发条件 |
|:---:|------|---------|
| 🟢 绿 | 一切正常 | daemon 运行 + CDP 已连接 |
| 🟡 黄 | 重连中 | CDP 断开 < 30s，正在重试 |
| 🔴 红 | 故障 | daemon 未运行 / CDP 长时间断开 |

**砍掉 5 色方案的理由**：MVP 是单人单机，蓝色"daemon 运行但无 MCP 客户端"对用户毫无意义。

### 3.2 视觉规范

- **尺寸**：16×16 / 20×20 / 24×24 (DPI 自适应)
- **风格**：单色 + 高对比、无渐变、无细节（16px 下会糊）
- **主题**：暗任务栏 / 亮任务栏 **双套图标**，OS 自动选择
- **状态轴**：颜色 + 形状双轴（不仅靠颜色），照顾色弱用户

### 3.3 ToolTip

格式：`bb-browser · {状态文字} · {端口}`
示例：
- `bb-browser · 已连接 · :19826`
- `bb-browser · 重连中 · :19826`
- `bb-browser · 未运行`

---

## 4. 托盘弹窗设计（层 2）— **MVP 1 重头**

### 4.1 触发与关闭

| 动作 | 行为 |
|------|------|
| 单击左键 | 打开弹窗 |
| 中键 | 切换 daemon 启动/停止（核心快捷动作） |
| 双击 | 打开控制面板（MVP 2 后启用） |
| Esc | 关闭 |
| 点击弹窗外部 | 关闭 (light-dismiss) |
| 失焦 | 关闭 |

### 4.2 三段式布局

```
┌─ 托盘弹窗  360 × ~320px  ─────────────────────────┐
│  🟢 bb-browser · 已连接                  ⚙   ✕    │ ← Header (48px)
├───────────────────────────────────────────────────┤
│                                                   │
│  Chrome v130 · 6 tabs · 2h 15m                    │
│                                                   │
│  ────────────────────────────────────────────     │
│                                                   │
│  端口    daemon  19826              [复制]        │
│          CDP     19827              [复制]        │
│                                                   │
│  Token   0d50a5e3…                  [复制]        │
│                                                   │
│  ────────────────────────────────────────────     │
│                                                   │
│  最近命令                                          │
│  · snapshot                              now      │
│  · click ref=3                           2s       │
│  · fill ref=5 "hello"                    5s       │
│  ──                                                │
│  查看全部 12 条 →                                  │
│                                                   │
├───────────────────────────────────────────────────┤
│  [ 打开控制面板 ]              [ 重启 ]  [ 退出 ]  │ ← Footer (44px)
└───────────────────────────────────────────────────┘
```

**为什么是这个布局**：

- **Header 状态色** — 与托盘图标颜色对应，"瞥一眼即懂"
- **第一段 Chrome 信息** — 用户最关心"我连的是哪个浏览器"
- **第二段端口 + Token** — MCP 客户端配置的全部所需，**每一行配[复制]按钮**（一键，零摩擦）
- **第三段最近命令** — 仅 3 条，看完整去控制面板；这是"瞥一眼最近 agent 在干嘛"的入口
- **Footer 主操作**：打开控制面板（核心入口）+ 重启 + 退出

### 4.3 视觉与定位

| 维度 | 规范 |
|------|------|
| 宽度 | 360px |
| 高度 | 320px（内容多时内部滚动，不撑窗口） |
| 圆角 | 外框 8px、按钮/卡片 4px |
| 间距 | 8 / 12 / 16 三档 |
| 背景 | Desktop Acrylic（全应用统一，见 §13） |
| 字号 | 标题 14 / 正文 12 / 提示 11 |
| 位置 | 检测任务栏位置，贴边弹出 + 8–12px 间距 |
| 动画 | 150–200ms easeOutCubic，Y 轴位移 + 透明度过渡 |
| 主题 | 跟随系统暗/亮 |
| 减动画偏好 | 检测 `SPI_GETCLIENTAREAANIMATION` 关闭动画 |

### 4.4 键盘与无障碍

- 默认聚焦"打开控制面板"按钮 — 按回车即触发主路径
- Tab 顺序：复制按钮 → 列表项 → Footer 按钮
- 所有控件 ≥ 32×32px
- 所有控件设 `AutomationProperties.Name`，支持 Narrator
- 列表项支持上下键选择 + Enter 确认（如 Enter 复制 Token）

### 4.5 状态特殊化

| daemon 状态 | 弹窗呈现差异 |
|-----------|------------|
| 🟢 已连接 | 全部信息正常展示（上图） |
| 🟡 重连中 | Header 显示"CDP 重连中 · 第 2 次"+ 进度旋转图标 |
| 🔴 未运行 | 全部信息灰显 + Body 顶部大按钮 `[启动 daemon]` |
| 🔴 端口冲突 | Body 顶部红色横条："19824 被占用 → 已改用 19826 [详情]" |

**绝不出现的内容**：
- "确定要重启吗？" → 直接重启 + Toast"已重启，3 秒前 [撤销]"
- "无法连接 Error 0x80004005" → 翻译为 "无法连接到 Chrome [重试] [查看日志]"
- 任何旋转/弹跳的庆祝动画 — 托盘程序追求冷静专业

---

## 5. 右键菜单设计（层 3）

### 5.1 菜单结构（≤ 2 层）

```
状态: Chrome v130 · 6 tabs · :19826                  (灰显，仅展示)
────
重启 daemon                                Ctrl+R
启动 daemon (未运行时显示)
停止 daemon (运行时显示)
────
打开日志文件夹                             Ctrl+L
故障诊断 → 导出诊断报告                    (M2+)
────
设置 ▸
  开机自启 ☑
  端口配置...
  浏览器路径...
  通知开关 ☑
────
关于 bb-browser
退出                                       Ctrl+Q
```

### 5.2 设计原则

- **不超过 2 层**：所有设置项一目了然
- **快捷键标注**：每个常用项右侧浅灰显示快捷键（参考 PowerToys Run 体例）
- **状态行灰显**：顶部状态行只展示不可点，提供与弹窗一致的状态感
- **动作分组**：用空行/分隔线分四组（状态 / daemon 控制 / 日志诊断 / 设置 / 关于退出）

### 5.3 为什么右键和弹窗有重叠（重启 / 退出）

刻意。Windows 用户有两套肌肉记忆：
- 老用户习惯右键菜单
- 新用户期待左键面板

两边都给入口，是降低学习成本而非冗余。

---

## 6. Toast 通知设计（层 5）

### 6.1 通知场景与文案

| 场景 | 文案 | 操作 |
|------|------|------|
| 端口冲突自动回退 | `daemon 改用端口 19826（19824 被占用）` | `[详情]` |
| daemon 自动重启 | `daemon 已自动重启（第 1 次）` | `[查看日志]` |
| CDP 断开超过 30s | `Chrome 调试连接已断开 30 秒` | `[重连]` `[查看 Chrome]` |
| 反复崩溃停止重启 | `daemon 5 分钟内崩溃 3 次，已暂停自动重启` | `[查看日志]` `[手动启动]` |
| 长操作完成（M2+） | `Trace 导出完成 → ~/Downloads/trace.spec.js` | `[打开]` `[复制路径]` |

### 6.2 通知规范

- **时长**：4 秒自动消失（错误类 8 秒）
- **乐观执行 + 撤销**：所有"破坏性"操作（重启、清日志）走 Toast 撤销范式，不弹确认框
- **不打断**：不抢焦点、不发声（除非用户开了通知声）
- **错误必须说人话 + 给操作**：永远不是"Error 0x80004005"
- **可静音**：右键菜单 → 设置 → 通知开关

---

## 7. 控制面板设计（层 4）— **MVP 2 才上线**

### 7.1 定位与边界

- **独立 Tauri 窗口**（Acrylic 背景，与托盘弹窗设计语言统一）
- 不与托盘弹窗内容重复；专做 **"超 3 秒、需要深度交互"** 的事
- 默认不开机自动弹出；通过托盘左键 Footer / 右键菜单进入

### 7.2 Tab 结构

| Tab | MVP 2 包含 | 后续扩展 |
|------|-----------|---------|
| 📊 Overview | 状态摘要、当前端口/Token、最近 50 条 MCP 命令、CPU/内存简单显示 | — |
| 🎬 Trace | 整体迁移 TraceStudio（见 §11） | MVP 3 加干预录制 UI |
| 📋 Logs | daemon 日志实时滚动 + 级别过滤 + 关键字搜索 | — |

**砍掉的 Tab**：
- Tabs 详细管理 → 用浏览器自己的标签页就行
- Network 详细查看 → 推迟到 future
- 完整配置编辑 GUI → 直接打开 daemon.json 文件就行

### 7.3 与托盘弹窗的内容分工

| 数据 | 托盘弹窗 | 控制面板 |
|------|---------|---------|
| daemon 状态 | ✅ 一行摘要 | ✅ 详细（含 CPU/内存） |
| 端口 + Token | ✅ 主展示，一键复制 | ✅ 含修改入口 |
| 最近 MCP 命令 | ✅ 3 条 | ✅ 50 条 + 过滤 |
| Trace 录制 | ❌ | ✅ 唯一入口 |
| 日志查看 | ❌（仅"打开日志"按钮） | ✅ 实时滚动 + 搜索 |

---

## 8. 多端口控制（MVP 1 P0）

bb-browser 同时管理 **两个端口**（直接对应 #217）：

| 端口 | 默认 | 用途 |
|------|:---:|------|
| **daemon HTTP** | 19824（偶数） | MCP 客户端连接、控制面板访问 |
| **CDP Debug** | 19825（奇数） | daemon 连接 Chrome |

### 8.1 启动探测

```
启动
 ├─ 浏览器发现：HKCU\…\ChromeHTML → Edge / Brave / 360ChromeX 回退
 ├─ 端口探测（两条独立探测链）
 │    daemon: 19824 → 19826 → 19828 → …  (偶数)
 │    CDP:    19825 → 19827 → 19829 → …  (奇数)
 ├─ 持久化 ~/.bb-browser/daemon.json
 │    { "daemonPort": ..., "cdpPort": ..., "token": "...", "schemaVersion": 1 }
 └─ 多渠道可见性广播（§8.2）
```

### 8.2 多端口可见性闭环

端口换了必须**显式告诉用户**，否则等于换了个新黑盒（#217 的真实痛点）：

| 渠道 | 内容 |
|------|------|
| 🔔 Toast 通知 | `daemon 改用端口 19826（19824 被占用）` |
| 🎯 托盘 ToolTip | `bb-browser · 已连接 · :19826` |
| 📋 弹窗 Body | 端口行恒显，一键复制 |
| 🖥 控制面板 Overview | 顶部端口卡片（可点击修改） |
| 💻 CLI | `bb-browser status` 打印两个端口 |
| 📝 stdout 启动横幅 | 启动时打印 |

### 8.3 手动指定

控制面板"端口配置" → 输入数字 → 保存 → 提示"将在重启后生效" → 点击重启。
冲突时拒绝保存并提示具体冲突源（如可能，用 `netstat -ano` 查占用进程）。

---

## 9. 自愈机制（MVP 1）

### 9.1 故障矩阵（精简到 3 类）

| 故障 | 检测 | 自愈 | 通知 |
|------|------|------|------|
| daemon 崩溃 | Tauri 主进程发现子进程退出 / 心跳超时 | 立即重启，5 分钟窗口内最多 3 次 | Toast |
| CDP 断开 | `ws.on('close')` | 固定 5s × 6 次（共 30s） | 图标黄 → 红 + Toast |
| 端口被占 | EADDRINUSE | §8.1 自动回退 | Toast |

**砍掉的**：内存超限自动重启、Cmd 队列堆积警告、recovery.json 持久化（见 future §3.3 / §4.2）

### 9.2 Supervisor（Tauri Rust 主进程）

不引入独立 Watchdog 进程（见 future §3.1 不做的理由）：

```
Tauri 主进程 (Rust)
  ├─ Tray icon / 菜单 / 弹窗 / 控制面板 (webview)
  └─ spawn daemon (Node 子进程)
       ├─ 心跳: 5s 一次 GET /status
       ├─ 失败 / 子进程退出 → 重启
       └─ 5 分钟内 ≥ 3 次失败 → 停止重启 + Toast 通知
```

### 9.3 优雅关闭（3 阶段）

```
1. 停止接收新命令（POST /shutdown → 后续请求 503）
2. 等待 in-flight 命令完成（总超时 30s）
3. 关 WebSocket + process.exit(0)
```

---

## 10. 命令记录三层数据源（数据模型层，MVP 1 标记 / MVP 2 应用）

> **MVP 1 只做数据模型标记**（trace-inject 加 `origin` 字段，~30 行）。
> **MVP 2 在控制面板 Trace tab 应用** 三层过滤 UI。
> **MVP 3 加人类干预分组**（见 §11）。

### 10.1 三层来源澄清

bb-browser 中存在 **三类不同来源** 的"动作记录"，先前版本只分 2 类（把 ② ③ 混在一起）。

| 来源 | 触发者 | 触发路径 | 采集点 | `event.isTrusted` |
|------|--------|---------|--------|:---:|
| **① MCP Commands** | AI Agent | Agent → MCP → daemon HTTP → CDP | daemon HTTP 入口拦截 | — |
| **② Trace: User** | 真人用户 | 鼠标/键盘 → 浏览器 → 原生 DOM 事件 | trace-inject.ts DOM 监听器 | `true` |
| **③ Trace: Agent** | AI Agent | Agent → MCP → CDP `Input.dispatch*` → 合成 DOM 事件 | trace-inject.ts DOM 监听器（被动） | `false` |

### 10.2 关键观察

- ① 和 ②/③ 是两条独立数据管道（① 零开销始终记录；②/③ 需 Start Recording）
- ② 和 ③ 共用同一个 DOM 监听器；浏览器不区分真实和合成事件
- 当前 [trace-inject.ts:129](packages/daemon/src/trace-inject.ts:129)–251 未检查 `event.isTrusted`，所以 ② 和 ③ **完全混淆**
- 副作用：agent 调 `browser_click` 被**双重记录**（① + ③）

### 10.3 MVP 1 修复（Wave 1，~30 行）

trace-inject 每个 `emit()` 增加：

```js
emit({ ..., origin: e.isTrusted ? 'user' : 'agent' });
```

daemon trace event 类型加 `origin?: 'user' | 'agent'`。
**仅数据层标记，UI 应用推到 MVP 2。**

### 10.4 MVP 2 UI 应用（控制面板 Trace tab 内）

```
┌─── Trace Timeline ─────────────────────────────────┐
│  Filter:  [● All]  [○ User]  [○ Agent]  [○ MCP]   │
│                                                    │
│  12:30:05  ①  [MCP]    agent → click ref=3       │
│  12:30:05  ③  [TRACE]  🤖 click button "Submit"  │
│  12:30:12  ②  [TRACE]  👤 fill input "hello"     │
└────────────────────────────────────────────────────┘
```

---

## 11. 人类干预录制 + 中文注释导出（MVP 3）

> 推迟到 MVP 3 的原因：MVP 2 先把 TraceStudio 原样迁移到控制面板，确保现有功能不丢失。干预录制是增强能力，需要分组算法 + 类型识别 + 导出器扩展，整块约 120 行代码 + 测试，单独成阶段更稳。

### 11.1 设计意图

真实自动化场景，**agent + human 协作录制**是常态：
- agent 无法处理登录（密码、2FA、CAPTCHA、SSO） → 人类必须介入
- agent 卡在 cookie 同意 / GDPR 弹窗 → 人类一键关闭
- agent 需要人类先翻到页面深处 → 人类翻页

Start Recording 必须**同时**记录两个角色，导出时给 human 段加醒目中文注释。

### 11.2 数据模型扩展

```ts
type TraceEvent = {
  // ...现有字段...
  origin: 'user' | 'agent';                  // ← MVP 1 已加
  // —— 干预分组（仅 user 事件携带，MVP 3 新增）——
  interventionId?: string;
  interventionType?: 'login' | 'otp' | 'captcha' | 'paging' | 'dismiss-popup' | 'misc';
  interventionLabel?: string;                // 中文标签
};
```

### 11.3 干预段识别

```
新建组: 前一事件为 agent，当前为 user / 距前一 user 事件 > 30s
延续组: 前一事件为 user 且间隔 ≤ 30s
关组:   下一事件切回 agent / 30s 内无新事件
```

### 11.4 类型识别启发式

按优先级匹配，第一个命中即取（`login` + `otp` 可叠加为"人类登录 + 2FA"）：

| 优先级 | 类型 | 触发条件 | 中文标签 |
|:---:|------|---------|---------|
| 1 | `login` | 段内有 fill 到 `input[type=password]` 或字段名含 `password` | **人类登录** |
| 2 | `otp` | 段内 fill 值匹配 `^\d{4,8}$` 或字段名含 `otp\|code\|verify\|2fa\|sms` | **人类输入验证码** |
| 3 | `captcha` | url/selector 命中 `recaptcha\|hcaptcha\|cloudflare-challenge` | **人类完成 CAPTCHA** |
| 4 | `dismiss-popup` | 段 ≤ 2 步且按钮文本匹配 `accept\|agree\|close\|cancel\|ok\|同意\|关闭\|确定` | **人类关闭弹窗** |
| 5 | `paging` | scroll 占段内 > 60% | **人类翻页** |
| 6 | `misc` | 兜底 | **人类干预** |

### 11.5 凭据脱敏（在 trace-inject 端就替换）

| 字段特征 | 替换值 |
|---------|--------|
| `input[type=password]` | `<MASKED_PASSWORD>` |
| name/id 含 `otp\|code\|verify\|2fa\|sms` | `<MASKED_OTP>` |
| 值为 4-8 位纯数字且前序 5s 内有 password 操作 | `<MASKED_OTP>` |
| name/id 含 `creditcard\|cvv\|cvc\|card-number` | `<MASKED_CARD>` |

### 11.6 导出格式（Playwright 示例）

```js
test('GitHub 创建 PR', async ({ page }) => {
  // ⚙️ Agent 动作
  await page.goto('https://github.com');
  await page.click('a[data-test="sign-in"]');

  // ════════════════════════════════════════════════════
  // 👤 人类登录 + 2FA  (8.3s, 5 步)
  //   ⚠️  凭据已脱敏，回放需替换为环境变量
  //   ⚠️  2FA 验证码无法硬编码，需运行时获取
  // ════════════════════════════════════════════════════
  await page.fill('input#login', 'alice');
  await page.fill('input#password', '<MASKED_PASSWORD>');     // → process.env.GH_PASS
  await page.click('button[type="submit"]');
  await page.fill('input#otp', '<MASKED_OTP>');               // → await fetchOTP()
  await page.click('button[type="submit"]');
  // ════════════════════════════════════════════════════

  // ⚙️ Agent 动作
  await page.click('a.new-pr');
});
```

Python / Selenium 走同样格式（`#` 注释 + 同样的分隔条）。

### 11.7 ExportDialog 新增 5 个开关

| 选项 | 默认 | 说明 |
|------|:---:|------|
| Include user events | ☑ | 导出 ② |
| Include agent events | ☑ | 导出 ③ |
| Mark interventions with comments | ☑ | 加分隔条 + 中文标签 |
| Mask credentials | ☑ | 应用 §11.5 脱敏；**关闭需二次确认** |
| Group consecutive same-origin | ☑ | 连续 ≥3 个 agent 操作折叠注释 |

### 11.8 控制面板时间线（人类干预为可折叠卡片）

```
⚙️  agent  click  a "Sign in"
┏━━ 👤 人类登录 + 2FA  (8.3s, 5 步)  ━━━━━━━━ [▼] ┓
┃  fill input#login 'alice'                       ┃
┃  fill input#password ********                   ┃
┃  ...                                            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
⚙️  agent  click  a "New PR"
```

类型标签上色：登录=红 · CAPTCHA=橙 · 翻页=蓝 · misc=灰。默认折叠，hover 展开。

---

## 12. TraceStudio 融合（MVP 2 主线）

### 12.1 现状与目标

| 维度 | TraceStudio SPA | 控制面板 Trace tab |
|------|----|------|
| **定位** | 录制操作 → 导出脚本 | 同上 + 集成到 Dashboard |
| **入口** | `vite dev` 独立页面 | Tauri 控制面板内嵌 |
| **框架** | React + Vite | 同源复用 |

### 12.2 组件融合方式

| 现有组件 | 处理 |
|---------|------|
| `App.jsx` | 重写为 Dashboard 根组件 + 标签页路由 |
| `TraceStudio.jsx` | → `pages/TracePage.jsx` |
| `ConnectionPanel.jsx` | 提升到全局 header |
| `TabPanel.jsx` | 在 Overview / Trace 复用 |
| `TraceControls / TraceTimeline / TraceEventDetail / RealtimeMonitor / ExportDialog` | 保留在 TracePage 内 |
| `useStore.jsx` | 扩展 overview / logs 相关 state |
| `api/daemon.js` | 新增 `getOverview()`, `getLogs()` |

### 12.3 Daemon 端新增 HTTP 端点

```
GET /api/overview        → { uptime, ports, chromeVersion, tabCount, activeMCPClients }
GET /api/commands?limit  → 最近 N 条 MCP 命令
GET /api/logs?level&limit→ 日志查询
```

### 12.4 100% 保留的 TraceStudio 功能

✅ 连接 daemon · 选 tab · Start/Stop 录制 · 实时事件查看 · 事件详情弹窗 · 导出（JS/Playwright/Python）· 选择器模式 · 智能等待开关 · 实时状态监控。**全部不丢**，只是搬位置。

---

## 13. 技术选型

**结论：Tauri v2** 作为桌面壳 + 托盘 + supervisor。

| 组件 | 方案 | 理由 |
|------|------|------|
| 桌面壳 + 托盘 + 弹窗 | **Tauri v2** | 包 ~3MB（Electron ~80MB）；Rust 主进程直接 supervise daemon；原生 Acrylic 支持 |
| 控制面板内容 | React（复用 TraceStudio）→ `vite build` → Tauri 内嵌 | 复用 ~10 个组件 |
| daemon ↔ UI | UI → HTTP REST → daemon | 无需新 IPC |
| 安装器 | Tauri 自带（MSI / NSIS / .deb / .dmg） | 跨平台一站式 |

**统一设计语言：Desktop Acrylic**

托盘弹窗和控制面板**都用 Desktop Acrylic**。不混用 Mica，理由：

| 维度 | 全 Acrylic | Mica + Acrylic 混用 |
|------|:---------:|:------------------:|
| 视觉一致性 | ✅ 全局统一的"半透明毛玻璃"语言 | ❌ 弹窗与主窗口质感不同 |
| 系统兼容 | ✅ Windows 10 1903+ 均支持 | ⚠️ Mica 需 Windows 11 |
| 工具型应用调性 | ✅ Acrylic 更轻盈、临时感强 | Mica 偏"内容型应用"调性 |
| 用户辨识 | ✅ 半透明感成为产品视觉资产 | 多套材质削弱辨识 |

虽然 Microsoft 官方建议 Mica 用于持久窗口、Acrylic 用于瞬态弹层，但 bb-browser 是工具型应用，**统一 Acrylic 优先于遵循官方默认**。

Tauri 设置：
```rust
// 所有窗口（托盘弹窗 + 控制面板）
window.set_effects(WindowEffects {
    effects: vec![Effect::Acrylic],
    state: Some(EffectState::Active),
    ..Default::default()
})?;
```

注意：
- Win10 < 1903 / 系统关闭"透明效果"时，Acrylic 自动降级为纯色背景（无需额外代码）
- 用户开启"减少动画 / 透明" → 降级为不透明背景色，遵循系统偏好

**性能目标**：Tauri 主进程空闲 < 80MB；daemon Node 子进程 < 60MB。超出意味着用户在任务管理器看到会卸载。

---

## 14. 设计执行阶段

### 14.0 Phase 1 启动前已确认的决策

| # | 决策 | 选项 | 后果 |
|:-:|------|------|------|
| 1 | **平台范围** | Windows-only | macOS/Linux 推迟到 M4+；Tauri 跨平台底盘保留但不主动测试 |
| 2 | **仓库结构** | 新增 `packages/tray-app` (Tauri/Rust 包)，spawn 现有 `packages/daemon` 作为 Node 子进程 | 现有 daemon 代码零改动；pnpm workspace 加 Rust 包；CI 增加 Rust toolchain |
| 3 | **CLI 入口去留** | 保留 `bb-browser daemon start` 等 CLI 命令 | 托盘是 superset 而非替代；CI/SSH/headless 场景继续可用；packages/cli 不动 |
| 4 | **设计资源** | 用户先用 AI 生成草图，由实施者做最终调整 | 实施时由实施者基于本文档 §3.2 / §4.3 / §13 的规范，调整 AI 草图为最终 SVG + 适配暗/亮主题 |

剩余可在实施中决定的事项（建议默认值见 §14.1 末尾）。

### MVP 1 — 托盘骨架 + 多端口 + 自愈（3 周）

**目标**：用户卸掉所有快捷方式，仅靠托盘就能完成日常使用。

**产物清单**：

| 类别 | 项 | 验收 |
|------|----|------|
| **托盘图标** | 3 色 + 暗/亮主题双套 + ToolTip | 切系统主题图标自动切换；色弱用户能区分状态 |
| **托盘弹窗** | 三段式 360px + Acrylic + light-dismiss | 按图标到完成"复制 Token"≤ 3 秒；Esc / 外部点击 / 失焦均关闭 |
| **右键菜单** | ≤ 2 层 + 快捷键标注 | 全部菜单项可见、所有快捷键可用 |
| **Toast 通知** | 5 类场景 + 撤销/重试操作 | 错误必须说人话；不打断焦点 |
| **多端口控制** | daemon + CDP 双端口探测/回退 | 占用 19824 模拟测试，自动切到 19826，6 处可见性渠道全部更新 |
| **Tauri Supervisor** | spawn daemon + 心跳 + 限流重启 | kill -9 daemon，3 秒内自动重启；5 分钟 3 次后停止重启 |
| **优雅关闭** | 3 阶段 | 关闭过程中新请求返回 503；in-flight 命令完成或 30s 超时退出 |
| **三层来源 Wave 1** | trace-inject 加 origin 字段 + 扩展脱敏 | 录制 trace 中 user/agent 事件可通过 origin 字段区分；OTP 字段被脱敏 |
| **日志** | 单文件 daemon.log + 10MB 轮转 + 7 天清理 | 右键"打开日志文件夹"能直接进入 |

**MVP 1 不做**：
- 控制面板正式 UI（只占位"即将上线"）
- Trace 任何改动（仅数据层 origin 标记）
- Logs / Overview Tab UI（仅写日志文件，看通过右键菜单打开文件夹）

**验收 KPI**：
- 装机 → 看到托盘绿点 ≤ 30 秒
- 托盘 → 复制 Token ≤ 3 秒
- daemon 崩溃 → 自动恢复 ≤ 10 秒
- 端口冲突 → Toast 通知 + 弹窗显示新端口 ≤ 2 秒

**实施中可决定的事项（建议默认值）**：

| 事项 | 默认值 | 何时可改 |
|------|-------|---------|
| WebView2 依赖 | Tauri 安装器内嵌 bootstrapper（用户离线也能装） | 安装包大小敏感时切换为运行时下载 |
| 端口自动递增上限 | 10 次（19824→19842）；全部失败 → Toast 提示手动指定 | 用户反馈 10 次不够时调高 |
| 中键托盘动作 | 切换 daemon 启停（符合 Tailscale / Stats 肌肉记忆） | 测试发现误触多则改为禁用 |
| packages/web 命运 | MVP 1 期间保持可独立 `vite dev`，用户升级前可继续用 | MVP 2 整合后移除独立运行入口 |
| i18n | 中文 only；文案常量集中 `tray-app/src/i18n/zh.ts`，便于将来抽英文 | M3+ 有海外用户时加 |
| Token 配置兼容 | 旧 `daemon.json` 缺 `schemaVersion` 时按 v1 解释 + 自动补字段 | 字段含义有破坏性变更时强制迁移 |
| 日志位置 | `~/.bb-browser/logs/daemon.log` 单文件，Tauri 主进程日志同文件前缀 `[tray]` | 双方日志量级悬殊时再拆 |
| fix/cdp-v0.8.0 分支 | 先 rebase / merge 到 main 再开 Phase 1 工作 | 该分支已 stale 则在 Phase 1 中重做相关代码 |

---

### MVP 2 — 控制面板 + TraceStudio 迁移（3 周）

**目标**：把现有 TraceStudio 完整搬到控制面板，三个 Tab 全部可用。

**产物清单**：

| 类别 | 项 | 验收 |
|------|----|------|
| **控制面板窗口** | Tauri 独立窗口 + Acrylic 背景 + 标签页路由 | 启动 < 500ms；切 Tab 无卡顿；Acrylic 与托盘弹窗视觉一致 |
| **Overview Tab** | 状态摘要 / 端口 + Token / 最近 50 条 MCP 命令 | 与托盘弹窗内容呼应、不重复 |
| **Trace Tab** | 整体迁移 TraceStudio | 现有 9 项功能 100% 可用（§12.4） |
| **三层来源 UI 应用** | Trace tab 加 Filter 来源切换 | All / User / Agent / MCP 四种筛选 |
| **Logs Tab** | 实时滚动 + 级别过滤 + 关键字搜索 | 1000 条日志加载 < 200ms |
| **Daemon 新端点** | /api/overview / /api/commands / /api/logs | 端点存在 + 返回正确 schema |
| **开机自启** | 注册表 HKCU\…\Run + 设置界面开关 | 重启系统后托盘自动出现 |
| **Tauri 安装器** | MSI 打包 + 卸载干净 | 安装包 < 10MB；卸载残留检查（见 §15.1） |

**MVP 2 不做**：
- 人类干预录制 / 类型识别 / 中文注释（MVP 3）
- ExportDialog 新增开关（MVP 3）
- TraceTimeline 干预折叠卡片（MVP 3）

**验收 KPI**：
- 托盘左键 → 控制面板出现 ≤ 1 秒
- 现有 TraceStudio 用户切到 MVP 2 → 无功能丢失
- daemon 重启后日志连续可见

---

### MVP 3 — 人类干预录制与导出（3 周）

**目标**：登录、2FA 等人类介入步骤在 Trace 中被自动识别、标记、并在导出脚本中加中文注释。

**产物清单**：

| 类别 | 项 | 验收 |
|------|----|------|
| **干预分组算法** | `intervention-grouper.ts`：连续 user 事件分组 | 100 个事件测试覆盖：相邻 user 合并 / agent 切断 / 30s 间隔切断 |
| **类型识别启发式** | `intervention-classifier.ts`：6 类 + 叠加规则 | 测试用例：登录 / 2FA / CAPTCHA / 弹窗 / 翻页 / 兜底 各 ≥ 2 个 |
| **trace 事件类型扩展** | 加 interventionId / Type / Label | 序列化往返不丢字段 |
| **导出器扩展** | JS / Playwright / Python 三套中文注释模板 | 真实 GitHub 登录 trace → 导出脚本人工可读 |
| **ExportDialog 新增** | 5 个开关（§11.7） | 关闭脱敏需弹二次确认 |
| **TraceTimeline 折叠卡片** | 干预段按类型上色 + 默认折叠 | hover 展开 / 点击收起 |
| **文档** | README + trace 指南 | 含登录 + 2FA 示例截图 |

**验收 KPI**：
- 录制一次"打开 GitHub → 人工登录 → agent 发 PR" → 导出脚本能直接读懂哪段是人哪段是 agent
- 凭据脱敏默认开启 + 关闭需二次确认

---

### M4+ — 见 future.md

MVP 1–3 结束时扫一遍 future.md 的"触发实现条件"。

---

## 15. 待补设计（占位，下迭代填充）

### 15.1 卸载流程

目标：托盘菜单"卸载并清理"或安装器 uninstall 在 30s 内完成清理。
清单：HKCU 自启项、`~/.bb-browser/`、防火墙规则、临时 user data dir。
保留：用户导出的 trace 脚本、浏览器书签/cookie。
顺序：通知 MCP 客户端 → 优雅关闭 daemon → 退托盘 → 删文件 → 清注册表。

### 15.2 配置迁移

`~/.bb-browser/` 加 `schemaVersion` 字段；启动时检测旧版本 → 一次性迁移 + 备份原文件到 `backup-YYYYMMDD/`。降级（schema 比当前新）→ 警告但不修改。

### 15.3 首次启动引导（Onboarding）

目标：安装后 30s 内看到"Chrome 已连接"。
步骤：欢迎页 → 浏览器检测（找不到给"下载 Chrome"和"手动指定"两个出口）→ 显示 Token 和"复制 MCP 配置"按钮 → 针对 Claude Code / Cursor / Cline / Continue 各一份配置模板 → 完成页。
兜底：CDP 端口被占、Chrome 已运行但没开 `--remote-debugging-port`、防火墙阻断。

### 15.4 故障诊断报告导出

托盘右键 → 故障诊断 → 自动 zip：daemon.log + daemon.json（脱敏 Token）+ 系统信息 + 最近 Toast 历史 → 保存到 Desktop。
