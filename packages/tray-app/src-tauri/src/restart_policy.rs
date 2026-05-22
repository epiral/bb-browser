//! Self-healing restart policy.
//!
//! Per docs/system-tray-design.md §9.1:
//!  - On daemon crash, restart immediately.
//!  - If 3 crashes occur within a 5-minute sliding window, stop restarting
//!    and surface a Toast to the user.
//!
//! The policy is **time-source-agnostic**: callers pass in the current time
//! when reporting a crash. This makes the logic deterministic in tests.

use std::collections::VecDeque;
use std::time::Duration;

/// Default sliding window for failure counting.
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(300); // 5 minutes

/// Default crash count limit within the window.
pub const DEFAULT_MAX_CRASHES: usize = 3;

/// Decision returned by [`RestartPolicy::on_crash`].
#[derive(Debug, PartialEq, Eq)]
pub enum RestartDecision {
    /// Restart the daemon. Carries the 1-based crash count in the current
    /// window so the caller can surface "auto-restarted (2nd time)".
    Restart { count_in_window: usize },
    /// Crash budget exhausted. Do not restart; notify the user.
    GiveUp {
        crash_count: usize,
        window: Duration,
    },
}

/// Sliding-window crash counter.
///
/// `Instant` is intentionally not used so the policy can be tested with a
/// fake clock. Callers pass in any monotonic timestamp (milliseconds since
/// some epoch is fine).
#[derive(Debug)]
pub struct RestartPolicy {
    window: Duration,
    max_crashes: usize,
    crash_times_ms: VecDeque<u128>,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self::new(DEFAULT_WINDOW, DEFAULT_MAX_CRASHES)
    }
}

impl RestartPolicy {
    pub fn new(window: Duration, max_crashes: usize) -> Self {
        assert!(max_crashes >= 1, "max_crashes must be >= 1");
        Self {
            window,
            max_crashes,
            crash_times_ms: VecDeque::new(),
        }
    }

    /// Report a crash at `now_ms` (monotonic milliseconds).
    ///
    /// Returns the action the supervisor should take.
    pub fn on_crash(&mut self, now_ms: u128) -> RestartDecision {
        self.evict_older_than(now_ms);
        self.crash_times_ms.push_back(now_ms);

        if self.crash_times_ms.len() >= self.max_crashes {
            RestartDecision::GiveUp {
                crash_count: self.crash_times_ms.len(),
                window: self.window,
            }
        } else {
            RestartDecision::Restart {
                count_in_window: self.crash_times_ms.len(),
            }
        }
    }

    /// Manually clear the crash history — e.g. after a long stretch of
    /// healthy uptime or when the user explicitly clicks "Restart daemon"
    /// from the tray.
    pub fn reset(&mut self) {
        self.crash_times_ms.clear();
    }

    /// Current count of crashes still within the window. Useful for the
    /// "auto-restarted (2nd time)" toast text.
    pub fn current_count(&self) -> usize {
        self.crash_times_ms.len()
    }

    fn evict_older_than(&mut self, now_ms: u128) {
        let window_ms = self.window.as_millis();
        let cutoff = now_ms.saturating_sub(window_ms);
        while let Some(&front) = self.crash_times_ms.front() {
            if front < cutoff {
                self.crash_times_ms.pop_front();
            } else {
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const ONE_SEC: u128 = 1_000;
    const FIVE_MIN: u128 = 5 * 60 * 1_000;

    #[test]
    fn first_crash_triggers_restart() {
        let mut policy = RestartPolicy::default();
        let decision = policy.on_crash(0);
        assert_eq!(decision, RestartDecision::Restart { count_in_window: 1 });
    }

    #[test]
    fn second_crash_in_window_still_restarts() {
        let mut policy = RestartPolicy::default();
        policy.on_crash(0);
        let decision = policy.on_crash(ONE_SEC);
        assert_eq!(decision, RestartDecision::Restart { count_in_window: 2 });
    }

    #[test]
    fn third_crash_in_window_gives_up() {
        let mut policy = RestartPolicy::default();
        policy.on_crash(0);
        policy.on_crash(ONE_SEC);
        let decision = policy.on_crash(2 * ONE_SEC);
        assert_eq!(
            decision,
            RestartDecision::GiveUp {
                crash_count: 3,
                window: DEFAULT_WINDOW,
            }
        );
    }

    #[test]
    fn crashes_outside_window_are_evicted() {
        let mut policy = RestartPolicy::default();
        // Crash at t=0.
        policy.on_crash(0);
        // Two more crashes JUST inside the window — should still get GiveUp.
        let decision = policy.on_crash(FIVE_MIN - 1);
        assert_eq!(decision, RestartDecision::Restart { count_in_window: 2 });

        // A crash AFTER the window passes — the t=0 crash should be evicted.
        let decision = policy.on_crash(FIVE_MIN + 1);
        // Now we have crashes at (FIVE_MIN - 1) and (FIVE_MIN + 1); the t=0
        // one is gone. Still a Restart.
        assert_eq!(decision, RestartDecision::Restart { count_in_window: 2 });
    }

    #[test]
    fn crashes_long_after_window_reset_counter() {
        let mut policy = RestartPolicy::default();
        policy.on_crash(0);
        policy.on_crash(ONE_SEC);
        // Wait far longer than the window.
        let decision = policy.on_crash(10 * FIVE_MIN);
        // Both prior crashes are evicted; this counts as the first crash.
        assert_eq!(decision, RestartDecision::Restart { count_in_window: 1 });
    }

    #[test]
    fn reset_clears_history() {
        let mut policy = RestartPolicy::default();
        policy.on_crash(0);
        policy.on_crash(ONE_SEC);
        assert_eq!(policy.current_count(), 2);

        policy.reset();
        assert_eq!(policy.current_count(), 0);

        let decision = policy.on_crash(2 * ONE_SEC);
        assert_eq!(decision, RestartDecision::Restart { count_in_window: 1 });
    }

    #[test]
    fn custom_limits_respected() {
        let mut policy = RestartPolicy::new(Duration::from_secs(60), 2);
        policy.on_crash(0);
        let decision = policy.on_crash(ONE_SEC);
        assert_eq!(
            decision,
            RestartDecision::GiveUp {
                crash_count: 2,
                window: Duration::from_secs(60),
            }
        );
    }

    #[test]
    fn current_count_reflects_window() {
        let mut policy = RestartPolicy::default();
        policy.on_crash(0);
        policy.on_crash(ONE_SEC);
        assert_eq!(policy.current_count(), 2);

        // A crash long after the window evicts BOTH older entries
        // (cutoff = 100*FIVE_MIN - FIVE_MIN, well past ONE_SEC).
        let _ = policy.on_crash(100 * FIVE_MIN);
        assert_eq!(policy.current_count(), 1);
    }

    #[test]
    #[should_panic]
    fn zero_max_crashes_panics() {
        let _ = RestartPolicy::new(DEFAULT_WINDOW, 0);
    }
}
