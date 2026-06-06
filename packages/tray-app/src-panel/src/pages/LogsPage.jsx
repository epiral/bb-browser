/**
 * LogsPage — 控制面板 Logs tab
 *
 * 功能：
 *   - 实时滚动（5s 轮询 GET /api/logs）
 *   - 级别过滤（All / debug / info / warn / error）
 *   - 关键字搜索（前端 filter，不影响 API 请求）
 *   - 自动滚动到末尾（可手动关闭）
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import styles from './LogsPage.module.css';

const POLL_INTERVAL = 3000;
const LEVEL_OPTIONS = ['', 'debug', 'info', 'warn', 'error'];

export default function LogsPage() {
  const { connected, logs, logsLevel, logsSearch, setLogs, setLogsLevel, setLogsSearch } = useStore();
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!daemon.isConnected()) return;
    try {
      const data = await daemon.getLogs(logsLevel, 500);
      setLogs(data.logs ?? []);
    } catch (err) {
      console.error('[LogsPage] refresh error:', err);
    }
  }, [logsLevel, setLogs]);

  // Poll on mount + interval + when level changes
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [refresh, connected]);

  // Refresh immediately when the window becomes visible again
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Filter by keyword (client-side)
  const visibleLogs = logsSearch
    ? logs.filter((e) => e.msg.toLowerCase().includes(logsSearch.toLowerCase()))
    : logs;

  const handleScroll = (e) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div className={styles.root}>
      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        {/* Level filter */}
        <div className={styles.levelTabs}>
          {LEVEL_OPTIONS.map((lvl) => (
            <button
              key={lvl || 'all'}
              className={`${styles.levelTab} ${logsLevel === lvl ? styles.levelTabActive : ''}`}
              onClick={() => setLogsLevel(lvl)}
            >
              {lvl || 'All'}
            </button>
          ))}
        </div>

        {/* Keyword search */}
        <input
          className={styles.searchInput}
          type="text"
          placeholder="关键字过滤…"
          value={logsSearch}
          onChange={(e) => setLogsSearch(e.target.value)}
        />

        {/* Clear search */}
        {logsSearch && (
          <button className={styles.clearBtn} onClick={() => setLogsSearch('')}>✕</button>
        )}

        <span className={styles.countBadge}>{visibleLogs.length} 条</span>

        {/* Auto-scroll toggle */}
        <button
          className={`${styles.scrollBtn} ${autoScroll ? styles.scrollBtnOn : ''}`}
          onClick={() => setAutoScroll((v) => !v)}
          title="自动滚动到末尾"
        >
          ↓
        </button>
      </div>

      {/* ── Log list ── */}
      <div className={styles.list} ref={listRef} onScroll={handleScroll}>
        {visibleLogs.length === 0 ? (
          <div className={styles.empty}>
            {daemon.isConnected() ? '暂无日志' : '未连接到 daemon'}
          </div>
        ) : (
          visibleLogs.map((entry, i) => (
            <LogEntry key={i} entry={entry} search={logsSearch} />
          ))
        )}
      </div>
    </div>
  );
}

// ── LogEntry ──────────────────────────────────────────────────────────────────

function LogEntry({ entry, search }) {
  const time = new Date(entry.ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const msg = search
    ? highlightKeyword(entry.msg, search)
    : entry.msg;

  return (
    <div className={`${styles.logRow} ${styles['level_' + entry.level]}`}>
      <span className={styles.logTime}>{time}</span>
      <span className={`${styles.logLevel} ${styles['badge_' + entry.level]}`}>
        {entry.level.toUpperCase().padEnd(5)}
      </span>
      <span className={styles.logMsg} dangerouslySetInnerHTML={{ __html: msg }} />
    </div>
  );
}

function highlightKeyword(text, keyword) {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(esc, 'gi'),
    (m) => `<mark style="background:rgba(79,163,224,0.3);border-radius:2px">${m}</mark>`,
  );
}
