/**
 * Trace 事件详情面板
 */

function TraceEventDetail({ event, onClose }) {
  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleString('zh-CN');
  };

  const fields = [
    { label: '类型', value: event.type, code: true },
    { label: '时间', value: formatTime(event.timestamp) },
    { label: '页面 URL', value: event.url, truncate: true },
    { label: 'XPath', value: event.xpath, truncate: true },
    { label: 'CSS 选择器', value: event.cssSelector, truncate: true },
  ];

  if (event.value !== undefined) {
    fields.push({ label: '值', value: event.value, truncate: true });
  }
  if (event.key) {
    fields.push({ label: '按键', value: event.key });
  }
  if (event.direction) {
    fields.push({ label: '方向', value: event.direction });
  }
  if (event.pixels) {
    fields.push({ label: '像素', value: event.pixels });
  }
  if (event.checked !== undefined) {
    fields.push({ label: '勾选状态', value: event.checked ? '已勾选' : '未勾选' });
  }
  if (event.ref !== undefined) {
    fields.push({ label: '引用 ID', value: event.ref });
  }
  if (event.elementRole) {
    fields.push({ label: '元素角色', value: event.elementRole });
  }
  if (event.elementName) {
    fields.push({ label: '元素名称', value: event.elementName });
  }
  if (event.elementTag) {
    fields.push({ label: '元素标签', value: event.elementTag });
  }

  return (
    <div className="event-detail-overlay" onClick={onClose}>
      <div className="event-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <h3>事件详情</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="detail-content">
          {fields.map((field, index) => (
            <div key={index} className="detail-field">
              <div className="field-label">{field.label}</div>
              <div className={`field-value ${field.code ? 'code' : ''} ${field.truncate ? 'truncate' : ''}`}>
                {field.value || '-'}
              </div>
            </div>
          ))}
        </div>
        <div className="detail-actions">
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

export default TraceEventDetail;
