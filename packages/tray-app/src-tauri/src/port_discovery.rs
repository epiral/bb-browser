//! Port discovery for bb-browser daemon.
//!
//! Two independent port chains:
//!  - daemon HTTP: 19824, 19826, 19828, ... (even)
//!  - CDP debug:   19825, 19827, 19829, ... (odd)
//!
//! See docs/system-tray-design.md §8.1.

use std::net::{TcpListener, SocketAddr};

/// Default starting ports per the design spec.
pub const DEFAULT_DAEMON_PORT: u16 = 19824;
pub const DEFAULT_CDP_PORT: u16 = 19825;

/// Maximum scan distance before giving up (256 ports = 128 attempts per chain).
pub const MAX_SCAN_RANGE: u16 = 256;

/// Result of a successful dual-port allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortPair {
    pub daemon: u16,
    pub cdp: u16,
}

/// Errors that can occur during port discovery.
#[derive(Debug, PartialEq, Eq)]
pub enum DiscoveryError {
    /// Could not find an available port in the configured scan range.
    NoPortAvailable {
        chain: &'static str,
        scanned_from: u16,
        scanned_to: u16,
    },
    /// Caller requested a starting port with wrong parity.
    InvalidParity {
        port: u16,
        expected: &'static str,
    },
}

/// Trait abstracting "is this port free?" so tests can supply a deterministic mock.
pub trait PortChecker {
    fn is_available(&self, port: u16) -> bool;
}

/// Production implementation that attempts to bind a TCP listener.
pub struct OsPortChecker;

impl PortChecker for OsPortChecker {
    fn is_available(&self, port: u16) -> bool {
        let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
            Ok(a) => a,
            Err(_) => return false,
        };
        TcpListener::bind(addr).is_ok()
    }
}

/// Walk an even chain (e.g. 19824, 19826, ...) and return the first free port.
pub fn find_even_port<C: PortChecker>(
    checker: &C,
    start: u16,
) -> Result<u16, DiscoveryError> {
    if start % 2 != 0 {
        return Err(DiscoveryError::InvalidParity {
            port: start,
            expected: "even",
        });
    }
    find_port_with_stride(checker, start, 2, "daemon")
}

/// Walk an odd chain (e.g. 19825, 19827, ...) and return the first free port.
pub fn find_odd_port<C: PortChecker>(
    checker: &C,
    start: u16,
) -> Result<u16, DiscoveryError> {
    if start % 2 == 0 {
        return Err(DiscoveryError::InvalidParity {
            port: start,
            expected: "odd",
        });
    }
    find_port_with_stride(checker, start, 2, "cdp")
}

fn find_port_with_stride<C: PortChecker>(
    checker: &C,
    start: u16,
    stride: u16,
    chain: &'static str,
) -> Result<u16, DiscoveryError> {
    let mut port = start;
    let end = start.saturating_add(MAX_SCAN_RANGE);
    while port < end {
        if checker.is_available(port) {
            return Ok(port);
        }
        port = match port.checked_add(stride) {
            Some(p) => p,
            None => break,
        };
    }
    Err(DiscoveryError::NoPortAvailable {
        chain,
        scanned_from: start,
        scanned_to: end.saturating_sub(stride),
    })
}

/// Discover the dual-port pair (daemon HTTP + CDP debug) in one call.
///
/// The two chains are independent — they may end up at different offsets
/// from the defaults (e.g. daemon=19828, cdp=19827).
pub fn discover_pair<C: PortChecker>(
    checker: &C,
    daemon_start: u16,
    cdp_start: u16,
) -> Result<PortPair, DiscoveryError> {
    let daemon = find_even_port(checker, daemon_start)?;
    let cdp = find_odd_port(checker, cdp_start)?;
    Ok(PortPair { daemon, cdp })
}

/// Convenience wrapper using the OS-bound checker and default ports.
pub fn discover_default() -> Result<PortPair, DiscoveryError> {
    discover_pair(&OsPortChecker, DEFAULT_DAEMON_PORT, DEFAULT_CDP_PORT)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Deterministic mock — treats given ports as occupied.
    struct MockChecker {
        occupied: HashSet<u16>,
    }

    impl MockChecker {
        fn new(occupied: &[u16]) -> Self {
            Self {
                occupied: occupied.iter().copied().collect(),
            }
        }
    }

    impl PortChecker for MockChecker {
        fn is_available(&self, port: u16) -> bool {
            !self.occupied.contains(&port)
        }
    }

    // ---- find_even_port ----

    #[test]
    fn even_port_returns_default_when_free() {
        let checker = MockChecker::new(&[]);
        let port = find_even_port(&checker, 19824).unwrap();
        assert_eq!(port, 19824);
    }

    #[test]
    fn even_port_skips_to_next_when_default_is_occupied() {
        let checker = MockChecker::new(&[19824]);
        let port = find_even_port(&checker, 19824).unwrap();
        assert_eq!(port, 19826);
    }

    #[test]
    fn even_port_keeps_stride_of_two() {
        // Default + the next two evens occupied; should land on 19830.
        let checker = MockChecker::new(&[19824, 19826, 19828]);
        let port = find_even_port(&checker, 19824).unwrap();
        assert_eq!(port, 19830);
    }

    #[test]
    fn even_port_does_not_visit_odd_ports() {
        // 19825 is "occupied" but we should never check it because we only
        // walk evens.
        let checker = MockChecker::new(&[19824, 19825]);
        let port = find_even_port(&checker, 19824).unwrap();
        assert_eq!(port, 19826);
    }

    #[test]
    fn even_port_rejects_odd_start() {
        let checker = MockChecker::new(&[]);
        let err = find_even_port(&checker, 19825).unwrap_err();
        assert_eq!(
            err,
            DiscoveryError::InvalidParity {
                port: 19825,
                expected: "even",
            }
        );
    }

    // ---- find_odd_port ----

    #[test]
    fn odd_port_returns_default_when_free() {
        let checker = MockChecker::new(&[]);
        let port = find_odd_port(&checker, 19825).unwrap();
        assert_eq!(port, 19825);
    }

    #[test]
    fn odd_port_skips_to_next_when_default_is_occupied() {
        let checker = MockChecker::new(&[19825]);
        let port = find_odd_port(&checker, 19825).unwrap();
        assert_eq!(port, 19827);
    }

    #[test]
    fn odd_port_rejects_even_start() {
        let checker = MockChecker::new(&[]);
        let err = find_odd_port(&checker, 19824).unwrap_err();
        assert_eq!(
            err,
            DiscoveryError::InvalidParity {
                port: 19824,
                expected: "odd",
            }
        );
    }

    // ---- discover_pair ----

    #[test]
    fn pair_uses_defaults_when_both_free() {
        let checker = MockChecker::new(&[]);
        let pair = discover_pair(&checker, 19824, 19825).unwrap();
        assert_eq!(
            pair,
            PortPair {
                daemon: 19824,
                cdp: 19825
            }
        );
    }

    #[test]
    fn pair_resolves_chains_independently() {
        // Daemon's first slot is occupied, CDP's first slot is free.
        // Chains advance independently; no "lockstep" coupling.
        let checker = MockChecker::new(&[19824]);
        let pair = discover_pair(&checker, 19824, 19825).unwrap();
        assert_eq!(pair.daemon, 19826);
        assert_eq!(pair.cdp, 19825);
    }

    #[test]
    fn pair_handles_both_chains_blocked() {
        let checker = MockChecker::new(&[19824, 19826, 19825, 19827]);
        let pair = discover_pair(&checker, 19824, 19825).unwrap();
        assert_eq!(pair.daemon, 19828);
        assert_eq!(pair.cdp, 19829);
    }

    // ---- exhaustion ----

    #[test]
    fn returns_error_when_entire_range_is_occupied() {
        // Occupy every even port from 19824 up to the scan limit.
        let occupied: Vec<u16> = (19824..(19824 + MAX_SCAN_RANGE))
            .filter(|p| p % 2 == 0)
            .collect();
        let checker = MockChecker::new(&occupied);
        let err = find_even_port(&checker, 19824).unwrap_err();
        match err {
            DiscoveryError::NoPortAvailable { chain, .. } => {
                assert_eq!(chain, "daemon");
            }
            _ => panic!("expected NoPortAvailable, got {err:?}"),
        }
    }

    #[test]
    fn handles_near_u16_overflow_gracefully() {
        // Starting close to u16::MAX should not panic.
        let checker = MockChecker::new(&[]);
        let port = find_even_port(&checker, 65534).unwrap();
        assert_eq!(port, 65534);
    }
}
