/**
 * BindingsPage — 持久绑定视图
 *
 * 展示所有跨重启存活的 tab 绑定（agent / anchorUrl / intent / progress）。
 * 对照 /status 的实时 tab 列表判断绑定是否仍"活跃"（bbTabId 存在于当前 tab 集合）
 * 还是"待恢复"（浏览器已重启，bbTabId 已失效）。
 */

import { useEffect, useCallback, useState } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import styles from './BindingsPage.module.css';

const POLL_INTERVAL = 5000;

export default function BindingsPage() {
  const { connected } = useStore();
  const [bindings, setBindings] = useState([]);
  const [liveBbTabIds, setLiveBbTabIds] = useState(new Set());
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!daemon.isConnected()) return;
    try {
      const [bindingsRes, statusRes] = await Promise.all([
        daemon.getBindings(),
        daemon.getStatus(),
      ]);
      setBindings(bindingsRes.bindings ?? []);
      const ids = new Set((statusRes.tabs ?? []).map((t) => t.bbTabId).filter(Boolean));
      setLiveBbTabIds(ids);
      setLastRefreshed(new Date());
      setError(null);
    } catch (err) {
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

  const activeCount = bindings.filter((b) => liveBbTabIds.has(b.bbTabId)).length;
  const ghostCount  = bindings.length - activeCount;

  return (
    <div className={styles.root}>
      {/* ── Header ── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>持久绑定</h2>
          <span className={styles.cardCount}>
            {bindings.length} 条
            {activeCount > 0 && <span className={styles.activePill}>{activeCount} 活跃</span>}
            {ghostCount  > 0 && <span className={styles.ghostPill}>{ghostCount} 待恢复</span>}
          </span>
          {lastRefreshed && (
            <span className={styles.ts} title="最近刷新时间">
              {lastRefreshed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          {error && (
            <span className={styles.ts} style={{ color: '#f85149' }} title={error}>⚠ 刷新失败</span>
          )}
        </div>

        {!connected ? (
          <p className={styles.empty}>未连接到 daemon</p>
        ) : bindings.length === 0 ? (
          <p className={styles.empty}>暂无持久绑定 — agent 调用 browser_tab_claim 时传入 intent 参数即可创建</p>
        ) : (
          <div className={styles.bindingList}>
            {bindings.map((b) => (
              <BindingCard key={b.bbTabId} binding={b} live={liveBbTabIds.has(b.bbTabId)} />
            ))}
          </div>
        )}
      </section>

      {/* ── Legend ── */}
      {bindings.length > 0 && (
        <section className={styles.card}>
          <p className={styles.legend}>
            <span className={styles.dotActive} /> 活跃：tab 当前存活，可直接操作 &nbsp;·&nbsp;
            <span className={styles.dotGhost} /> 待恢复：浏览器已重启，agent 重连后调用 browser_resume 获取 anchorUrl，重开 tab 续做
          </p>
        </section>
      )}
    </div>
  );
}

// ── Binding card ─────────────────────────────────────────────────────────────

function BindingCard({ binding, live }) {
  const { agentId, anchorUrl, intent, progress, claimedAt, updatedAt } = binding;

  return (
    <div className={`${styles.bindingCard} ${live ? styles.bindingLive : styles.bindingGhost}`}>
      {/* Status + Agent */}
      <div className={styles.bindingHeader}>
        <span className={live ? styles.dotActive : styles.dotGhost} title={live ? '活跃' : '待恢复'} />
        <span className={styles.agentId} title={agentId}>{shortId(agentId)}</span>
        <span className={styles.statusLabel}>{live ? '活跃' : '待恢复'}</span>
        <span className={styles.timePair}>
          <span title={`认领时间: ${new Date(claimedAt).toLocaleString('zh-CN')}`}>
            认领 {formatAge(claimedAt)}
          </span>
          {updatedAt !== claimedAt && (
            <span title={`更新时间: ${new Date(updatedAt).toLocaleString('zh-CN')}`}>
              · 更新 {formatAge(updatedAt)}
            </span>
          )}
        </span>
      </div>

      {/* URL */}
      <div className={styles.bindingRow}>
        <span className={styles.fieldLabel}>URL</span>
        <a
          className={styles.url}
          href={anchorUrl}
          target="_blank"
          rel="noreferrer"
          title={anchorUrl}
        >
          {truncate(anchorUrl, 60)}
        </a>
      </div>

      {/* Intent */}
      {intent && (
        <div className={styles.bindingRow}>
          <span className={styles.fieldLabel}>任务</span>
          <span className={styles.intentText}>{intent}</span>
        </div>
      )}

      {/* Progress */}
      {progress && (
        <div className={styles.bindingRow}>
          <span className={styles.fieldLabel}>进度</span>
          <span className={styles.progressText}>{progress}</span>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortId(id) {
  if (!id) return '匿名';
  // UUID → first 8 chars; slug → as-is up to 20 chars
  return id.length > 20 ? id.slice(0, 8) + '…' : id;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatAge(ts) {
  if (!ts) return '';
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 5)    return 'just now';
  if (delta < 60)   return `${delta}s 前`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m 前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h 前`;
  return `${Math.floor(delta / 86400)}d 前`;
}
