import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { daemon } from '../api/daemon';
import ConnectionPanel from './ConnectionPanel';
import TabPanel from './TabPanel';
import TraceControls from './TraceControls';
import TraceTimeline from './TraceTimeline';
import RealtimeMonitor from './RealtimeMonitor';
import ExportDialog from './ExportDialog';

function TraceStudio() {
  const {
    connected,
    connectionError,
    setConnected,
    setConnecting,
    setConnectionError,
    setTabs,
    setActiveTab,
    activeTab,
    traceRecording,
    setTraceRecording,
    setTraceEvents,
    addTraceEvent,
    lastUpdated,
  } = useStore();

  const lastEventCursorRef = useRef(null);

  // 监听 daemon 连接状态
  useEffect(() => {
    const handleConnected = () => {
      setConnected(true);
      setConnecting(false);
      setConnectionError(null);
      loadTabs();
    };

    const handleDisconnected = () => {
      setConnected(false);
      setConnectionError('连接已断开');
    };

    const handleError = (error) => {
      setConnectionError(error.message || '连接错误');
      setConnecting(false);
    };

    daemon.on('connected', handleConnected);
    daemon.on('disconnected', handleDisconnected);
    daemon.on('error', handleError);

    return () => {
      daemon.off('connected', handleConnected);
      daemon.off('disconnected', handleDisconnected);
      daemon.off('error', handleError);
    };
  }, [setConnected, setConnecting, setConnectionError, setTabs]);

  // Reset cursor only when recording flips false→true (a real new session),
  // not every time the polling effect re-mounts (StrictMode, activeTab ref
  // change, etc.). Re-mount resets used to make the next poll fetch the full
  // event history and duplicate everything into the store.
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (traceRecording && !wasRecordingRef.current) {
      lastEventCursorRef.current = null;
    }
    wasRecordingRef.current = traceRecording;
  }, [traceRecording]);

  // Recording poll. Uses a Web Worker timer because Chrome throttles main-thread
  // setInterval to >=60s once the tab is hidden — and the user almost always
  // switches away from TraceStudio to the page being recorded. Worker timers
  // are not throttled the same way, so events keep flowing live.
  useEffect(() => {
    if (!traceRecording || !connected) return;

    const workerSource = `
      let id = null;
      self.onmessage = (e) => {
        if (e.data === 'start' && id === null) {
          id = setInterval(() => self.postMessage('tick'), 1000);
        } else if (e.data === 'stop' && id !== null) {
          clearInterval(id); id = null;
        }
      };
    `;
    const worker = new Worker(
      URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' })),
    );

    let cancelled = false;
    let pollInFlight = false;
    const pollOnce = async () => {
      if (cancelled || pollInFlight) return;
      pollInFlight = true;
      try {
        const response = await daemon.send('trace', {
          traceCommand: 'events',
          tabId: activeTab?.tabId,
          since: lastEventCursorRef.current,
        });
        if (cancelled) return;
        if (response.success) {
          const events = response.data.traceEvents || [];
          for (const event of events) {
            addTraceEvent(event);
          }
          const nextCursor = response.data.cursor;
          if (nextCursor !== undefined) {
            lastEventCursorRef.current = nextCursor;
          }
          if (response.data.traceStatus && !response.data.traceStatus.recording) {
            setTraceRecording(false);
          }
        }
      } catch (err) {
        console.error('Failed to poll trace events:', err);
      } finally {
        pollInFlight = false;
      }
    };

    worker.onmessage = pollOnce;
    worker.postMessage('start');
    // Fire one poll immediately so the user sees their first event without
    // waiting for the first 1s tick.
    pollOnce();

    return () => {
      cancelled = true;
      worker.postMessage('stop');
      worker.terminate();
    };
  }, [traceRecording, connected, activeTab, setTraceRecording, addTraceEvent]);

  // 加载标签页列表 — 保存全部 page 类型标签（包括 chrome://），
  // TabPanel 负责显示时区分可录制和不可录制页面。
  // 自动激活首个 http/https 标签作为默认录制目标。
  const loadTabs = async () => {
    try {
      const response = await daemon.send('tab_list');
      if (response.success && response.data.tabs) {
        const allTabs = response.data.tabs;
        setTabs(allTabs);
        // 优先激活 daemon 标记的 active 标签；若它不可录制则回退到第一个 http/https 标签
        const markedActive = allTabs.find(t => t.active);
        const recordable = (t) => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'));
        const target = (markedActive && recordable(markedActive))
          ? markedActive
          : allTabs.find(recordable);
        if (target) {
          setActiveTab(target, target.tabId);
        }
      }
    } catch (err) {
      console.error('Failed to load tabs:', err);
    }
  };

  return (
    <div className="trace-studio">
      <header className="studio-header">
        <h1 className="studio-title">BB Browser Trace Studio</h1>
        <ConnectionPanel />
      </header>

      {!connected ? (
        <div className="connection-banner status-warning">
          <span className="status-icon">⚠️</span>
          <span>{connectionError || '未连接到 daemon'}</span>
        </div>
      ) : (
        <>
          <div className="studio-banner status-success">
            <span className="status-icon">✓</span>
            <span>已连接到 daemon</span>
          </div>

          <div className="studio-content">
            <aside className="sidebar">
              <TabPanel />
              <RealtimeMonitor />
            </aside>

            <main className="main-panel">
              <div className="controls-section">
                <TraceControls />
              </div>

              <div className="events-section">
                {traceRecording && (
                  <div className="recording-indicator">
                    <span className="recording-dot"></span>
                    <span>正在录制中...</span>
                    <span className="event-count">({lastUpdated ? '最近更新' : '等待操作'})</span>
                  </div>
                )}
                <TraceTimeline />
              </div>
            </main>
          </div>
        </>
      )}

      <ExportDialog />
    </div>
  );
}

export default TraceStudio;
