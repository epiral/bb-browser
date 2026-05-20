# bb-browser System Tray — 暂不实现的设计候选

本文档收录原详细设计中 **暂时不做** 的特性。每节注明：

1. **是什么** — 该特性的内容
2. **为什么暂不做** — 关键，避免无意义返工讨论
3. **触发实现的条件** — 什么情况下应当从 future 移回主设计

主设计：[system-tray-design.md](system-tray-design.md)。

> **核心原则**：MVP 阶段聚焦"可见 / 自愈 / 多端口 / TraceStudio 融合"。本文档的所有内容都是**有意延后**的决定，进 MVP 期间不应重新讨论；MVP 结束时再扫一遍看是否有触发条件达成。

---

## 1. 多场景模式

### 1.1 团队共享工作站

**是什么**：

```
bb-browser daemon start --shared

特性:
- 多 token 管理（每个团队成员一个，可吊销）
- Token 访问权限分级:
    readonly:  snapshot, get, network 读取
    interact:  以上 + click, fill, type, scroll
    admin:     以上 + open, close tab, trace
- 速率限制（每 token 10 req/s）
- 访问审计日志
- 并发控制 + 时间片（每天 08:00-22:00）
```

配套配置 schema：`mode: shared` + `tokens[].level` + `globalRateLimit` + `accessHours` + `auditLogPath`。

**为什么暂不做**：

- 多 token、权限分级、速率限制、时间片、审计日志 —— **这是企业 SaaS 思维**
- bb-browser 当前用户基本是单人单机
- 没有任何真实团队用户提过共享需求
- 即使有，shared mode 引入的攻击面（多 token 泄露、权限提升 bug）反而比 MVP 风险高

**触发实现条件**：

- 出现 ≥ 3 个团队提需求
- 或同一台 Chrome 同时挂 ≥ 2 个 MCP 客户端的实际投诉

---

### 1.2 CI/CD 无头模式

**是什么**：

```
bb-browser daemon start --headless

特性:
- 不创建托盘 / 不发系统通知
- 日志输出 stdout JSON Lines
- 健康检查 GET /health
- Prometheus /metrics 端点
    bb_daemon_commands_total / duration_seconds / cdp_connected / tabs_count / memory_bytes
- 优雅关闭 POST /shutdown
```

**为什么暂不做**：

- `--headless` flag 本身简单（不创建托盘），可以随时加；不必现在设计
- Prometheus 指标导出是过度工程化 —— 个人工具不需要，CI 用户也不需要 Grafana
- 当前 CI 用户用现有 daemon + `headless: true` 配置就能跑

**触发实现条件**：

- CI 用户提出"在 GitHub Actions 里挂了"等具体痛点
- 或有团队接入监控基础设施需要 Prometheus

---

### 1.3 远程开发 + TLS

**是什么**：

```
bb-browser daemon start --host 0.0.0.0 --tls

特性:
- bind 0.0.0.0
- TLS 自签名证书（~/.bb-browser/certs/）+ 用户可替换
- IP 白名单 --allow-ips "10.0.0.0/8,..."
- 强制 token（禁空 token）
- 连接限制（≤ 5 个并发 MCP 客户端）
- 启动时警告 "Daemon is accessible from network!"
```

**为什么暂不做**：

- 99% 远程开发用户已经用 SSH 隧道转发端口，无需 daemon 改造
- TLS 自签名证书 + 证书替换的 UX 复杂
- IP 白名单 / 防火墙规则是运维问题，daemon 不该承担

**触发实现条件**：

- 出现 SSH 隧道明确无法满足的场景（如多客户端同时连同一 daemon、移动设备访问）

---

### 1.4 多浏览器实例并存

**是什么**：

```
daemon 实例 1: --cdp-port 19825 → Chrome A（日常）
daemon 实例 2: --cdp-port 19827 → Chrome B（沙盒）

托盘:
  🟢 bb-browser × 2
    ├─ 实例 1 (port 19824) — Chrome A · 6 tabs
    └─ 实例 2 (port 19826) — Chrome B · 3 tabs

端口池管理:
  portPool.daemonRange [19824, 19924]
  portPool.cdpRange    [19825, 19925]
  portPool.allocated   { daemon: [...], cdp: [...] }
```

**与 MVP 1 "多端口控制" 的区别（不要混淆）**：

- MVP 1 多端口 = **单** daemon 同时管理 daemon HTTP + CDP 两个端口 —— 进主设计
- 本节 = **多** daemon 实例并存，每个连不同 Chrome —— 在 future

**为什么暂不做**：

- 实际"切换 Chrome A vs B"的场景，用 user data dir 切换更简单
- 多 daemon 实例引入：进程管理、托盘菜单展开、端口池、token 多份管理 —— MVP 不需要
- MVP 用户能开两个 user data dir 解决 90% 场景

**触发实现条件**：

- 用户提出"同时控制日常 + 沙箱 Chrome"且无法用 user data dir 解决（如要并发自动化）

---

### 1.5 WSL 跨系统场景

**是什么**：WSL 内运行的 AI agent 通过 MCP 控制 Windows 侧 Chrome。

三个备选方案：
- **A**：mDNS — `hostname.local`（Win11 22H2+）
- **B**：`bb-browser wsl-probe` 命令在 WSL 内自动探测 Windows IP（读 `/etc/resolv.conf` → 扫端口 → 写配置）
- **C**：daemon 检测 WSL 存在则自动 bind 0.0.0.0 + 启动时打印 Windows IP + Token

**为什么暂不做（但优先级靠前，可能 MVP 2 末就做）**：

- 当前用户 90% 在 Windows 原生使用
- WSL 用户可手动 `host.docker.internal` 或配置 `172.x.x.x` 临时解决
- 全自动方案（mDNS / wsl-probe）有跨系统调试成本
- WSL2 场景必须 bind 0.0.0.0 → 暴露到局域网（如果防火墙允许），安全敏感

**触发实现条件**：

- WSL agent 用户占比 ≥ 20%
- 或临时手动方案频繁出问题（IP 变化、防火墙拦截）

**简版兜底（MVP 2 末可考虑）**：把 `bind 127.0.0.1` 改为可选 `bind 0.0.0.0`，启动时打印 WSL 可达 IP。**不实现** wsl-probe 自动化。

---

## 2. 安全性高级特性

### 2.1 4 层防护体系（完整版）

**是什么**：

```
Layer 1: 网络隔离（默认 127.0.0.1，--host 时强制 token，Windows Firewall 自动拦截）
Layer 2: 认证令牌（Bearer 32-char hex，0600 文件权限，轮换 + 吊销）
Layer 3: 命令权限（browser_eval 禁用、URL 白名单、file:// chrome:// 拦截、敏感路径黑名单）
Layer 4: 审计日志（每条命令记录 token-id + 命令 + 参数摘要 + 结果，异常检测）
```

**主设计保留**：

- ✅ Layer 1 "默认 127.0.0.1"
- ✅ Layer 2 "Bearer + 0600 文件权限"

**暂不做**：

- Token 轮换 / 吊销 / 异常检测冻结
- URL 白名单 / 协议拦截 / 敏感路径黑名单
- 完整审计日志（共享模式才需要）

**为什么暂不做**：

- 单 token + 0600 文件权限对个人用户已足够
- 轮换/吊销/冻结是多 token 场景需求（见 §1.1）
- URL 白名单增加 UX 摩擦却防不住真正的攻击者：用户已经信任了自己安装的 agent

---

### 2.2 browser_eval 4 级沙箱

**是什么**：

```
Level 0 (off):     禁止 browser_eval
Level 1 (limited): 域名白名单 + 输出 10KB 限制 + 5s 超时
Level 2 (audit):   允许但记录完整脚本和结果
Level 3 (full):    无限制（仅个人开发者 --allow-eval）
```

**为什么暂不做**：

- 4 级是过度细分
- MVP 用 2 级足够：默认 off，加 `--allow-eval` 开启
- 个人工具的 eval 风险用户自己承担；多级沙箱反而误导用户以为安全

**触发实现条件**：团队共享模式立项时（见 §1.1）一起做

---

### 2.3 Token 生命周期管理

**是什么**：

```
创建 → 使用 → 轮换 → 吊销
       ↓                ↑
       过期 ───────────┘
       异常 → 临时冻结 (15min) → 自动解冻 或 吊销
```

POST /token/rotate（5min 优雅期）/ POST /token/revoke。

**为什么暂不做**：

- 个人 token 不需要轮换 — 重启 daemon 生成新 token 就够了
- 异常检测自动冻结是 SaaS 反欺诈逻辑，本工具不需要
- "5min 优雅期"等并发安全细节增加实现复杂度，收益微乎其微

---

## 3. 稳定性高级机制

### 3.1 独立 Watchdog 进程（三进程架构）

**是什么**：

```
Tray UI Process  ── 独立，不崩影响 daemon
Watchdog Process ── 独立，监控 daemon
Daemon Process   ── 核心，可被 watchdog 重启
Chrome Process   ── 第三方
```

**为什么暂不做**：

- Tauri Rust 主进程已是天然 supervisor，再加 watchdog **多此一举**
- 三进程架构带来 IPC 复杂度（托盘 ↔ watchdog ↔ daemon 三向通信）
- 单 supervisor 失败模式更可控、更容易测试

**触发实现条件**：发现 Tauri 主进程频繁崩溃（实测后再决定）

---

### 3.2 退化策略（Graceful Degradation P0/P1/P2 分级）

**是什么**：

```
P0 (必须存活): HTTP server, CDP connection  → 503 + 托盘红
P1 (可短暂降级): Network capture, Console capture, Trace recording → buffer 满 drop 最旧
P2 (非关键): Web UI, 系统通知, 指标导出 → 跳过
```

**主设计保留**：作为指导原则提一句。

**暂不做**：

- 明确的 P0/P1/P2 优先级体系 + 状态机
- Buffer 自动 trim + "buffers trimmed" 客户端事件

**为什么暂不做**：

- 阈值未经实测就硬编码，遇到误触发反而是麻烦
- "Buffer 满 drop 最旧" 已经实现（trace ring buffer），无需上升到框架

---

### 3.3 内存自动保护

**是什么**：

```
process.memoryUsage() 每 30s 检查
> 256MB → 警告日志
> 512MB → 清理最旧 buffer + 通知
> 1GB   → 强制重启
多 buffer 独立配置（network / console / errors）
```

**主设计保留**：Ring buffer 上限（已实现 `BB_TRACE_CAPACITY`）。

**暂不做**：

- 内存阈值警告 / 清理 / 强制重启
- 多 buffer 类型独立配置环境变量
- "buffers trimmed" 客户端通知事件

**为什么暂不做**：

- Node daemon 在 MVP 阶段不太可能撑到 256MB
- 阈值硬编码遇到误触发是大麻烦（自动重启会打断 in-flight trace）
- 真要遇到内存问题，先看哪里漏的，再决定阈值

---

### 3.4 4 级错误分类

**是什么**：

```typescript
enum ErrorSeverity { FATAL, CRITICAL, WARNING, INFO }
```

每级有独立处理路径（log / metrics / 退出码 / watchdog 通知）。

**为什么暂不做**：

- FATAL / CRITICAL / WARNING / INFO 是 Java 企业代码风格
- MVP 用 2 级足够：可恢复（log + 返回错误）/ 不可恢复（process.exit(1)）
- 4 级在实际代码里很难判定边界（"CRITICAL 还是 WARNING？"），会变成开发者赌博

---

### 3.5 多文件日志系统

**是什么**：

```
~/.bb-browser/logs/
  ├── daemon.log          ← daemon 主日志
  ├── tray.log            ← 托盘日志
  ├── audit.log           ← 共享模式审计
  └── diagnostics/        ← 时间戳目录
```

**主设计保留**：单一 `daemon.log` + 10MB 轮转 + 5 个历史 + 7 天清理。

**暂不做**：

- `tray.log` 单独文件（Tauri 主进程日志走系统日志即可）
- `audit.log`（共享模式特性，见 §1.1）
- `diagnostics/` 目录（一键诊断功能见主设计 §15.4 故障诊断报告导出）

---

## 4. 监控与可观测性

### 4.1 Prometheus 指标导出

**是什么**：

```
GET /metrics →
  bb_daemon_commands_total{status="success"} 1523
  bb_daemon_commands_duration_seconds{quantile="0.5"} 0.12
  bb_daemon_cdp_connected 1
  bb_daemon_tabs_count 6
  bb_daemon_memory_bytes 78643200
```

**为什么暂不做**：

- 个人工具的"用户"是 1 个人，看托盘 + 控制面板足够
- 接 Prometheus 意味着要部署 Grafana → 完全偏离 MVP 用户场景

**触发实现条件**：CI/CD 模式正式立项（见 §1.2）

---

### 4.2 自愈状态持久化（recovery.json）

**是什么**：

```json
~/.bb-browser/recovery.json
{
  "lastCrash": "...",
  "restartCount": 2,
  "restartWindow": "...",
  "backoffLevel": 2,
  "degradedServices": [...]
}
```

**为什么暂不做**：

- 重启计数放内存（Tauri 主进程内）即可，5 分钟窗口的状态没必要持久化
- 持久化反而带来读写竞态问题
- "degradedServices" 字段对应的退化策略本身就推迟了（见 §3.2）

---

### 4.3 Cmd 队列堆积警告

**是什么**：未处理命令 > 100 → 警告；超阈值拒绝 503；图标闪烁。

**为什么暂不做**：

- daemon 是同步处理命令，不存在"队列堆积"的真实场景
- 即使将来异步化，100 这个阈值缺乏依据
- "图标闪烁"对用户体验是骚扰

---

## 5. 何时回看本文档

每个 MVP 结束时（约 3 周一次），扫一遍本文档：

- 是否有特性的"触发条件"已达成？→ 移回主设计
- 是否有新场景应当加入本文档作为占位？

**不要**在 MVP 进行中讨论本文档内容 — 这是已经做出的"延后"决定。在 MVP 中重启这些讨论是 scope creep 的典型来源。

---

## 附录：被砍掉的设计图（参考）

### A.1 原三进程架构图

```
┌──────────────────────────────────────────┐
│            Tray UI Process               │  ← 托盘进程
│  - 托盘图标 / 菜单 / 通知 / 自动更新     │
├──────────────────────────────────────────┤
│            Watchdog Process              │  ← 看门狗
│  - 监控 daemon 心跳 / 自愈决策           │
├──────────────────────────────────────────┤
│            Daemon Process                │  ← 核心
│  - HTTP server / CDP / Command router    │
├──────────────────────────────────────────┤
│            Chrome Process                │  ← 第三方
└──────────────────────────────────────────┘
```

被简化为：Tauri Rust 主进程（兼托盘 + supervisor）+ daemon Node 子进程。

### A.2 原 5 阶段优雅关闭

被简化为 3 阶段（停接收 → 等完成 → 关 + 退出）。

### A.3 原 5 色托盘图标

```
🟢 daemon + CDP + MCP 客户端
🔵 daemon + CDP（无 MCP）
🟡 重连中
🔴 CDP 断开（> 30s）
⚫ daemon 未运行
```

被简化为 3 色（🟢 运行 / 🟡 重连中 / 🔴 故障）。蓝色"无 MCP"对单人用户无意义。

### A.4 原 Phase 3 / Phase 4 路线图

原 Phase 3（多场景 + 安全）和 Phase 4（稳定性增强）的内容全部移到本文档对应章节。MVP 阶段不再有 Phase 3 / 4 的概念，改为 M3+ 按需启动。
