//! Supervisor state machine for the daemon subprocess.
//!
//! Models the lifecycle of the bb-browser daemon as observed by the tray
//! app:
//!
//! ```text
//!         start()            ready
//! Stopped ───────► Starting ───────► Running ─┐
//!    ▲                │                       │ subprocess exits
//!    │ user stop      │ start() fails         ▼
//!    │                ▼                    Crashed
//!    │            FailedToStart               │
//!    │                                        │ policy: Restart
//!    │ policy: GiveUp                         ▼
//!    └─────────────────────────────────── Restarting
//! ```
//!
//! The supervisor is intentionally a pure state machine. It does not
//! spawn processes itself — it tells the caller what to do via
//! [`SupervisorAction`].
//!
//! See docs/system-tray-design.md §9.2.

use crate::restart_policy::{RestartDecision, RestartPolicy};

/// Lifecycle state of the daemon as the tray app sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonState {
    /// User has not asked us to run, or has stopped us.
    Stopped,
    /// We've spawned the subprocess but haven't seen the ready signal yet.
    /// Both the initial start and post-crash restarts pass through here.
    Starting,
    /// Daemon is up and responding to heartbeats.
    Running,
    /// Subprocess exited and the restart policy refused to retry.
    GaveUp,
    /// Subprocess never reached `Running` (e.g. port binding failed).
    FailedToStart,
}

/// Side-effect the caller should perform in response to a state transition.
#[derive(Debug, PartialEq, Eq)]
pub enum SupervisorAction {
    /// Spawn the daemon subprocess. If `restart_count` is `Some(n)`, this is
    /// an auto-restart after crash and the caller should also surface a
    /// toast like "daemon auto-restarted (n-th time)".
    Spawn { restart_count: Option<usize> },
    /// Do nothing right now (waiting for an event).
    Wait,
    /// Surface a toast/log that we've stopped trying.
    NotifyGaveUp { crash_count: usize },
}

/// Events the caller feeds into the supervisor.
#[derive(Debug)]
pub enum Event {
    /// User clicked "Start daemon".
    UserStart,
    /// User clicked "Stop daemon".
    UserStop,
    /// The subprocess emitted its ready signal (e.g. logged its port).
    DaemonReady,
    /// The subprocess exited. `now_ms` is the timestamp for the restart
    /// policy. `during_startup` is true if we never reached Running.
    DaemonExited { now_ms: u128, during_startup: bool },
    /// User explicitly clicked "Restart daemon" — clears the crash budget.
    UserRestart,
}

pub struct Supervisor {
    state: DaemonState,
    policy: RestartPolicy,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new(RestartPolicy::default())
    }
}

impl Supervisor {
    pub fn new(policy: RestartPolicy) -> Self {
        Self {
            state: DaemonState::Stopped,
            policy,
        }
    }

    pub fn state(&self) -> DaemonState {
        self.state
    }

    /// Feed an event and get back the side-effect the caller should perform.
    pub fn handle(&mut self, event: Event) -> SupervisorAction {
        match (self.state, event) {
            // ---- Stopped ----
            (DaemonState::Stopped, Event::UserStart) => {
                self.state = DaemonState::Starting;
                SupervisorAction::Spawn { restart_count: None }
            }
            (DaemonState::Stopped, _) => SupervisorAction::Wait,

            // ---- Starting ----
            (DaemonState::Starting, Event::DaemonReady) => {
                self.state = DaemonState::Running;
                SupervisorAction::Wait
            }
            (DaemonState::Starting, Event::DaemonExited { .. }) => {
                // Crashed before ever reaching Running. Don't burn the
                // restart budget — user probably mis-configured something
                // (bad port, missing Node, etc.). Bail to FailedToStart.
                self.state = DaemonState::FailedToStart;
                SupervisorAction::Wait
            }
            (DaemonState::Starting, Event::UserStop) => {
                self.state = DaemonState::Stopped;
                SupervisorAction::Wait
            }
            (DaemonState::Starting, _) => SupervisorAction::Wait,

            // ---- Running ----
            (DaemonState::Running, Event::DaemonExited { now_ms, .. }) => {
                match self.policy.on_crash(now_ms) {
                    RestartDecision::Restart { count_in_window } => {
                        // Combined transition: skip an explicit "Restarting"
                        // resting state and go straight back to Starting +
                        // Spawn. The restart_count carries the toast info.
                        self.state = DaemonState::Starting;
                        SupervisorAction::Spawn {
                            restart_count: Some(count_in_window),
                        }
                    }
                    RestartDecision::GiveUp { crash_count, .. } => {
                        self.state = DaemonState::GaveUp;
                        SupervisorAction::NotifyGaveUp { crash_count }
                    }
                }
            }
            (DaemonState::Running, Event::UserStop) => {
                self.state = DaemonState::Stopped;
                SupervisorAction::Wait
            }
            (DaemonState::Running, _) => SupervisorAction::Wait,

            // ---- GaveUp / FailedToStart ----
            (DaemonState::GaveUp | DaemonState::FailedToStart, Event::UserStart)
            | (DaemonState::GaveUp | DaemonState::FailedToStart, Event::UserRestart) => {
                // User intervened — clear policy and try again.
                self.policy.reset();
                self.state = DaemonState::Starting;
                SupervisorAction::Spawn { restart_count: None }
            }
            (DaemonState::GaveUp | DaemonState::FailedToStart, _) => SupervisorAction::Wait,
        }
    }

    /// For introspection / debug UIs.
    pub fn crash_count(&self) -> usize {
        self.policy.current_count()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Supervisor {
        Supervisor::default()
    }

    #[test]
    fn initial_state_is_stopped() {
        let sup = fresh();
        assert_eq!(sup.state(), DaemonState::Stopped);
    }

    #[test]
    fn user_start_from_stopped_spawns_and_goes_to_starting() {
        let mut sup = fresh();
        let action = sup.handle(Event::UserStart);
        assert_eq!(
            action,
            SupervisorAction::Spawn {
                restart_count: None
            }
        );
        assert_eq!(sup.state(), DaemonState::Starting);
    }

    #[test]
    fn daemon_ready_from_starting_goes_to_running() {
        let mut sup = fresh();
        sup.handle(Event::UserStart);
        let action = sup.handle(Event::DaemonReady);
        assert_eq!(action, SupervisorAction::Wait);
        assert_eq!(sup.state(), DaemonState::Running);
    }

    #[test]
    fn user_stop_from_running_goes_to_stopped() {
        let mut sup = fresh();
        sup.handle(Event::UserStart);
        sup.handle(Event::DaemonReady);
        let action = sup.handle(Event::UserStop);
        assert_eq!(action, SupervisorAction::Wait);
        assert_eq!(sup.state(), DaemonState::Stopped);
    }

    #[test]
    fn first_crash_triggers_restart() {
        let mut sup = fresh();
        sup.handle(Event::UserStart);
        sup.handle(Event::DaemonReady);

        let action = sup.handle(Event::DaemonExited {
            now_ms: 0,
            during_startup: false,
        });
        assert_eq!(
            action,
            SupervisorAction::Spawn {
                restart_count: Some(1)
            }
        );
        // After a crash we go straight back to Starting and the caller
        // should immediately re-spawn — no idle "Restarting" state.
        assert_eq!(sup.state(), DaemonState::Starting);
    }

    #[test]
    fn third_crash_triggers_give_up() {
        let mut sup = fresh();
        // Crash 1.
        sup.handle(Event::UserStart);
        sup.handle(Event::DaemonReady);
        let a1 = sup.handle(Event::DaemonExited {
            now_ms: 0,
            during_startup: false,
        });
        assert!(matches!(a1, SupervisorAction::Spawn { .. }));

        // Crash 2.
        sup.handle(Event::DaemonReady);
        let a2 = sup.handle(Event::DaemonExited {
            now_ms: 1_000,
            during_startup: false,
        });
        assert!(matches!(a2, SupervisorAction::Spawn { .. }));

        // Crash 3 — policy gives up.
        sup.handle(Event::DaemonReady);
        let action = sup.handle(Event::DaemonExited {
            now_ms: 2_000,
            during_startup: false,
        });
        match action {
            SupervisorAction::NotifyGaveUp { crash_count } => assert_eq!(crash_count, 3),
            other => panic!("expected NotifyGaveUp, got {other:?}"),
        }
        assert_eq!(sup.state(), DaemonState::GaveUp);
    }

    #[test]
    fn user_restart_after_give_up_clears_history() {
        let mut sup = fresh();
        // Drive to GaveUp.
        sup.handle(Event::UserStart);
        sup.handle(Event::DaemonReady);
        sup.handle(Event::DaemonExited {
            now_ms: 0,
            during_startup: false,
        });
        sup.handle(Event::DaemonReady);
        sup.handle(Event::DaemonExited {
            now_ms: 1_000,
            during_startup: false,
        });
        sup.handle(Event::DaemonReady);
        sup.handle(Event::DaemonExited {
            now_ms: 2_000,
            during_startup: false,
        });
        assert_eq!(sup.state(), DaemonState::GaveUp);

        let action = sup.handle(Event::UserRestart);
        assert_eq!(
            action,
            SupervisorAction::Spawn {
                restart_count: None
            }
        );
        assert_eq!(sup.state(), DaemonState::Starting);
        assert_eq!(sup.crash_count(), 0);
    }

    #[test]
    fn crash_during_startup_does_not_burn_budget() {
        let mut sup = fresh();
        sup.handle(Event::UserStart);
        // Exit before ever reaching Running.
        let action = sup.handle(Event::DaemonExited {
            now_ms: 0,
            during_startup: true,
        });
        assert_eq!(action, SupervisorAction::Wait);
        assert_eq!(sup.state(), DaemonState::FailedToStart);
        // Crash budget untouched.
        assert_eq!(sup.crash_count(), 0);
    }

    #[test]
    fn failed_to_start_recoverable_via_user_start() {
        let mut sup = fresh();
        sup.handle(Event::UserStart);
        sup.handle(Event::DaemonExited {
            now_ms: 0,
            during_startup: true,
        });
        assert_eq!(sup.state(), DaemonState::FailedToStart);

        let action = sup.handle(Event::UserStart);
        assert_eq!(
            action,
            SupervisorAction::Spawn {
                restart_count: None
            }
        );
        assert_eq!(sup.state(), DaemonState::Starting);
    }

    #[test]
    fn stopped_ignores_daemon_events() {
        let mut sup = fresh();
        let action = sup.handle(Event::DaemonReady);
        assert_eq!(action, SupervisorAction::Wait);
        assert_eq!(sup.state(), DaemonState::Stopped);
    }

    #[test]
    fn user_stop_while_starting_aborts_to_stopped() {
        let mut sup = fresh();
        sup.handle(Event::UserStart);
        let action = sup.handle(Event::UserStop);
        assert_eq!(action, SupervisorAction::Wait);
        assert_eq!(sup.state(), DaemonState::Stopped);
    }
}
