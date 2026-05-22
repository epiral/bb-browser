/**
 * 连接管理面板
 */

import { useStore } from '../store/useStore';
import { daemon } from '../api/daemon';

function ConnectionPanel() {
  const { connected, connecting, setConnecting } = useStore();

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await daemon.connect();
    } catch (err) {
      console.error('Failed to connect:', err);
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    daemon.disconnect();
  };

  return (
    <div className="connection-panel">
      {connected ? (
        <button className="btn btn-danger" onClick={handleDisconnect}>
          断开连接
        </button>
      ) : (
        <button
          className="btn btn-primary"
          onClick={handleConnect}
          disabled={connecting}
        >
          {connecting ? '连接中...' : '连接 Daemon'}
        </button>
      )}
    </div>
  );
}

export default ConnectionPanel;
