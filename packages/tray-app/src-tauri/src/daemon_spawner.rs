//! Spawn and supervise the bb-browser daemon as a Node subprocess.
//!
//! The daemon writes a single READY line to stdout in the form
//! `BB_DAEMON_READY {"daemonPort":N,"cdpPort":M,"token":"..."}` after it
//! has finished port discovery and is accepting requests. We parse that
//! line to learn its concrete configuration.
//!
//! Phase 1 keeps this layer deliberately narrow:
//!  - spawn a configurable command (so tests can substitute a fake Node)
//!  - read stdout line-by-line until we see READY or the process exits
//!  - expose a way to kill the subprocess
//!
//! See docs/system-tray-design.md §6 / §9.

use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

/// Default ready prefix. Daemon prints `BB_DAEMON_READY <json>\n`.
pub const READY_PREFIX: &str = "BB_DAEMON_READY ";

/// Default timeout for the daemon to emit its READY line.
pub const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Parsed payload of the READY line.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadyInfo {
    pub daemon_port: u16,
    pub cdp_port: u16,
    pub token: String,
}

/// Configuration for spawning the daemon.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// The executable to invoke. In production this is `node`; in tests it
    /// can be anything that produces a READY line on stdout.
    pub program: PathBuf,
    /// Arguments passed to `program`.
    pub args: Vec<String>,
    /// Working directory for the child. None → inherit.
    pub cwd: Option<PathBuf>,
    /// Environment variables to set on the child.
    pub env: Vec<(String, String)>,
    /// How long to wait for the READY line before declaring startup
    /// failure.
    pub ready_timeout: Duration,
}

impl SpawnConfig {
    /// Sensible default for production: `node packages/daemon/dist/index.js`.
    pub fn for_node_daemon(node: PathBuf, daemon_entry: PathBuf) -> Self {
        Self {
            program: node,
            args: vec![daemon_entry.to_string_lossy().into_owned()],
            cwd: None,
            env: Vec::new(),
            ready_timeout: DEFAULT_READY_TIMEOUT,
        }
    }
}

/// Outcome of waiting for the daemon to start.
#[derive(Debug)]
pub enum SpawnOutcome {
    /// Daemon emitted READY and is alive.
    Ready(ReadyInfo),
    /// Subprocess exited before we saw READY.
    ExitedEarly { exit_code: Option<i32> },
    /// `ready_timeout` elapsed without READY or exit.
    Timeout,
    /// READY line was emitted but had a malformed payload.
    MalformedReady { line: String, error: String },
}

/// A running daemon subprocess.
pub struct DaemonProcess {
    child: Child,
    /// Channel that yields parsed stdout events.
    rx: Option<Receiver<StdoutEvent>>,
}

#[derive(Debug)]
enum StdoutEvent {
    Ready(Result<ReadyInfo, (String, String)>),
    Closed,
}

impl DaemonProcess {
    /// Spawn the subprocess and start reading its stdout.
    pub fn spawn(cfg: &SpawnConfig) -> std::io::Result<Self> {
        let mut command = Command::new(&cfg.program);
        command.args(&cfg.args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
        if let Some(cwd) = &cfg.cwd {
            command.current_dir(cwd);
        }
        for (k, v) in &cfg.env {
            command.env(k, v);
        }
        // On Windows, the tray binary is a GUI app (no console). Spawning
        // `node` would otherwise pop a visible console window ("黑框") on the
        // desktop/taskbar. CREATE_NO_WINDOW (0x0800_0000) suppresses it; we
        // still capture stdout/stderr via the piped handles above.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                // Tolerate a leading prefix (e.g. the daemon's log
                // interceptor prepends "[Daemon] ") by locating the marker
                // anywhere in the line rather than only at the start.
                if let Some(pos) = line.find(READY_PREFIX) {
                    let rest = &line[pos + READY_PREFIX.len()..];
                    let event = match serde_json::from_str::<ReadyInfo>(rest) {
                        Ok(info) => StdoutEvent::Ready(Ok(info)),
                        Err(e) => StdoutEvent::Ready(Err((line.clone(), e.to_string()))),
                    };
                    let _ = tx.send(event);
                    // Continue draining to keep the pipe from filling up.
                }
            }
            let _ = tx.send(StdoutEvent::Closed);
        });

        Ok(Self {
            child,
            rx: Some(rx),
        })
    }

    /// Block (up to `ready_timeout`) waiting for READY or early exit.
    pub fn wait_for_ready(&mut self, ready_timeout: Duration) -> SpawnOutcome {
        let rx = match self.rx.as_ref() {
            Some(r) => r,
            None => return SpawnOutcome::Timeout,
        };
        let deadline_per_recv = ready_timeout;
        match rx.recv_timeout(deadline_per_recv) {
            Ok(StdoutEvent::Ready(Ok(info))) => SpawnOutcome::Ready(info),
            Ok(StdoutEvent::Ready(Err((line, error)))) => {
                SpawnOutcome::MalformedReady { line, error }
            }
            Ok(StdoutEvent::Closed) => {
                // stdout EOF means the process is exiting. Use blocking
                // `wait()` so we always get the exit code even on the brief
                // race where the pipe closes before the OS marks the process
                // as done (observed on Windows).
                let exit_code = self.child.wait().ok().and_then(|s| s.code());
                SpawnOutcome::ExitedEarly { exit_code }
            }
            Err(RecvTimeoutError::Timeout) => SpawnOutcome::Timeout,
            Err(RecvTimeoutError::Disconnected) => SpawnOutcome::ExitedEarly { exit_code: None },
        }
    }

    /// True if the subprocess has not exited yet.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Forcefully kill the subprocess. Idempotent.
    pub fn kill(&mut self) -> std::io::Result<()> {
        match self.child.kill() {
            Ok(()) => Ok(()),
            // Already exited — treat as success.
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Unit tests for the pure helpers. Integration tests that actually
    //! spawn a subprocess live in `tests/spawn_integration.rs` so they can
    //! use the file-system temp directory.

    use super::*;

    #[test]
    fn ready_info_parses_camel_case_json() {
        let json = r#"{"daemonPort":19824,"cdpPort":19825,"token":"abc"}"#;
        let info: ReadyInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.daemon_port, 19824);
        assert_eq!(info.cdp_port, 19825);
        assert_eq!(info.token, "abc");
    }

    #[test]
    fn ready_info_rejects_missing_fields() {
        let json = r#"{"daemonPort":19824}"#;
        let err = serde_json::from_str::<ReadyInfo>(json).unwrap_err();
        assert!(err.to_string().contains("missing field"));
    }

    #[test]
    fn ready_prefix_matches_design_spec() {
        // Locking the prefix down — changing this is a wire-format break
        // with the daemon, so the test exists to make it intentional.
        assert_eq!(READY_PREFIX, "BB_DAEMON_READY ");
    }

    #[test]
    fn spawn_config_for_node_daemon_has_expected_shape() {
        let cfg = SpawnConfig::for_node_daemon(
            PathBuf::from("node"),
            PathBuf::from("packages/daemon/dist/index.js"),
        );
        assert_eq!(cfg.program, PathBuf::from("node"));
        assert_eq!(cfg.args, vec!["packages/daemon/dist/index.js".to_string()]);
        assert_eq!(cfg.ready_timeout, DEFAULT_READY_TIMEOUT);
    }
}
