/**
 * Dashboard — 控制面板根组件
 *
 * 三段式布局：
 *   TitleBar (40px) — 拖拽区 + 状态指示 + 关闭按钮
 *   TabBar   (40px) — Overview / Trace / Logs 切换
 *   Content  (flex) — 当前 Tab 内容
 */

import { useState, useEffect } from 'react';
import { useStore } from './store/useStore.jsx';
import { daemon } from './api/daemon.js';

import OverviewPage from './pages/OverviewPage.jsx';
import ActivityPage from './pages/ActivityPage.jsx';
import BindingsPage from './pages/BindingsPage.jsx';
import TracePage from './pages/TracePage.jsx';
import LogsPage from './pages/LogsPage.jsx';
import CapabilitiesPage from './pages/CapabilitiesPage.jsx';

import styles from './Dashboard.module.css';

const TABS = [
  { id: 'overview',      label: '📊 Overview' },
  { id: 'activity',      label: '🛰 活动' },
  { id: 'bindings',      label: '🔗 绑定' },
  { id: 'capabilities',  label: '🔌 Capabilities' },
  { id: 'trace',         label: '🎬 Trace' },
  { id: 'logs',          label: '📋 Logs' },
];

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const { connected, setConnected } = useStore();

  // Auto-connect to daemon on mount + bridge connection events into the store
  // (the DaemonClient only tracks state internally; the UI reads `connected`
  // from the store, so we must mirror its events there).
  useEffect(() => {
    const onConnected = () => setConnected(true);
    const onDisconnected = () => setConnected(false);
    daemon.on('connected', onConnected);
    daemon.on('disconnected', onDisconnected);

    daemon.connect().catch((err) => {
      console.error('[panel] daemon connect failed:', err);
      setConnected(false);
    });

    return () => {
      daemon.off('connected', onConnected);
      daemon.off('disconnected', onDisconnected);
      daemon.disconnect();
    };
  }, [setConnected]);

  const closeWindow = () => {
    if (window.__TAURI__?.window) {
      window.__TAURI__.window.getCurrentWindow().hide();
    }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeWindow(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={styles.root}>
      {/* ── Title bar (draggable) ── */}
      <div className={styles.titlebar} data-tauri-drag-region>
        <div className={styles.titlebarLeft}>
          <span
            className={styles.statusDot}
            data-color={connected ? 'green' : 'red'}
            title={connected ? '已连接' : '未连接'}
          />
          <span className={styles.titlebarTitle}>bb-browser 控制面板</span>
        </div>
        <button className={styles.closeBtn} onClick={closeWindow} title="关闭 (Esc)">
          ✕
        </button>
      </div>

      {/* ── Tab bar ── */}
      <div className={styles.tabbar}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tabBtn} ${activeTab === tab.id ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className={styles.content}>
        {activeTab === 'overview'     && <OverviewPage />}
        {activeTab === 'activity'     && <ActivityPage />}
        {activeTab === 'bindings'     && <BindingsPage />}
        {activeTab === 'capabilities' && <CapabilitiesPage />}
        {activeTab === 'trace'        && <TracePage />}
        {activeTab === 'logs'         && <LogsPage />}
      </div>
    </div>
  );
}
