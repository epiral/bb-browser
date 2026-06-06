//! Tray controller — pure-logic glue between the supervisor state machine
//! and the tray icon visuals.
//!
//! This module is intentionally Tauri-free so the state transitions can be
//! exercised in unit tests without spinning up a GUI. The Tauri layer
//! (`app.rs`) holds a `TrayController` behind a `Mutex` in app state and
//! calls into it on every relevant event.
//!
//! Per docs/system-tray-design.md §9 (lifecycle) + §3 (tray visuals).

use crate::supervisor::{DaemonState, Event, Supervisor, SupervisorAction};
use crate::tray_state::{calculate, CdpState, TraySnapshot};

/// Combined runtime state that the tray needs to render itself.
///
/// Holds:
/// - The supervisor (daemon lifecycle state machine)
/// - The CDP connection sub-state (set by the websocket watcher)
/// - The current daemon HTTP port (set after spawn confirms READY)
pub struct TrayController {
    supervisor: Supervisor,
    cdp_state: CdpState,
    daemon_port: Option<u16>,
    cdp_port: Option<u16>,
    token: Option<String>,
}

impl Default for TrayController {
    fn default() -> Self {
        Self::new()
    }
}

impl TrayController {
    pub fn new() -> Self {
        Self {
            supervisor: Supervisor::default(),
            cdp_state: CdpState::Disconnected,
            daemon_port: None,
            cdp_port: None,
            token: None,
        }
    }

    /// Compute the visual snapshot (color + tooltip) for the current state.
    pub fn snapshot(&self) -> TraySnapshot {
        calculate(self.supervisor.state(), self.cdp_state, self.daemon_port)
    }

    /// Current daemon lifecycle state.
    pub fn daemon_state(&self) -> DaemonState {
        self.supervisor.state()
    }

    /// Forward an event to the underlying supervisor. Returns the action
    /// the caller (Tauri layer) needs to perform (Spawn / Wait /
    /// NotifyGaveUp).
    pub fn handle_event(&mut self, event: Event) -> SupervisorAction {
        self.supervisor.handle(event)
    }

    /// Update the CDP connection sub-state (called from the websocket
    /// watcher).
    pub fn set_cdp_state(&mut self, cdp: CdpState) {
        self.cdp_state = cdp;
    }

    /// Set the resolved daemon HTTP port. Pass `None` after the daemon
    /// stops so the tooltip drops the port hint.
    pub fn set_daemon_port(&mut self, port: Option<u16>) {
        self.daemon_port = port;
    }

    /// Set the resolved CDP debug port (used by the popup display).
    pub fn set_cdp_port(&mut self, port: Option<u16>) {
        self.cdp_port = port;
    }

    /// Set the daemon's session token (shown to user for MCP config).
    pub fn set_token(&mut self, token: Option<String>) {
        self.token = token;
    }

    /// Resolved daemon HTTP port, if known.
    pub fn daemon_port_value(&self) -> Option<u16> {
        if self.is_active() {
            self.daemon_port
        } else {
            None
        }
    }

    /// Resolved CDP debug port, if known.
    pub fn cdp_port_value(&self) -> Option<u16> {
        if self.is_active() {
            self.cdp_port
        } else {
            None
        }
    }

    /// Current session token, if known.
    pub fn token_value(&self) -> Option<String> {
        if self.is_active() {
            self.token.clone()
        } else {
            None
        }
    }

    /// Bulk-update all daemon-side identity after the spawner has seen
    /// `BB_DAEMON_READY {...}` (used by Phase 2.8 wiring).
    pub fn set_daemon_identity(
        &mut self,
        daemon_port: u16,
        cdp_port: u16,
        token: String,
    ) {
        self.daemon_port = Some(daemon_port);
        self.cdp_port = Some(cdp_port);
        self.token = Some(token);
    }

    /// Middle-click on the tray icon: toggle the daemon start/stop.
    ///
    /// Returns the `SupervisorAction` (or `None` if the current state is
    /// transient and no toggle makes sense — e.g. mid-start).
    pub fn toggle(&mut self) -> Option<SupervisorAction> {
        let event = match self.supervisor.state() {
            // Quiescent states → start.
            DaemonState::Stopped
            | DaemonState::FailedToStart
            | DaemonState::GaveUp => Event::UserStart,
            // Active states → stop.
            DaemonState::Running | DaemonState::Starting => Event::UserStop,
        };
        Some(self.handle_event(event))
    }

    // ----- Menu rendering helpers (used by the Tauri shell) -----

    /// True when the daemon is `Running` or `Starting` — i.e. the user
    /// can't issue another start.
    pub fn is_active(&self) -> bool {
        matches!(
            self.supervisor.state(),
            DaemonState::Running | DaemonState::Starting
        )
    }

    /// Label for the start/stop toggle menu item.
    pub fn toggle_label(&self) -> &'static str {
        if self.is_active() {
            "停止 daemon"
        } else {
            "启动 daemon"
        }
    }

    /// Text for the status row that sits at the top of the right-click
    /// menu (greyed-out, non-clickable).
    ///
    /// Format: `状态: {status_text}[· :{port}]`. Port is only included
    /// when the daemon is active (we don't expose a "remembered" port
    /// once the daemon is down — that would be misleading).
    pub fn status_row(&self) -> String {
        let snap = self.snapshot();
        match self.daemon_port {
            Some(p) if self.is_active() => format!("状态: {} · :{}", snap.status_text, p),
            _ => format!("状态: {}", snap.status_text),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray_state::TrayColor;

    #[test]
    fn new_controller_is_red_stopped() {
        let c = TrayController::new();
        assert_eq!(c.daemon_state(), DaemonState::Stopped);

        let snap = c.snapshot();
        assert_eq!(snap.color, TrayColor::Red);
        assert_eq!(snap.status_text, "未运行");
        assert_eq!(snap.tooltip, "bb-browser · 未运行");
    }

    #[test]
    fn middle_click_from_stopped_starts_daemon() {
        let mut c = TrayController::new();
        let action = c.toggle().expect("toggle returns an action");

        // Should now be Starting and ask caller to spawn.
        assert_eq!(c.daemon_state(), DaemonState::Starting);
        assert_eq!(
            action,
            SupervisorAction::Spawn {
                restart_count: None
            }
        );

        // Visual flips to yellow ("重连中") immediately.
        let snap = c.snapshot();
        assert_eq!(snap.color, TrayColor::Yellow);
    }

    #[test]
    fn middle_click_from_running_stops_daemon() {
        let mut c = TrayController::new();
        c.toggle(); // Stopped → Starting
        c.handle_event(Event::DaemonReady); // Starting → Running
        c.set_cdp_state(CdpState::Connected);
        c.set_daemon_port(Some(19826));

        assert_eq!(c.daemon_state(), DaemonState::Running);
        assert_eq!(c.snapshot().color, TrayColor::Green);

        c.toggle(); // Running → Stopped

        assert_eq!(c.daemon_state(), DaemonState::Stopped);
        let snap = c.snapshot();
        assert_eq!(snap.color, TrayColor::Red);
    }

    #[test]
    fn ready_event_flips_to_green_when_cdp_connected() {
        let mut c = TrayController::new();
        c.set_cdp_state(CdpState::Connected);
        c.set_daemon_port(Some(19826));
        c.toggle();
        c.handle_event(Event::DaemonReady);

        let snap = c.snapshot();
        assert_eq!(c.daemon_state(), DaemonState::Running);
        assert_eq!(snap.color, TrayColor::Green);
        assert_eq!(snap.tooltip, "bb-browser · 已连接 · :19826");
    }

    #[test]
    fn cdp_drop_during_running_flips_to_yellow() {
        let mut c = TrayController::new();
        c.toggle();
        c.handle_event(Event::DaemonReady);
        c.set_cdp_state(CdpState::Connected);
        c.set_daemon_port(Some(19826));
        assert_eq!(c.snapshot().color, TrayColor::Green);

        // Chrome disconnects, we're inside the 30s reconnect window.
        c.set_cdp_state(CdpState::Reconnecting);
        let snap = c.snapshot();
        assert_eq!(snap.color, TrayColor::Yellow);
        assert_eq!(snap.tooltip, "bb-browser · 重连中 · :19826");
    }

    #[test]
    fn daemon_crash_during_running_triggers_restart() {
        let mut c = TrayController::new();
        c.toggle();
        c.handle_event(Event::DaemonReady);
        c.set_cdp_state(CdpState::Connected);
        c.set_daemon_port(Some(19826));

        // Crash.
        let action = c.handle_event(Event::DaemonExited {
            now_ms: 0,
            during_startup: false,
        });

        // Should immediately re-enter Starting + ask caller to respawn.
        assert_eq!(c.daemon_state(), DaemonState::Starting);
        assert_eq!(
            action,
            SupervisorAction::Spawn {
                restart_count: Some(1)
            }
        );
        // Icon goes yellow (mid-restart).
        assert_eq!(c.snapshot().color, TrayColor::Yellow);
    }

    #[test]
    fn toggle_from_gave_up_restarts() {
        let mut c = TrayController::new();
        c.toggle();
        // Simulate 3 crashes.
        c.handle_event(Event::DaemonReady);
        c.handle_event(Event::DaemonExited {
            now_ms: 0,
            during_startup: false,
        });
        c.handle_event(Event::DaemonReady);
        c.handle_event(Event::DaemonExited {
            now_ms: 1_000,
            during_startup: false,
        });
        c.handle_event(Event::DaemonReady);
        c.handle_event(Event::DaemonExited {
            now_ms: 2_000,
            during_startup: false,
        });
        assert_eq!(c.daemon_state(), DaemonState::GaveUp);
        assert_eq!(c.snapshot().color, TrayColor::Red);

        // User middle-clicks → should reset and try again.
        let action = c.toggle();
        assert_eq!(c.daemon_state(), DaemonState::Starting);
        assert_eq!(
            action,
            Some(SupervisorAction::Spawn {
                restart_count: None
            })
        );
    }

    #[test]
    fn toggle_label_reflects_state() {
        let mut c = TrayController::new();
        assert_eq!(c.toggle_label(), "启动 daemon");
        assert!(!c.is_active());

        c.handle_event(Event::UserStart);
        assert_eq!(c.toggle_label(), "停止 daemon");
        assert!(c.is_active());

        c.handle_event(Event::DaemonReady);
        assert_eq!(c.toggle_label(), "停止 daemon"); // still active
        assert!(c.is_active());

        c.handle_event(Event::UserStop);
        assert_eq!(c.toggle_label(), "启动 daemon");
        assert!(!c.is_active());
    }

    #[test]
    fn status_row_includes_port_only_when_active() {
        let mut c = TrayController::new();
        c.set_daemon_port(Some(19826));
        // Stopped: port suppressed even though we set it.
        assert_eq!(c.status_row(), "状态: 未运行");

        c.handle_event(Event::UserStart);
        // Starting + port → port shown.
        assert_eq!(c.status_row(), "状态: 重连中 · :19826");

        c.handle_event(Event::DaemonReady);
        c.set_cdp_state(CdpState::Connected);
        assert_eq!(c.status_row(), "状态: 已连接 · :19826");

        c.handle_event(Event::UserStop);
        // Stopped again, port suppressed.
        assert_eq!(c.status_row(), "状态: 未运行");
    }

    #[test]
    fn status_row_works_without_port() {
        let mut c = TrayController::new();
        assert_eq!(c.status_row(), "状态: 未运行");

        // Active but no port yet.
        c.handle_event(Event::UserStart);
        assert_eq!(c.status_row(), "状态: 重连中");
    }

    #[test]
    fn identity_setters_round_trip_when_active() {
        let mut c = TrayController::new();
        // When stopped, getters return None even if backing values are set.
        c.set_daemon_port(Some(19826));
        c.set_cdp_port(Some(19827));
        c.set_token(Some("abc".into()));
        assert_eq!(c.daemon_port_value(), None);
        assert_eq!(c.cdp_port_value(), None);
        assert_eq!(c.token_value(), None);

        // Once active, getters reveal them.
        c.handle_event(Event::UserStart);
        c.handle_event(Event::DaemonReady);
        assert_eq!(c.daemon_port_value(), Some(19826));
        assert_eq!(c.cdp_port_value(), Some(19827));
        assert_eq!(c.token_value(), Some("abc".into()));
    }

    #[test]
    fn set_daemon_identity_writes_all_three() {
        let mut c = TrayController::new();
        c.handle_event(Event::UserStart);
        c.handle_event(Event::DaemonReady);
        c.set_daemon_identity(19828, 19829, "xyz".into());
        assert_eq!(c.daemon_port_value(), Some(19828));
        assert_eq!(c.cdp_port_value(), Some(19829));
        assert_eq!(c.token_value(), Some("xyz".into()));
    }

    #[test]
    fn set_daemon_port_updates_tooltip() {
        let mut c = TrayController::new();
        c.toggle();
        c.handle_event(Event::DaemonReady);
        c.set_cdp_state(CdpState::Connected);

        // No port yet: tooltip omits it.
        c.set_daemon_port(None);
        assert_eq!(c.snapshot().tooltip, "bb-browser · 已连接");

        // Port arrives.
        c.set_daemon_port(Some(19828));
        assert_eq!(c.snapshot().tooltip, "bb-browser · 已连接 · :19828");
    }
}
