//! Daemon subprocess lifecycle wrapper.
//!
//! Bridges the Rust supervisor state machine to a real `node packages/daemon`
//! subprocess. When the supervisor says `Spawn`, this module launches the
//! daemon, reads the `BB_DAEMON_READY` line from stdout, posts identity
//! back to the controller, and watches for the process to exit.
//!
//! Thread model:
//! - One watcher thread per spawn. Owns the `DaemonProcess`.
//! - Communicates back to the main app via `AppHandle::run_on_main_thread`
//!   (Tauri marshals to its event loop), which then calls
//!   `crate::app::dispatch_event`.

use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use bb_browser_tray::daemon_spawner::{
    DaemonProcess, ReadyInfo, SpawnConfig, SpawnOutcome, DEFAULT_READY_TIMEOUT,
};
use bb_browser_tray::port_discovery::{discover_default, PortPair};
use bb_browser_tray::supervisor::Event;
use tauri::{AppHandle, Manager};

/// Owns the side-band kill signal for the active daemon (if any). The
/// actual `DaemonProcess` lives on the watcher thread.
pub struct DaemonRunner {
    /// `Some(sender)` while a watcher is running; `None` when idle.
    kill_tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

impl Default for DaemonRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl DaemonRunner {
    pub fn new() -> Self {
        Self {
            kill_tx: Mutex::new(None),
        }
    }

    /// Launch the daemon and start the lifecycle watcher. If a previous
    /// daemon is still running, kill it first.
    pub fn spawn(&self, app: AppHandle) {
        self.kill();

        let config = match build_spawn_config(&app) {
            Ok(c) => c,
            Err(msg) => {
                eprintln!("[runner] cannot build spawn config: {msg}");
                let app_clone = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::app::dispatch_event(
                        &app_clone,
                        Event::DaemonExited {
                            now_ms: now_ms(),
                            during_startup: true,
                        },
                    );
                });
                return;
            }
        };

        let process = match DaemonProcess::spawn(&config) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[runner] daemon spawn failed: {e}");
                let app_clone = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::app::dispatch_event(
                        &app_clone,
                        Event::DaemonExited {
                            now_ms: now_ms(),
                            during_startup: true,
                        },
                    );
                });
                return;
            }
        };

        let (tx, rx) = std::sync::mpsc::channel::<()>();
        *self.kill_tx.lock().unwrap() = Some(tx);

        let app_clone = app.clone();
        let ready_timeout = config.ready_timeout;
        thread::spawn(move || {
            run_watcher(app_clone, process, ready_timeout, rx);
        });
    }

    /// Kill any currently-running daemon. Idempotent — silently no-ops if
    /// nothing is running.
    pub fn kill(&self) {
        if let Some(tx) = self.kill_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

// ---------------------------------------------------------------------------
// Spawn config builder
// ---------------------------------------------------------------------------

/// Locate `node` + `packages/daemon/dist/index.js` and build a SpawnConfig.
///
/// Probes for a free even/odd port pair before launching — this lets the
/// daemon dodge already-bound ports (e.g. another bb-browser instance, or
/// Windows port reservations) without changing the daemon code.
fn build_spawn_config(app: &AppHandle) -> Result<SpawnConfig, String> {
    let node = which::which("node")
        .map_err(|e| format!("node not on PATH: {e}"))?;
    let daemon_entry = locate_daemon_entry(app)?;

    let PortPair { daemon, cdp } =
        discover_default().map_err(|e| format!("port discovery failed: {e:?}"))?;
    eprintln!("[runner] using daemon={daemon}, cdp={cdp}");

    Ok(SpawnConfig {
        program: node,
        args: vec![
            daemon_entry.to_string_lossy().into_owned(),
            "--port".into(),
            daemon.to_string(),
            "--cdp-port".into(),
            cdp.to_string(),
        ],
        cwd: None,
        env: Vec::new(),
        ready_timeout: DEFAULT_READY_TIMEOUT,
    })
}

/// Find `packages/daemon/dist/index.js`.
///
/// Strategy:
/// 1. In a packaged install: `resource_dir/daemon/index.js`
/// 2. Dev: walk up from the binary until we find `packages/daemon/dist/index.js`
fn locate_daemon_entry(app: &AppHandle) -> Result<PathBuf, String> {
    // Packaged location.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("daemon").join("index.js");
        if p.exists() {
            return Ok(p);
        }
    }

    // Dev location — walk up from current dir.
    let mut cur = std::env::current_dir().map_err(|e| e.to_string())?;
    for _ in 0..6 {
        let candidate = cur
            .join("packages")
            .join("daemon")
            .join("dist")
            .join("index.js");
        if candidate.exists() {
            return Ok(candidate);
        }
        if !cur.pop() {
            break;
        }
    }

    Err(
        "could not locate packages/daemon/dist/index.js. Run `pnpm build` from the repo root."
            .into(),
    )
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

fn run_watcher(
    app: AppHandle,
    mut process: DaemonProcess,
    ready_timeout: Duration,
    kill_rx: std::sync::mpsc::Receiver<()>,
) {
    // Phase 1: wait for the daemon to emit BB_DAEMON_READY.
    let outcome = process.wait_for_ready(ready_timeout);
    match outcome {
        SpawnOutcome::Ready(info) => {
            on_ready(&app, info);
        }
        SpawnOutcome::ExitedEarly { exit_code } => {
            eprintln!("[runner] daemon exited early, code={exit_code:?}");
            on_early_exit(&app);
            return;
        }
        SpawnOutcome::Timeout => {
            eprintln!(
                "[runner] daemon didn't emit READY within {}ms",
                ready_timeout.as_millis()
            );
            let _ = process.kill();
            on_early_exit(&app);
            return;
        }
        SpawnOutcome::MalformedReady { line, error } => {
            eprintln!("[runner] malformed READY: {line:?} ({error})");
            let _ = process.kill();
            on_early_exit(&app);
            return;
        }
    }

    // Phase 2: watch for process exit OR a kill signal.
    loop {
        // Check for kill signal first (non-blocking).
        if kill_rx.try_recv().is_ok() {
            eprintln!("[runner] kill requested");
            let _ = process.kill();
            // Treat user-requested kills as the same as a runtime crash so
            // the supervisor enters Stopped via its UserStop path. We use
            // DaemonExited here so the watcher contract stays simple — the
            // controller decides what state to move into.
            on_crash(&app);
            return;
        }

        if !process.is_alive() {
            eprintln!("[runner] daemon exited unexpectedly");
            on_crash(&app);
            return;
        }

        thread::sleep(Duration::from_millis(500));
    }
}

fn on_ready(app: &AppHandle, info: ReadyInfo) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Update the controller's identity first, then dispatch ready.
        {
            let state = app_clone.state::<crate::app::AppState>();
            let mut c = state.controller.lock().unwrap();
            c.set_daemon_identity(info.daemon_port, info.cdp_port, info.token.clone());
        }
        crate::app::dispatch_event(&app_clone, Event::DaemonReady);
    });
}

fn on_early_exit(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::app::dispatch_event(
            &app_clone,
            Event::DaemonExited {
                now_ms: now_ms(),
                during_startup: true,
            },
        );
    });
}

fn on_crash(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::app::dispatch_event(
            &app_clone,
            Event::DaemonExited {
                now_ms: now_ms(),
                during_startup: false,
            },
        );
    });
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
