/**
 * Trace 录制控制面板
 */

import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';

function TraceControls() {
  const {
    activeTab,
    traceRecording,
    setTraceRecording,
    setTraceEvents,
    clearTraceEvents,
    setShowExporter,
  } = useStore();

  const handleStart = async () => {
    try {
      const response = await daemon.send('trace', {
        traceCommand: 'start',
        tabId: activeTab?.tabId,
      });
      if (response.success) {
        setTraceRecording(true);
        clearTraceEvents();
      }
    } catch (err) {
      console.error('Failed to start trace:', err);
      alert('启动录制失败: ' + err.message);
    }
  };

  const handleStop = async () => {
    try {
      const response = await daemon.send('trace', {
        traceCommand: 'stop',
        tabId: activeTab?.tabId,
      });
      if (response.success) {
        setTraceRecording(false);
        if (response.data.traceEvents) {
          setTraceEvents(response.data.traceEvents);
        }
      }
    } catch (err) {
      console.error('Failed to stop trace:', err);
      alert('停止录制失败: ' + err.message);
    }
  };

  const handleClear = () => {
    if (confirm('确定要清空录制的事件吗？')) {
      clearTraceEvents();
    }
  };

  const handleExport = () => {
    setShowExporter(true);
  };

  return (
    <div className="trace-controls">
      <div className="control-group">
        {!traceRecording ? (
          <>
            <button
              className="btn btn-success"
              onClick={handleStart}
              disabled={!activeTab}
            >
              <span className="icon">●</span>
              开始录制
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleExport}
              disabled={!activeTab}
            >
              <span className="icon">↓</span>
              导出
            </button>
          </>
        ) : (
          <button className="btn btn-danger" onClick={handleStop}>
            <span className="icon">■</span>
            停止录制
          </button>
        )}
      </div>

      <div className="control-group">
        <button className="btn btn-ghost" onClick={handleClear}>
          <span className="icon">🗑️</span>
          清空
        </button>
      </div>
    </div>
  );
}

export default TraceControls;
