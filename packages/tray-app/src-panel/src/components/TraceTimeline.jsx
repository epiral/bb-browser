/**
 * Trace 时间线展示
 */

import { useState } from 'react';
import { useStore } from '../store/useStore.jsx';
import TraceEventDetail from './TraceEventDetail.jsx';

function TraceTimeline() {
  const { traceEvents, traceEventCount, selectedEventIndex, setSelectedEventIndex } = useStore();
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);

  const getEventTypeIcon = (type) => {
    const icons = {
      click: '🖱️',
      fill: '⌨️',
      select: '▾',
      check: '☑️',
      press: '⌨️',
      scroll: '⇕',
      navigation: '↔️',
    };
    return icons[type] || '•';
  };

  const getEventLabel = (event) => {
    switch (event.type) {
      case 'click':
        return `点击 ${event.elementName?.substring(0, 20) || event.elementRole}`;
      case 'fill':
        return `输入 ${event.value?.substring(0, 15) || ''}`;
      case 'select':
        return `选择 ${event.value}`;
      case 'check':
        return event.checked ? '勾选' : '取消勾选';
      case 'press':
        return `按键 ${event.key}`;
      case 'scroll':
        return `滚动 ${event.direction}`;
      case 'navigation':
        return `导航至 ${event.url.substring(0, 30)}...`;
      default:
        return event.type;
    }
  };

  const handleEventClick = (event, index) => {
    setSelectedEventIndex(index);
    setDetailPanelOpen(true);
  };

  const handleCloseDetail = () => {
    setDetailPanelOpen(false);
    setSelectedEventIndex(null);
  };

  return (
    <div className="trace-timeline">
      <div className="timeline-header">
        <span className="timeline-title">录制事件</span>
        <span className="timeline-count">{traceEventCount} 个事件</span>
      </div>

      <div className="timeline-events">
        {traceEvents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📝</div>
            <div className="empty-text">
              {traceEventCount === 0 ? '暂无录制的事件' : '停止录制后查看完整事件列表'}
            </div>
          </div>
        ) : (
          traceEvents.map((event, index) => (
            <div
              key={event.seq ?? `idx-${index}`}
              className={`timeline-event ${selectedEventIndex === index ? 'selected' : ''}`}
              onClick={() => handleEventClick(event, index)}
            >
              <span className="event-icon">{getEventTypeIcon(event.type)}</span>
              <span className="event-label">{getEventLabel(event)}</span>
              <span className="event-time">
                {new Date(event.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))
        )}
      </div>

      {detailPanelOpen && selectedEventIndex !== null && (
        <TraceEventDetail
          event={traceEvents[selectedEventIndex]}
          onClose={handleCloseDetail}
        />
      )}
    </div>
  );
}

export default TraceTimeline;
