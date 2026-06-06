/**
 * 标签页管理面板
 */

import { useState } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';

/** Returns true for tabs the Trace engine can record (http/https pages). */
function isRecordable(tab) {
  return tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'));
}

function TabPanel() {
  const { tabs, activeTabId, setTabs, setActiveTab } = useStore();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const response = await daemon.send('tab_list');
      if (response.success && response.data.tabs) {
        setTabs(response.data.tabs);
      }
    } catch (err) {
      console.error('Failed to refresh tabs:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSelectTab = (tab) => {
    if (!isRecordable(tab)) return; // 非 http/https 页不可选为录制目标
    setActiveTab(tab, tab.tabId);
  };

  return (
    <div className="tab-panel">
      <div className="panel-header">
        <h3>标签页</h3>
        <button
          className="btn-icon"
          onClick={handleRefresh}
          disabled={refreshing}
          title="刷新"
        >
          {refreshing ? '⟳' : '↻'}
        </button>
      </div>
      <div className="tab-list">
        {tabs.length === 0 ? (
          <div className="empty-state">无标签页（点击 ↻ 刷新）</div>
        ) : (
          tabs.map((tab) => {
            const recordable = isRecordable(tab);
            return (
              <div
                key={tab.tabId}
                className={[
                  'tab-item',
                  tab.tabId === activeTabId ? 'active' : '',
                  !recordable ? 'tab-item--disabled' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => handleSelectTab(tab)}
                title={!recordable ? '此页面不支持录制（仅 http/https）' : tab.url}
              >
                <div className="tab-icon">{recordable ? '🌐' : '🔒'}</div>
                <div className="tab-info">
                  <div className="tab-title">{tab.title || tab.url}</div>
                  <div className="tab-url">{tab.url}</div>
                </div>
                {tab.tabId === activeTabId && (
                  <div className="tab-active-indicator">●</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default TabPanel;
