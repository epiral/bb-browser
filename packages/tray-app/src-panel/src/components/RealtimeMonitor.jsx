/**
 * 实时监控面板 - 显示录制状态和实时数据
 */

import { useStore } from '../store/useStore.jsx';
import { useEffect, useRef } from 'react';

function RealtimeMonitor() {
  const {
    traceRecording,
    traceEventCount,
    realTimeStats,
  } = useStore();
  const canvasRef = useRef(null);
  const animationRef = useRef(null);

  // 绘制录制指示器动画
  useEffect(() => {
    if (!traceRecording) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase = 0;

    const animate = () => {
      phase += 0.1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 绘制脉冲效果
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = 15 + Math.sin(phase) * 3;

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(239, 68, 68, ${0.3 + Math.sin(phase) * 0.1})`;
      ctx.fill();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 绘制内圈
      ctx.beginPath();
      ctx.arc(centerX, centerY, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [traceRecording]);

  return (
    <div className="realtime-monitor">
      <div className="panel-header">
        <h3>实时监控</h3>
      </div>

      <div className="monitor-content">
        <div className="monitor-item">
          <div className="monitor-label">录制状态</div>
          <div className="monitor-value">
            {traceRecording ? (
              <span className="status-recording">
                <span className="recording-dot"></span>
                录制中
              </span>
            ) : (
              <span className="status-idle">空闲</span>
            )}
          </div>
        </div>

        <div className="monitor-item">
          <div className="monitor-label">事件数量</div>
          <div className="monitor-value">{traceEventCount}</div>
        </div>

        {traceRecording && (
          <>
            <div className="monitor-item">
              <div className="monitor-label">当前页面</div>
              <div className="monitor-value monitor-truncate">
                {realTimeStats.currentUrl || '-'}
              </div>
            </div>

            <div className="monitor-item">
              <div className="monitor-label">最新事件</div>
              <div className="monitor-value">{realTimeStats.lastEventType || '-'}</div>
            </div>

            <div className="monitor-visual">
              <canvas ref={canvasRef} width={80} height={80} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default RealtimeMonitor;
