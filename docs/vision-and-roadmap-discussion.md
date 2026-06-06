# bb-browser / bb-tray 方向讨论记录

> 这是一份**脑暴/方向讨论的留存**，不是已定方案。目的是不让讨论丢失，以后可随时从"未决岔路口"接着展开。
> 起始日期：2026-06-01

---

## 0. 一句话主张

> **bb-browser 正在从"一个 agent 能驱动的浏览器"，进化成"夹在所有 agent 和 web 之间的数据与能力中枢（data & capability plane）"。**

中枢上只活着四类东西：

| 层 | 用户原话 | 当前已有地基 |
|---|---|---|
| **能力层**（怎么拿数据） | ①浏览器即 API ②脚本固化 | site adapters、trace 导出、`browser_network` 抓 API |
| **数据层**（拿到了什么） | ⑤数据本地统一、反孤岛 | command-history（雏形）、trace ring buffer |
| **接入层**（谁能用） | ④本地 + 异地 agent 共用 | 0.0.0.0 bind、WSL host 改写、全局 MCP |
| **操作台**（编排这一切） | ③图形界面创造/存储/调用/更新 | Tauri 控制面板、TraceStudio、Overview/Logs |

### 飞轮（核心洞察）

```
agent 浏览(④)  →  抓到底层 API(①)  →  固化成命名能力(②)
     ↑                                          ↓
结果不回 agent，沉淀到本地(⑤)  ←  在操作台里管理/版本化(③)
     ↓
下一个 agent 不用重新浏览，直接调 API + 读缓存数据
```

越多 agent 用，能力和数据越厚，重复浏览越少 → **单个本地节点产生网络效应**。这是区别于"又一个 MCP 浏览器工具"的护城河。

---

## 1. bb-sites 与"①浏览器即 API"的关系（已澄清）

**结论：bb-sites 正是 ①② 已经落地的部分，但停在"晋升 MCP 工具"的前一层。**

### bb-sites 现状

- `~/.bb-browser/bb-sites/`（社区）+ `~/.bb-browser/sites/`（私有，优先级更高）
- 36 平台 / 103 命令，每个一个 JS 文件，带 `/* @meta */`（name / description / domain / args / capabilities / readOnly）
- 复用真实浏览器登录态，返回结构化 JSON
- 开发流程本身就是"浏览器即 API"：`network` 逆向 → `eval` 验证 → 写 adapter
- 证据：`packages/cli/src/commands/site.ts`、`skills/bb-browser/references/{site-system,adapter-development}.md`

### 距离"晋升 MCP 工具"的三个差距

1. **103 个命令在 MCP 侧塌缩成 1 个泛型工具** `site_run(name, args, namedArgs)`（`packages/mcp/src/index.ts:650`）。agent 看不到 `twitter_search(query)`，得先 `site_search` 再拼字符串 key 调用 —— 发现成本和拼参成本都压在 agent 身上。
2. **捕获是纯手工**：跑 `network` → 肉眼看 → 手写 JS → 存盘。没有"一键冻结网络请求成 adapter"的机制。
3. **签名没进协议**：`@meta.args` 是文本描述，MCP 暴露的是无类型 `string[]`，也没有响应 schema。

### "①" 的精确再定义

> bb-sites 是底座（库）。"①API 捕获→晋升 MCP 工具" = 在它之上补两个 delta：
> - **(a) 自动冻结**：`browser_network` 抓到的请求一键变 adapter（URL/headers/鉴权/参数 + 推断响应 schema）
> - **(b) 每个 adapter 自动注册成带类型签名的独立 MCP 工具**

---

## 2. 用户当前聚焦的两条线

### 线 A：发现 / 调用做得更好（双受众）

**关键洞察：一份元数据，两个渲染。** `@meta` 已存在每个 adapter 里，缺的是 daemon 侧的**目录端点**（现有 `/api/overview` `/api/commands` `/api/logs`，**没有 `/api/sites`**）。补上后 agent 端（MCP）和人/UI 端（Tauri）消费同一份目录。

- **给 agent**：别把 103 个都注册成原生工具（context 会爆，选工具准确率下降）。
  - 旁证：当前 Claude 环境就把 bb-browser 工具 **deferred + ToolSearch** 延迟加载。
  - 正确形态 = **search-first / 按需加载**：把 `site_search`/`site_recommend` 做强（语义 + 按当前 tab 域名/历史排序）；agent 锁定平台后再动态注册 `twitter/*` 为真工具，用完回收。
- **给人（UI）**：面板加 **Capabilities Tab** —— 可搜索目录（按平台分组、签名/示例/readOnly/本地 vs 社区/健康状态/最近使用），把 `@meta.args` 渲染成表单 → 一键跑 → 内联看 JSON（adapter 版 Postman/Swagger UI）。顺便是 ③ 操作台入口。

### 线 B：多 agent 调用（用户重心）

**重新框定**：网络可达性已解决。真正硬问题是 **"N 个 agent 共享同一个有状态的物理浏览器，怎么不互相踩。"** 共享登录态是核心价值，但 tab 状态会被争抢。

五个维度：

| 维度 | 现状（2026-06-02） | 剩余缺口 |
|---|---|---|
| **身份** | ✅ per-agent session ID（`X-BB-Session` header / `SessionManager`） | — |
| **隔离/并发** | ✅ per-session currentTargetId + tab lease（`TabState.leaseOwner`/`leaseMode`, `tab_claim`/`tab_release` MCP 工具） | — |
| **调度** | ✅ `CommandScheduler`（全局+per-session 并发上限 + least-loaded 公平性，`command-scheduler.ts`） | — |
| **权限/信任** | ✅ scope 系统（`full`/`read-only`/`no-eval`），`eval`/`trace start` 受控 | — |
| **审计** | ✅ `CommandHistory` 带 `sessionId` + 控制面板「活动」tab 实时展示（`ActivityPage.jsx`） | — |

**生命周期串联：**

```
agent 连上 → 标识身份 → 拿到「被允许看到」的 scoped catalog
           → 调用时租 tab、进队列、被审计 → UI 实时显示谁在用哪个 tab、跑了什么
```

**A 与 B 的交汇点**：scoped catalog —— 只读 agent 连 `readOnly:false` 的 adapter 都发现不到。`@meta.readOnly` 是天然的权限杠杆。

---

## 3. 未决岔路口（下次从这里接着聊）

> ✅ = 已实现（2026-06-02，行号经 2026-06-02 复核修正），~~删除线~~ = 已解决
> 每个 ✅ 后面标注了实现位置（代码行 / 模块）

### ✅ P1 多 agent 已闭环（2026-06-02）

多 agent 线的两块 P1 已全部落地：

1. [x] ~~**调度队列（P1）**~~\
   ✅ 已实现（2026-06-02）。`command-scheduler.ts` 的 `CommandScheduler`：每条 `/command` 在打到共享 CDP 前先 `acquire` 一个槽。全局上限 `BB_SCHED_GLOBAL_LIMIT`（默认 12）+ per-session 上限 `BB_SCHED_SESSION_LIMIT`（默认 4）+ 公平性（least-loaded-session-first 准入，平局 FIFO）。接在 `http-server.ts` 的 CDP-ready 等待之后、`dispatchRequest` 之前；与 tab lease 正交、无死锁。`/status` 暴露 `scheduler` 统计供审计 UI 用。单测见 `__tests__/command-scheduler.test.ts`。
2. [x] ~~**审计 UI 实时展示（P1）**~~\
   ✅ 已实现（2026-06-02）。控制面板独立「🛰 活动」tab（`src-panel/src/pages/ActivityPage.jsx`）：调度状态条（在飞/排队/活跃 agent/占用 tab）+ 可点筛选的 session 行（scope badge、当前 tab + 独占租约、在飞命令数、最近活跃）+ 按 `sessionId` 归属的命令流。纯消费已有数据面（`/status.scheduler` + `/status.sessions/tabs` + `/api/commands`），无新增端点。

→ **下一步（线 A，偏产品决策，待拍方向）**：agent 端 search-first vs 动态注册真工具二选一/都做；UI 端 Capabilities Tab 优先级。更远见下方"更远"小节（⑤数据统一层等）。

### 多 agent（用户重心，需先钉一个子问题深挖到可动手）

- [x] ~~**tab 模型**：共享 active tab / per-agent 租约 / session 抽象~~\
  ✅ **`session-state.ts`**（per-session currentTargetId）+ **`tab-state.ts`**（`leaseOwner`/`leaseMode` exclusive）+ **`command-dispatch.ts:943-956`**（`tab_claim`/`tab_release` dispatch）。`tab_claim`/`tab_release` 已自动注册为 MCP 工具 `browser_tab_claim`/`browser_tab_release`（`commands.ts:311-324` → `mcp/index.ts:528-542` 自动生成循环）。
- [x] ~~**信任模型**：scope + token + 审计~~\
  ✅ **`session-state.ts`** 的 `SessionScope`（`"full"` / `"read-only"` / `"no-eval"`），等级不可 escalate。**`command-dispatch.ts:534-542`** 按 scope 拦截 eval/trace start（`isEvalLike` 在 `:521-524` 同时覆盖 `eval` 和 `trace start`）。**`command-history.ts`** 已加 `sessionId` 字段（`CommandRecord.sessionId`），`/api/commands` 返回每条命令的归属 session。\
  剩余缺口：~~调度队列（P1）、审计 UI 实时展示（P1）~~ → 均已闭环，见本节顶部「✅ P1 多 agent 已闭环」。
- [x] ~~**远程 `eval` 策略**~~\
  ✅ 折叠进 scope 系统：`no-eval` scope 拒绝 `eval` 和 `trace start`，`read-only` scope 只允许观察类命令。

### 发现（线 A）

- [x] ~~是否新增 daemon `/api/sites` 目录端点~~\
  ✅ 已实现。路由 `http-server.ts:159`、处理 `:304`（`GET /api/sites?q=&domain=&invalidate=1`），由 `site-catalog.ts` 驱动。`site_list`/`site_search` MCP 工具优先走 daemon 端点，fallback CLI。
- [ ] agent 端：做强 `site_search`/`site_recommend` vs 动态注册真工具，二选一或都做
- [ ] UI 端：面板 Capabilities Tab 的优先级

### 更远（暂未展开，先记下）

- ⑤数据统一层 / 反孤岛的形态：通用事件日志 + 语义检索 vs per-capability typed schema vs 混合
- 新鲜度契约（读缓存还是重新浏览）
- 能力自愈（站点变了自动标红 + 建议重录）
- 常驻浏览 / feed 化

---

## 4. 线 C — 状态持久面 (State Persistence Plane)（2026-06-03 敲定方向）

> 把上面「更远 · ⑤数据统一层 / 反孤岛」具体化的第一条线。由用户场景激活：
> *agent 独占的 tab 能否长期绑定？下次浏览器起来还记得这 tab 是 xxx agent 的？让 agent 不因浏览器关掉而丢任务，一接入就清楚自己的上下文。*

### 4.1 出发点：现有多 agent 状态全是「内存态、易失」

线 B 五维（身份/隔离/调度/权限/审计）已闭环，但**无一落盘**：

- 身份 `SessionManager`（`session-state.ts`）— 内存 `Map`，`gcIdle` 还会回收
- 租约 `TabState.leaseOwner/leaseMode` — 内存
- 审计 `CommandHistory` — 200 条 ring buffer，明确「no file I/O」
- per-tab 事件（network/console/errors/trace）— 内存 ring，按 targetId 索引

**致命约束**：整套状态以 CDP `targetId` 为主键（`tab-state.ts` `TabStateManager.tabs`）。
`targetId` 浏览器一重启就全变，`shortId` 由其尾部切出同样不稳定。
→ 今天连一个能跨重启存活的 tab 主键都没有。

### 4.2 三个已锁决策（2026-06-03）

| 决策 | 选择 | 含义 |
|---|---|---|
| **绑定语义** | 任务锚 + 主动续做 | binding 存 `{anchorUrl, intent, progress}`；重启后 agent 接入拿到未完成任务，自行 `open(anchorUrl)` 续做，daemon 把新 targetId 回挂 bbTabId。→ bbTabId 跨重启回挂只是 best-effort 便利，**正确性不挂在 URL 重匹配上**。 |
| **身份连续性** | daemon 协助派生稳定 agentId | MCP client info + label + 持久 registry 派生稳定 id；agent 自带 `X-BB-Session`/`BB_SESSION_ID` 优先。 |
| **存储基座** | 先 JSON 快照 | 原子写（临时文件 + rename），位于 `BB_BROWSER_HOME/state/`；查询需求出现再迁 JSONL/SQLite。 |

### 4.3 数据模型

```
BB_BROWSER_HOME/state/
  agents.json                     # registry: stable agentId → {label, fingerprint, scope, first/lastSeen}
  bindings.json                   # 任务锚数组
  agents/<agentId>/journal.json   # capped ring，原子写
```

```ts
// 任务锚（需求①）— 不是物理 tab，是"一个 agent 在某 URL 上的活"
interface TabBinding {
  bbTabId: string;          // daemon 分配的稳定句柄，与 targetId 解耦
  agentId: string;
  leaseMode: "exclusive" | "shared";
  anchorUrl: string;        // 重启后靠它重开
  title?: string;
  intent?: string;          // agent 写的任务意图
  progress?: string;        // 进度游标（到哪步了）
  liveTargetId?: string;    // 浏览器活着时的 CDP targetId；重启后失效待回挂
  status: "active" | "detached" | "done";
  createdAt: number; updatedAt: number;
}

// Tab Scratchpad（需求③）— 内存，短 TTL，不落盘
interface TabScratchpad {
  bbTabId: string; lastTouchedBy: string; lastAction: string;
  lastUrl: string; keyRefs?: string[]; updatedAt: number;  // TTL 驱逐
}
```

### 4.4 分阶段路线（每阶段独立交付，P0 是闸门）

| 阶段 | 做什么 | verify |
|---|---|---|
| **P0** 基座 | 新 `state-store.ts`（原子 JSON）；`TabStateManager` 给每 tab 附稳定 `bbTabId`（与 targetId 解耦）；`SessionManager` 升级为 daemon 派生稳定 agentId + `agents.json` 落盘 | 单测：杀 daemon 重启后 `agents.json` 恢复 registry；模拟 targetId 替换后 bbTabId 仍解析同一 binding |
| **P1** 持久绑定/任务锚 | `bindings.json` + 内存活映射；`tab_claim` 扩展接 `intent`，新 `browser_task_update` 写 progress/标 done；重启从 bindings.json 恢复 | e2e：claim+写 intent/progress → 杀 daemon → 同 agentId 重连 → 拿回含 intent/progress 的 binding；`open(anchorUrl)` 后 `liveTargetId` 回挂 |
| **P2** Journal + 握手 | `CommandHistory` 旁路 mirror 到 per-agent `journal.json`；新 `GET /api/agents/:id/context` + MCP `browser_resume` 返回 context bundle | agent 重连后**一次调用**即得到未完成 binding + 最近 N 条活动 |
| **P3** Scratchpad | 内存 `ScratchpadManager`，每命令派发后更新；`snapshot`/`tab_list` 响应附带 | agent A 操作后 agent B 的 `tab_list`/`snapshot` 看到 A 的最近动作摘要；TTL 过期消失 |
| **P4** 面板 | ActivityPage 扩展 + 新 Bindings 视图（agent/anchorUrl/intent/progress/status） | 面板看到跨重启存活的绑定与任务进度 |

### 4.5 新增对外面

- **MCP**：`browser_tab_claim`（+`intent`）、新 `browser_task_update`、新 `browser_resume`；scratchpad 自动随 `snapshot`/`tab_list` 返回。
- **HTTP**：`GET /api/agents`、`GET /api/agents/:id/context`、`GET /api/bindings`。

### 4.6 待定的缝（P0 要先定）

1. **agentId 派生指纹粒度** — MCP client name/version 可能粗（同 client 多实例难分），`label` 是主消歧手段，可能要约定 agent 接入时给 label。
2. **「永久」的边界** — journal 是 capped ring（如 per-agent 2000 条 + 字节上限），不是真无限；与「JSON-first，够痛再迁」一致。
3. **单写者前提** — 所有持久化写必须走 daemon（单 daemon 独占成立），P0 需复核没有旁路写。

---

## 附：本次讨论涉及的关键文件

- `packages/mcp/src/index.ts:650` — `site_run` 泛型派发器
- `packages/cli/src/commands/site.ts` — adapter 目录/解析/运行逻辑
- `packages/daemon/src/http-server.ts` — 现有 `/api/*` 端点（缺 `/api/sites`）
- `packages/daemon/src/command-history.ts` — 审计雏形
- `skills/bb-browser/references/{site-system,adapter-development}.md` — adapter 体系文档
