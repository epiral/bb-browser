/**
 * ActivityPage — 控制面板「活动」tab（多 agent 实时审计）
 *
 * 回答「谁在用哪个 tab、排了多少队、跑了什么」：
 *   - 调度状态：在飞命令 / 排队深度 / 活跃 agent / 被占用 tab（来自 GET /status.scheduler）
 *   - Agent 会话：每个 session 的 scope / 当前 tab + 租约 / 在飞命令数 / 最近活跃
 *   - 命令流：按 session 归属的命令（GET /api/commands），点会话可筛选
 */

import { useEffect, useCallback, useState, useMemo } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import styles from './ActivityPage.module.css';

const POLL_INTERVAL = 3000;

export default function ActivityPage() {
  const { connected } = useStore();
  const [status, setStatus] = useState(null);
  const [commands, setCommands] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!daemon.isConnected()) return;
    try {
      const [st, cmds] = await Promise.all([
        daemon.getStatus(),
        daemon.getCommands(100),
      ]);
      setStatus(st);
      setCommands(cmds.commands ?? []);
      setLastRefreshed(new Date());
      setError(null);
    } catch (err) {
      console.error('[ActivityPage] refresh error:', err);
      setError(err.message ?? String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [refresh, connected]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const sessions = status?.sessions ?? [];
  const tabs = status?.tabs ?? [];
  const scheduler = status?.scheduler ?? null;

  // targetId → tab record (for resolving a session's current tab + lease)
  const tabByTarget = useMemo(() => {
    const m = {};
    for (const t of tabs) m[t.targetId] = t;
    return m;
  }, [tabs]);

  // sessionId → display label (for attributing commands)
  const labelOf = useMemo(() => {
    const m = {};
    for (const s of sessions) m[s.id] = s.label ?? s.id.slice(0, 8);
    return m;
  }, [sessions]);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastSeen - a.lastSeen),
    [sessions],
  );

  const filteredCommands = useMemo(() => {
    if (!selectedSession) return commands;
    return commands.filter((c) => c.sessionId === selectedSession);
  }, [commands, selectedSession]);

  const inFlightOf = (id) => scheduler?.inFlightBySession?.[id] ?? 0;
  const occupiedTabs = tabs.filter((t) => t.leaseOwner).length;

  return (
    <div className={styles.root}>
      {/* ── Scheduler summary ── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>调度状态</h2>
          {lastRefreshed && (
            <span className={styles.cardCount} title="最近刷新时间">
              {lastRefreshed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          {error && (
            <span className={styles.cardCount} style={{ color: '#e74c3c' }} title={error}>⚠ 刷新失败</span>
          )}
        </div>
        {!status ? (
          <p className={styles.empty}>{connected ? '加载中…' : '未连接到 daemon'}</p>
        ) : (
          <div className={styles.statRow}>
            <Stat label="在飞命令" value={scheduler?.globalInFlight ?? 0} />
            <Stat label="排队" value={scheduler?.queueDepth ?? 0} warn={(scheduler?.queueDepth ?? 0) > 0} />
            <Stat label="活跃 Agent" value={sessions.length} />
            <Stat label="占用 Tab" value={occupiedTabs} />
          </div>
        )}
      </section>

      {/* ── Sessions ── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Agent 会话</h2>
          <span className={styles.cardCount}>{sessions.length} 个</span>
          {selectedSession && (
            <button className={styles.clearFilter} onClick={() => setSelectedSession(null)}>清除筛选</button>
          )}
        </div>
        {sessions.length === 0 ? (
          <p className={styles.empty}>暂无活跃 session</p>
        ) : (
          <div className={styles.sessionList}>
            {sortedSessions.map((s) => {
              const tab = s.currentTargetId ? tabByTarget[s.currentTargetId] : null;
              const active = Date.now() - s.lastSeen < 30_000;
              const inFlight = inFlightOf(s.id);
              const selected = selectedSession === s.id;
              return (
                <button
                  key={s.id}
                  className={`${styles.sessionRow} ${selected ? styles.sessionRowSel : ''}`}
                  onClick={() => setSelectedSession(selected ? null : s.id)}
                  title={`${s.id}\n点击筛选下方命令流`}
                >
                  <span className={`${styles.dot} ${active ? styles.dotActive : ''}`} />
                  <span className={styles.sLabel}>{s.label ?? s.id.slice(0, 8)}</span>
                  <ScopeBadge scope={s.scope} />
                  <span className={styles.sTab}>
                    {tab ? (
                      <>
                        <span className={styles.sTabId}>tab:{tab.shortId}</span>
                        {tab.leaseMode === 'exclusive' && tab.leaseOwner === s.id && (
                          <span className={styles.lease}>独占</span>
                        )}
                      </>
                    ) : (
                      <span className={styles.idle}>空闲</span>
                    )}
                  </span>
                  <span className={styles.sInflight}>{inFlight > 0 ? `▶ ${inFlight}` : ''}</span>
                  <span className={styles.sSeen}>{formatAge(s.lastSeen)}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Command stream (session-attributed) ── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>
            命令流{selectedSession ? ` · ${labelOf[selectedSession] ?? selectedSession.slice(0, 8)}` : ''}
          </h2>
          <span className={styles.cardCount}>{filteredCommands.length} 条</span>
        </div>
        {filteredCommands.length === 0 ? (
          <p className={styles.empty}>{selectedSession ? '该 session 暂无命令' : '暂无命令记录'}</p>
        ) : (
          <div className={styles.cmdList}>
            {filteredCommands.map((cmd, i) => (
              <div key={i} className={styles.cmdRow}>
                <span className={`${styles.cmdStatus} ${styles['status_' + cmd.status]}`}>
                  {statusIcon(cmd.status)}
                </span>
                <span className={styles.cmdSession} title={cmd.sessionId ?? '匿名调用'}>
                  {cmd.sessionId ? (labelOf[cmd.sessionId] ?? cmd.sessionId.slice(0, 8)) : '—'}
                </span>
                <span className={styles.cmdTool}>{cmd.tool}</span>
                {cmd.argsSummary && <span className={styles.cmdArgs}>{cmd.argsSummary}</span>}
                <span className={styles.cmdTime}>{formatAge(cmd.ts)}</span>
                {cmd.durationMs > 0 && <span className={styles.cmdDuration}>{cmd.durationMs}ms</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Stat({ label, value, warn }) {
  return (
    <div className={styles.stat}>
      <span className={`${styles.statValue} ${warn ? styles.statWarn : ''}`}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function ScopeBadge({ scope }) {
  if (scope === 'read-only') return <span className={`${styles.scope} ${styles.scopeRo}`}>只读</span>;
  if (scope === 'no-eval') return <span className={`${styles.scope} ${styles.scopeNoeval}`}>无eval</span>;
  return null; // "full" is the default — no badge to keep rows quiet
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAge(ts) {
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  return `${Math.floor(delta / 3600)}h`;
}

function statusIcon(status) {
  if (status === 'ok') return '✓';
  if (status === 'error') return '✗';
  return '…';
}
