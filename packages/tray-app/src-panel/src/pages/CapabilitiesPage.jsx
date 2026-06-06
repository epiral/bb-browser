/**
 * CapabilitiesPage — site adapter 目录
 *
 * 功能：
 *   - 搜索/过滤 adapter（名称、描述、域名）
 *   - 每个 adapter 展示签名、域名、readOnly 标记
 *   - 展开详情：参数表格 + example
 *   - 一键运行：填参数 → 调 site_run → 内联看 JSON 结果
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import styles from './CapabilitiesPage.module.css';

export default function CapabilitiesPage() {
  const { connected } = useStore();
  const [adapters, setAdapters] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  const fetchAdapters = useCallback(async (query) => {
    if (!daemon.isConnected()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await daemon.getSites(query);
      setAdapters(data.adapters ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search on query change
  const handleQ = (val) => {
    setQ(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchAdapters(val), 250);
  };

  // Load on mount / reconnect
  useEffect(() => {
    if (connected) fetchAdapters(q);
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.root}>
      {/* ── Search bar ── */}
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="搜索 adapter（名称 / 域名 / 描述）…"
          value={q}
          onChange={(e) => handleQ(e.target.value)}
          spellCheck={false}
        />
        <span className={styles.searchCount}>
          {loading ? '…' : `${adapters.length} / ${total}`}
        </span>
      </div>

      {/* ── Error ── */}
      {error && <p className={styles.errorMsg}>⚠ {error}</p>}

      {/* ── Adapter list ── */}
      {!error && adapters.length === 0 && !loading && (
        <p className={styles.empty}>{connected ? '无匹配 adapter' : '未连接到 daemon'}</p>
      )}
      <div className={styles.adapterList}>
        {adapters.map((a) => (
          <AdapterCard key={a.name} adapter={a} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdapterCard
// ---------------------------------------------------------------------------

function AdapterCard({ adapter: a }) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [argValues, setArgValues] = useState({});

  const argNames = Object.keys(a.args ?? {});

  const run = async () => {
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      // Build positional args array in order
      const args = argNames.map((k) => argValues[k] ?? '');
      const resp = await daemon.send('site_run', { name: a.name, args });
      setResult(resp);
    } catch (err) {
      setRunError(err.message ?? String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`${styles.card} ${expanded ? styles.cardExpanded : ''}`}>
      {/* ── Card header ── */}
      <div className={styles.cardHead} onClick={() => setExpanded((v) => !v)}>
        <span className={styles.chevron}>{expanded ? '▾' : '▸'}</span>
        <span className={styles.adapterName}>{a.name}</span>
        <span className={styles.adapterDomain}>{a.domain}</span>
        {a.readOnly && <span className={styles.badge}>只读</span>}
        {a.source === 'local' && <span className={`${styles.badge} ${styles.badgeLocal}`}>本地</span>}
      </div>
      <p className={styles.adapterDesc}>{a.description}</p>

      {/* ── Expanded details ── */}
      {expanded && (
        <div className={styles.details}>
          {/* Args table */}
          {argNames.length > 0 && (
            <div className={styles.argsSection}>
              <p className={styles.sectionLabel}>参数</p>
              <div className={styles.argsGrid}>
                {argNames.map((k) => (
                  <div key={k} className={styles.argRow}>
                    <label className={styles.argLabel} title={a.args[k]?.description}>
                      {k}
                      {a.args[k]?.required && <span className={styles.required}>*</span>}
                    </label>
                    <input
                      className={styles.argInput}
                      type="text"
                      placeholder={a.args[k]?.description ?? ''}
                      value={argValues[k] ?? ''}
                      onChange={(e) => setArgValues((v) => ({ ...v, [k]: e.target.value }))}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Example */}
          {a.example && (
            <div className={styles.exampleRow}>
              <span className={styles.sectionLabel}>示例</span>
              <code className={styles.exampleCode}>{a.example}</code>
            </div>
          )}

          {/* Capabilities */}
          {a.capabilities?.length > 0 && (
            <div className={styles.capsRow}>
              {a.capabilities.map((c) => (
                <span key={c} className={styles.capBadge}>{c}</span>
              ))}
            </div>
          )}

          {/* Run button */}
          <button
            className={`${styles.runBtn} ${running ? styles.runBtnBusy : ''}`}
            onClick={run}
            disabled={running}
          >
            {running ? '运行中…' : '▶ 运行'}
          </button>

          {/* Result */}
          {runError && <p className={styles.runError}>✗ {runError}</p>}
          {result && (
            <pre className={styles.resultPre}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
