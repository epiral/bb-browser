# 给 Agent 造一个浏览器

> 一份随想，不是路线图。读了 Coze 3.0、GitHub 周榜几个项目、以及一些垂直知识 agent 的案例后，重新想了一遍「bb-browser 应该长成什么样」。
>
> 起始日期：2026-06-03

---

## 0. 一句话命题

> **现在的浏览器是为人类造的。Agent 需要的浏览器，长得完全不一样。**

人类浏览器解决的是「一个人类在 1920×1080 像素上消费信息」——视觉渲染、鼠标点击、标签页、书签、历史记录。

Agent 浏览器解决的是「N 个 AI 程序同时从一个真实浏览器获取结构化数据，并在团队内复用」。

这两个问题集交集很小。强行让 agent 用人类浏览器，就像让自动驾驶用人眼——能跑，但不该是终局。

---

## 1. Agent 视角的"浏览"是什么

人类看到的是页面。Agent 看到的是**数据管道**。

当 agent 打开一个网页，它实际在问：

| 问题 | 人类方式 | Agent 需要的方式 |
|------|---------|----------------|
| 这个页面有什么？ | 视觉看到文字和图片 | 结构化数据（JSON / 可访问树 / API 响应） |
| 这个数据从哪来？ | 看不到来源 | 底层 API 请求 + 响应 schema |
| 我下次怎么再来拿？ | 收藏夹 | 固化成一个可调用的 adapter |
| 别人拿过吗？ | 不知道 | 查缓存 + 看 freshness |
| 这个站改版了怎么办？ | 自己适应 | adapter 标红 + 建议重录 |

**关键洞察：Agent 不需要"浏览"，需要的是"获取 + 结构化 + 复用"。** 浏览器只是这三步的基础设施。

---

## 2. 当前的形状：一个 agent 驱动的浏览器 (v0.11)

bb-browser 今天做的事情，是用 CDP 把真实 Chromium 的控制权开放给 AI agent。已经有了：

- **40+ MCP 工具**：click/fill/snapshot/eval/network/tab 管理 —— 一个 agent 能"操作"浏览器
- **多 agent 共存**：session 隔离、tab 租约、调度队列、scope 权限、审计 —— N 个 agent 不打架
- **site adapter 体系**：36 平台 / 103 命令，每个 adapter 是逆向工程的 API 封装 —— 从"操作"到"获取结构化数据"
- **状态持久化**：agent registry、binding store、task anchors、journal —— agent 跨重启不丢上下文
- **桌面壳**：Tauri 托盘 + 控制面板 —— 人类能看见 agent 在干嘛

这是正确的起点。但距离"agent 的浏览器"还很远。

差距不在功能数量，在于**设计出发点**。今天的设计出发点仍然是"让 agent 能控制一个人类浏览器"，而非"构建一个浏览器原生以 agent 为第一公民"。

---

## 3. 我想要的形状：agent-first 浏览器的五个特征

### 3.1 浏览器即 API 网关，不是渲染引擎

对 agent 而言，页面加载后最有价值的东西不是 DOM，是**页面发出的网络请求**。

```
agent 想获取 GitHub 通知
  → 当前方式：open(github.com) → wait → snapshot → 找通知元素 → 读文本
  → 应该的方式：open(github.com) → browser_network 捕获 API → 返回结构化 JSON

区别是：从"读渲染结果"变成"拦截数据源"。
```

bb-browser 的 site adapter 已经是这个方向——每个 adapter 是一个"平台 API 的精简客户端"。但目前 adapter 是**手写的**。

**我想看到的是：agent 访问一个站 → browser_network 自动识别请求模式 → 一键冻结成 adapter → 自动注册为可调用工具。**

这就是 Coze 3.0 skill store 的核心逻辑，只不过它是中心化的、由平台维护的。bb-browser 可以做去中心化的、由 agent 协作生长的 adapter 生态。

### 3.2 一次获取，全队可用（数据沉淀层）

当前 flywheel 的核心洞察：
```
agent A 浏览(①)  → 抓到底层 API(②)  → 固化成命名 adapter(③)
     ↑                                        ↓
下一个 agent 直接调 adapter，不用重新浏览 ← 数据沉淀到本地(④)
```

这是 bb-browser 最深的洞察，也是今天**最有价值但最未尽其用**的部分。

今天的数据沉淀层（command-history + journal + scratchpad）是日志性质的。我想看到的是：

- agent A 调用了 `site_twitter_search("AI agents")` → 结果不仅返回给 A，还落在本地缓存中
- agent B 下次搜相似关键词 → 先读缓存（可配置 freshness TTL）
- 长时间没更新 → 自动重新浏览 → 替换缓存

**这不是分布式缓存，是"基于真实浏览行为的本地数据湖"。** 越多 agent 用这个浏览器，这个湖就越深，重复浏览就越少。

### 3.3 浏览器是 agent 的持久工作台，不是临时工具

对人类，浏览器是"用完即走"的工具。关标签页 = 事情结束。

对 agent，关标签页 = 任务中断。agent 需要：

- **跨重启的任务锚**：今天 P0-P4 在做这个（bbTabId / binding / journal）
- **agent 之间的任务接力**：agent A 填完表单 → 通知 agent B 来提交 → B 接管这个 tab
- **长时间运行的任务主键**：一个 tab 绑定到"给 PR #123 写评论"这个意图，不是绑定到一个 URL

这其实是**把 agent 工作流和浏览器状态绑在一起**。浏览器的状态不再只是"打开了哪些 URL"，而是"哪些 agent 在哪些 URL 上做到哪一步了"。

### 3.4 Skill 是 agent 浏览器的第一公民，不是插件

Coze 3.0 给我的最大触动：**Know-how 在 skill 里，不在用户的 prompt 里。**

在 bb-browser 的语境里：

- Site adapter = 知道"怎么从 X 平台获取数据"的 know-how
- 一个录制完成的 trace = 知道"怎么在 GitHub 上创建 PR"的 know-how
- 一个 agent 的 journal + 纠正记录 = 知道"这类任务怎么做得好"的 know-how

今天的 adapter 文件离真正的 skill 还差几层：

| 维度 | 今天的 adapter | 我想要的 skill |
|------|---------------|---------------|
| 接口 | 泛型 `site_run(name, args)` | 独立类型签名工具 `twitter_search(query)` |
| 响应 schema | 无类型 `string[]` | Zod schema + 自动验证 |
| 发现 | `site_search("keyword")` 文本匹配 | 语义搜索 + 按当前域名推荐 + 按使用频率排序 |
| 版本 | 无版本概念 | git 跟踪 + 回滚 + diff |
| 健康 | 出错只能反馈 | 自动检测站点改版 + 标红 + 建议重录 |
| 组合 | 手动拼装 | adapter 可组成 pipeline |

**从 adapter 到 skill 的跨越** = 给 adapter 加 schema + 版本 + 健康检测 + 组合能力。这会是一个比 adapter 体系深得多的基础设施。

### 3.5 兼作 agent 团队协作的可见层

多个 agent 共享一个浏览器，不只是技术问题，也是信息透明问题。

今天多 agent 线（线 B）已经做了 session/tab lease/scheduler/audit 的技术闭环。但 agent 之间是**互相看不见的**：

- agent A 不知道 agent B 在哪个站上做了什么
- 没有"agent 活动时间线"——谁、在什么时候、操作了什么、结果如何
- 没有"agent 存储数据的面板"——今天的数据沉淀在哪里可查？

**控制面板应该从"人类看 daemon 状态的地方"变成"所有 agent 活动的可见层"：**

- 谁在用哪个 tab、做了什么
- 哪个 adapter 被频繁调用、哪个站出错了
- 哪些数据在缓存里、哪些已过期
- 哪个 agent 的哪个 binding 还没完成（任务看板）

---

## 4. 这个"浏览器"的边界在哪

### 不是操作系统

做好一件事：真实浏览器上下文 + 数据管道。不做"agent 的桌面环境"。

### 不是 adapter marketplace

提供 adapter 的生长/共享/健康机制，不做中心化审核、分成、评级。社区 adapter 和私有 adapter 都支持，让生态自己决定质量。

### 不是 agent 框架

不提供 agent 编排、思维链、模型管理。agent 框架（Hermes / Claude Code / Cursor）是它的用户，不是它的功能。

### 不是数据仓库

数据沉淀层提供的是基于真实浏览行为的缓存，不是通用数据湖。不做 ETL、不做分析引擎、不做 BI。

---

## 5. 如果这是真的，下一步应该做什么

基于当前已有的地基，以下是可以动手的方向（从浅到深）：

### 短期（已有地基，可立即动手）

1. **adapter 晋升独立 MCP 工具** — 每个 adapter 自动注册为带类型签名的 MCP 工具，解决 `site_run` 泛型调用的问题。这是线 A 的已确认方向。

2. **`/api/sites` 端点 UI 化** — 控制面板加 Capabilities Tab，把 adapter 目录渲染成可搜索/可浏览/可运行的界面。adapter 版 Postman。

3. **browser_network 一键冻结 adapter** — 捕获 → 选请求 → 命名 → 存为 adapter。把 adapter 从"手写"变成"操作"。这会显著降低 adapter 的生产成本。

### 中期（需要设计，已有猜想）

4. **agent 数据缓存层** — 在沉淀层之上加缓存语义：adapter 调用结果按 TTL 缓存，下一个 agent 读取时先走缓存。缓存命中率成为这个浏览器价值的核心指标。

5. **adapter 健康体系** — 自动检测 adapter 调用失败模式（401/404/结构变化），标记健康状况，触发重录建议。护城河：站点变了，适配层自动感知。

6. **agent 活动 Timeline** — 控制面板新增一个视图：时间线 + agent 维度，展示所有 agent 的操作流。这是"多 agent 浏览器"区别于"单 agent 浏览器工具"的关键 UI。

### 长期（需要验证假设）

7. **adapter 组合 pipeline** — adapter 可以串联：`search → extract → transform → store`。今天每个 agent 自己拼，将来可以通过 pipeline 声明。

8. **跨 adapter 的语义数据层** — 不同 adapter 返回的数据可以关联（如"这个 GitHub repo 在 X 上被讨论了什么"），在浏览器层面打通平台孤岛。

---

## 6. 和 Coze 3.0 之类平台的关系

Coze 3.0 走的是**中心化平台**路径——云端的 skill store、统一的执行环境、平台审核。适合"用户选一个 skill，点一下就用"的场景。

bb-browser 走的应该是**去中心化基础设施**路径——本地的 adapter 生态、agent 协作生长、数据沉淀在自己手里。适合"agent 自己做浏览决策，数据不出本地"的场景。

**两者是互补的**：Coze 3.0 出 know-how（行业知识封装），bb-browser 得出行动力（真实浏览器执行、数据获取、持久锚定）。怎么打通——Coze agent 调本地浏览器的 API？Coze skill 自动生成本地 adapter？——是值得想的方向，但不是现在想的事。

---

## 附：本文档与现有 vision doc 的关系

[vision-and-roadmap-discussion.md](vision-and-roadmap-discussion.md) 是当前设计讨论的记录，有明确的阶段和决策。本文档不替代它。

本文档的目的是**把 vision 拉远一层**：不讨论"下个 sprint 做什么"，而是讨论"如果 agent 是浏览器的第一公民，这个产品应该长什么样子"。它和现有 doc 的关系：

- 现有 doc 的"四层模型 + 飞轮" → 仍然成立，本文档在此基础上展开
- 线 A（发现/调用）→ 本文档 3.4 和 5.1-5.3 给出了更具体的方向
- 线 B（多 agent）→ 本文档 3.5 延伸到了 agent 之间的可见性
- 线 C（状态持久）→ 本文档 3.3 将其扩展到了"agent 工作台"的范畴
- ⑤数据统一层（现有 doc 的"更远"）→ 本文档 3.2 和 5.4 给了它一个名字和形状

---

*从 Coze 3.0 的产品直觉、GitHub 周榜项目的基础设施化、以及垂直知识 agent 的范式出发，回到 bb-browser 重新想了一遍。设计是迭代的，这个文档也是——放一段时间再回来看，可能想法会变。*
