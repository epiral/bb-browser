//! Tray icon color + tooltip calculator.
//!
//! Pure function of (daemon state, CDP connection state, current port) →
//! (color, tooltip). The Tauri layer just paints what this returns.
//!
//! Per docs/system-tray-design.md §3.1:
//!
//! | Color  | Meaning              | Triggers                            |
//! |--------|----------------------|-------------------------------------|
//! | 🟢 Green | All good            | daemon running + CDP connected      |
//! | 🟡 Yellow | Reconnecting       | CDP dropped, retrying (<30s)        |
//! | 🔴 Red    | Failure             | daemon not running / CDP down long  |
//!
//! Tooltip format (§3.3):
//! - `bb-browser · 已连接 · :19826`
//! - `bb-browser · 重连中 · :19826`
//! - `bb-browser · 未运行`

use crate::supervisor::DaemonState;

/// Tray icon color states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayColor {
    Green,
    Yellow,
    Red,
}

/// CDP connection sub-state. Combined with DaemonState to produce a color.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CdpState {
    /// We're connected and getting events from Chrome.
    Connected,
    /// We've lost the WebSocket and are inside the 30s retry window.
    Reconnecting,
    /// 30s passed without a reconnect; or no connection ever made.
    Disconnected,
}

/// Aggregate snapshot used to render the tray icon.
#[derive(Debug, Clone)]
pub struct TraySnapshot {
    pub color: TrayColor,
    pub tooltip: String,
    pub status_text: String,
}

/// Compute color, tooltip, and human-readable status text.
///
/// `daemon_port` is included in the tooltip when the daemon is running.
pub fn calculate(daemon: DaemonState, cdp: CdpState, daemon_port: Option<u16>) -> TraySnapshot {
    let (color, status_text) = match (daemon, cdp) {
        // Daemon up, CDP fully connected → green.
        (DaemonState::Running, CdpState::Connected) => (TrayColor::Green, "已连接"),

        // Daemon up but CDP retrying → yellow.
        (DaemonState::Running, CdpState::Reconnecting) => (TrayColor::Yellow, "重连中"),

        // Daemon up but CDP long-disconnected → red.
        (DaemonState::Running, CdpState::Disconnected) => (TrayColor::Red, "Chrome 已断开"),

        // Mid-start / auto-restart → yellow (we're working on it).
        (DaemonState::Starting, _) => (TrayColor::Yellow, "重连中"),

        // Daemon stopped / failed / given up → red.
        (DaemonState::Stopped, _) => (TrayColor::Red, "未运行"),
        (DaemonState::FailedToStart, _) => (TrayColor::Red, "启动失败"),
        (DaemonState::GaveUp, _) => (TrayColor::Red, "已停止重启"),
    };

    let tooltip = build_tooltip(status_text, daemon_port, daemon);

    TraySnapshot {
        color,
        tooltip,
        status_text: status_text.to_string(),
    }
}

fn build_tooltip(status: &str, port: Option<u16>, daemon: DaemonState) -> String {
    let running = matches!(
        daemon,
        DaemonState::Running | DaemonState::Starting
    );
    match (running, port) {
        (true, Some(p)) => format!("bb-browser · {status} · :{p}"),
        _ => format!("bb-browser · {status}"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_and_connected_is_green() {
        let snap = calculate(DaemonState::Running, CdpState::Connected, Some(19826));
        assert_eq!(snap.color, TrayColor::Green);
        assert_eq!(snap.status_text, "已连接");
        assert_eq!(snap.tooltip, "bb-browser · 已连接 · :19826");
    }

    #[test]
    fn running_and_reconnecting_is_yellow() {
        let snap = calculate(DaemonState::Running, CdpState::Reconnecting, Some(19826));
        assert_eq!(snap.color, TrayColor::Yellow);
        assert_eq!(snap.status_text, "重连中");
        assert_eq!(snap.tooltip, "bb-browser · 重连中 · :19826");
    }

    #[test]
    fn running_and_disconnected_long_is_red() {
        let snap = calculate(DaemonState::Running, CdpState::Disconnected, Some(19826));
        assert_eq!(snap.color, TrayColor::Red);
        assert_eq!(snap.tooltip, "bb-browser · Chrome 已断开 · :19826");
    }

    #[test]
    fn stopped_is_red_with_no_port_in_tooltip() {
        let snap = calculate(DaemonState::Stopped, CdpState::Disconnected, Some(19826));
        assert_eq!(snap.color, TrayColor::Red);
        assert_eq!(snap.status_text, "未运行");
        // Port is omitted when daemon isn't running — matches §3.3 example.
        assert_eq!(snap.tooltip, "bb-browser · 未运行");
    }

    #[test]
    fn starting_is_yellow() {
        let snap = calculate(DaemonState::Starting, CdpState::Disconnected, Some(19826));
        assert_eq!(snap.color, TrayColor::Yellow);
        assert_eq!(snap.status_text, "重连中");
    }

    #[test]
    fn starting_after_auto_restart_shows_port_in_tooltip() {
        // After a crash the supervisor re-enters Starting. Port should still
        // appear in the tooltip so the user sees which port we're trying.
        let snap = calculate(DaemonState::Starting, CdpState::Disconnected, Some(19826));
        assert_eq!(snap.color, TrayColor::Yellow);
        assert_eq!(snap.tooltip, "bb-browser · 重连中 · :19826");
    }

    #[test]
    fn failed_to_start_is_red() {
        let snap = calculate(DaemonState::FailedToStart, CdpState::Disconnected, None);
        assert_eq!(snap.color, TrayColor::Red);
        assert_eq!(snap.status_text, "启动失败");
        assert_eq!(snap.tooltip, "bb-browser · 启动失败");
    }

    #[test]
    fn gave_up_is_red() {
        let snap = calculate(DaemonState::GaveUp, CdpState::Disconnected, None);
        assert_eq!(snap.color, TrayColor::Red);
        assert_eq!(snap.status_text, "已停止重启");
    }

    #[test]
    fn cdp_state_ignored_when_daemon_stopped() {
        // Daemon is down — CDP state doesn't matter.
        for cdp in [
            CdpState::Connected,
            CdpState::Reconnecting,
            CdpState::Disconnected,
        ] {
            let snap = calculate(DaemonState::Stopped, cdp, None);
            assert_eq!(snap.color, TrayColor::Red);
        }
    }

    #[test]
    fn tooltip_omits_port_when_none_provided() {
        let snap = calculate(DaemonState::Running, CdpState::Connected, None);
        assert_eq!(snap.tooltip, "bb-browser · 已连接");
    }

    #[test]
    fn tooltip_omits_port_when_daemon_not_running() {
        // Even if a port is "remembered", we don't expose it once the
        // daemon stops — it would be misleading.
        let snap = calculate(DaemonState::Stopped, CdpState::Disconnected, Some(19826));
        assert_eq!(snap.tooltip, "bb-browser · 未运行");
    }
}
