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

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use bb_browser_tray::daemon_config::{
    daemon_config_path, decide_reap, kill_process, read_config, remove_config, DaemonConfig,
};
use bb_browser_tray::daemon_spawner::{
    DaemonProcess, ReadyInfo, SpawnConfig, SpawnOutcome, DEFAULT_READY_TIMEOUT,
};
use bb_browser_tray::port_discovery::{
    find_even_port, find_odd_port, OsPortChecker, DEFAULT_CDP_PORT, DEFAULT_DAEMON_PORT,
};
use bb_browser_tray::supervisor::Event;
use bb_browser_tray::tray_state::CdpState;
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
        // Were we tracking our own daemon before this call? If so, this is a
        // restart (the supervisor decided to replace our daemon), not a fresh
        // start — we must spawn, never adopt.
        let was_tracking = self.kill_tx.lock().unwrap().is_some();
        self.kill();

        // Policy: prefer adopting an already-healthy daemon over killing and
        // replacing it. On a *fresh* start (we weren't tracking our own daemon),
        // if daemon.json points at a daemon that still answers GET /status,
        // monitor it instead of spawning a second daemon. A second daemon on the
        // same Chrome runs its own SessionManager / lease table (defeating
        // per-session isolation) and the two race to delete each other's
        // daemon.json — exactly the failure that leaves WSL agents unable to
        // find the daemon.
        if !was_tracking {
            if let Some(adopted) = probe_healthy_daemon() {
                eprintln!(
                    "[runner] adopting healthy daemon on port {} (pid={:?}); not spawning a second one",
                    adopted.port, adopted.pid
                );
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                *self.kill_tx.lock().unwrap() = Some(tx);
                let app_clone = app.clone();
                thread::spawn(move || run_adopt_watcher(app_clone, adopted, rx));
                return;
            }
        }

        // No healthy daemon to adopt. Reap whatever (dead/unhealthy) orphan
        // daemon.json still advertises — the tray's own kill() only covers the
        // process it tracks; an orphan from a prior crash / manual launch /
        // bb-daemon-run.bat keeps the port bound AND runs a second SessionManager
        // on the same Chrome. See daemon_config::decide_reap.
        reap_orphan_daemon();

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
                // Primary was the bare name "node" (PATH search). If that
                // fails, retry with the absolute path resolved by `which`
                // (covers environments where PATH isn't inherited).
                eprintln!(
                    "[runner] daemon spawn failed: {e} | program={:?}; retrying with absolute node path",
                    config.program
                );
                let fallback = which::which("node").ok().map(|abs| {
                    let mut c = config.clone();
                    c.program = abs;
                    c
                });
                match fallback.as_ref().map(DaemonProcess::spawn) {
                    Some(Ok(p)) => {
                        eprintln!("[runner] fallback spawn with absolute node path succeeded");
                        p
                    }
                    other => {
                        if let Some(Err(e2)) = other {
                            eprintln!("[runner] fallback spawn also failed: {e2}");
                        } else {
                            eprintln!("[runner] no absolute node path available for fallback");
                        }
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
                }
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
// Orphan daemon reaping
// ---------------------------------------------------------------------------

/// If daemon.json advertises a daemon that still answers `GET /status`, return
/// its config so the caller can adopt it. `None` when there's no (readable)
/// config or the advertised daemon doesn't respond.
fn probe_healthy_daemon() -> Option<DaemonConfig> {
    let path = daemon_config_path()?;
    let config = read_config(&path).ok()??;
    // poll_status returning Some means the daemon answered /status with a
    // recognizable body — i.e. it is alive and serving.
    poll_status(&config.host, config.port, &config.token)?;
    Some(config)
}

/// Read daemon.json, and if it advertises a foreign pid, kill it. Only delete
/// the file once we've confirmed the advertised daemon is no longer serving —
/// if it somehow survives the kill and still answers /status, we leave its
/// daemon.json intact so readers (e.g. WSL agents) keep finding it. Best-effort:
/// every failure path is logged and swallowed so reaping never blocks startup.
fn reap_orphan_daemon() {
    let path = match daemon_config_path() {
        Some(p) => p,
        None => return,
    };

    let config = match read_config(&path) {
        Ok(c) => c,
        // A corrupt / unsupported daemon.json still warrants removal so the new
        // daemon isn't read against stale data.
        Err(e) => {
            eprintln!("[runner] reap: unreadable daemon.json ({e}); removing it");
            let _ = remove_config(&path);
            return;
        }
    };

    let self_pid = std::process::id();
    let pid = match decide_reap(config.as_ref(), self_pid) {
        Some(pid) => pid,
        // Either no file, no pid, or it was our own pid — nothing to reap.
        None => return,
    };

    let killed = kill_process(pid);
    // `decide_reap` returned Some, so config is Some too.
    let cfg = config.as_ref().expect("decide_reap implies a config");
    // `taskkill` returns before the daemon's HTTP socket is torn down, so a
    // single immediate poll can falsely see the dying daemon as alive. Confirm
    // it has actually stopped serving over a short window before deciding.
    if daemon_confirmed_gone(&cfg.host, cfg.port, &cfg.token) {
        eprintln!(
            "[runner] reap: orphan pid {pid} gone (kill success={killed}); removing daemon.json"
        );
        let _ = remove_config(&path);
    } else {
        // Still serving ~1.5s after the kill — keep its advertisement rather
        // than stranding a live daemon. A fresh daemon (if we go on to spawn
        // one) will atomically overwrite daemon.json on startup anyway.
        eprintln!(
            "[runner] reap: pid {pid} still serving after kill (success={killed}); leaving daemon.json"
        );
    }
}

/// Poll `/status` a few times over ~1.5s to confirm a just-killed daemon has
/// actually stopped serving. Returns true once it stops responding; false if it
/// is still serving after the window (genuinely alive / unkillable).
fn daemon_confirmed_gone(host: &str, port: u16, token: &str) -> bool {
    for attempt in 0..6 {
        if poll_status(host, port, token).is_none() {
            return true;
        }
        if attempt < 5 {
            thread::sleep(Duration::from_millis(250));
        }
    }
    false
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
    // Verify node is installed (clear error if not). We then spawn it by the
    // bare name "node" rather than this absolute path: Rust's Windows Command
    // resolution spuriously fails ("program not found") for absolute node
    // paths containing spaces (e.g. C:\Program Files\nodejs\node.exe), whereas
    // its PATH search for the bare name works reliably. The absolute path is
    // kept only as a cross-platform fallback (see DaemonRunner::spawn).
    let node_abs = which::which("node")
        .map_err(|e| format!("node not on PATH: {e}"))?;
    eprintln!("[runner] node on PATH: {node_abs:?} (exists={})", node_abs.exists());
    let daemon_entry = locate_daemon_entry(app)?;
    eprintln!(
        "[runner] resolved daemon entry: {daemon_entry:?} (exists={})",
        daemon_entry.exists()
    );

    // Discover a free even port for the daemon HTTP server and a free odd port
    // for Chrome's CDP debug port. Both ports are scanned from their defaults;
    // the wide MAX_SCAN_RANGE lets discovery skip over Windows Hyper-V/WSL port
    // exclusion clusters and portproxy-held ports that would otherwise cause
    // Chrome to crash at startup (unable to bind its debug port).
    let daemon = find_even_port(&OsPortChecker, DEFAULT_DAEMON_PORT)
        .map_err(|e| format!("daemon port discovery failed: {e:?}"))?;
    let cdp = find_odd_port(&OsPortChecker, DEFAULT_CDP_PORT)
        .map_err(|e| format!("cdp port discovery failed: {e:?}"))?;
    eprintln!("[runner] using daemon={daemon}, cdp={cdp}");

    // Node.js cannot run a main module given a Windows extended-length
    // ("verbatim") path like `\\?\Z:\Apps\...\index.js` — it fails with
    // `EISDIR: illegal operation on a directory, lstat 'Z:'`. Tauri's
    // `resource_dir()` returns exactly such a path, so strip the prefix.
    let entry_str = strip_verbatim_prefix(&daemon_entry.to_string_lossy());
    eprintln!("[runner] daemon entry (node arg): {entry_str}");

    Ok(SpawnConfig {
        program: PathBuf::from("node"),
        args: vec![
            entry_str,
            // Bind the wildcard address so agents inside WSL2 can reach the
            // daemon via the Windows host IP (WSL2's loopback is a separate
            // network namespace and can't dial Windows' 127.0.0.1). The daemon
            // still advertises loopback in daemon.json, and Bearer-token auth
            // gates the now-LAN-reachable port.
            "--host".into(),
            "0.0.0.0".into(),
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

/// Strip a Windows extended-length path prefix (`\\?\` or `\\?\UNC\`) so the
/// result is a normal path Node.js can use as a main module. No-op on
/// non-prefixed paths and on non-Windows platforms.
fn strip_verbatim_prefix(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
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
    let (poll_port, poll_token) = match outcome {
        SpawnOutcome::Ready(info) => {
            let identity = (info.daemon_port, info.token.clone());
            on_ready(&app, info);
            identity
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
    };

    // Phase 2: watch for process exit OR a kill signal, and poll the daemon's
    // real CDP status. READY only means the HTTP server is up — the tray must
    // turn green once Chrome is actually attached, which the daemon reports as
    // `"cdpConnected":true` from GET /status.
    let mut last_connected: Option<bool> = None;
    let mut ticks: u32 = 0;
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

        // Poll /status every ~1.5s (every 3rd 500ms tick). A tray-spawned daemon
        // advertises loopback, so dial 127.0.0.1.
        if ticks % 3 == 0 {
            if let Some(status) = poll_status("127.0.0.1", poll_port, &poll_token) {
                if last_connected != Some(status.cdp_connected) {
                    last_connected = Some(status.cdp_connected);
                    on_cdp_status(&app, status.cdp_connected);
                }
            }
        }
        ticks = ticks.wrapping_add(1);

        thread::sleep(Duration::from_millis(500));
    }
}

/// Watch an *adopted* daemon — one already running that we did NOT spawn (e.g.
/// left by bb-daemon-run.bat or a previous tray). We have no process handle and
/// no stdout, so we only poll `GET /status`: report CDP state to the tray, and
/// relinquish (let the supervisor restart → spawn our own) if it stops
/// responding. We never kill it or touch its daemon.json — it may be serving
/// other agents.
fn run_adopt_watcher(
    app: AppHandle,
    info: DaemonConfig,
    kill_rx: std::sync::mpsc::Receiver<()>,
) {
    // Seed identity from daemon.json and mark ready, as if we'd spawned it.
    // daemon.json carries no CDP port, so learn the real one from the adopted
    // daemon's /status; fall back to DEFAULT_CDP_PORT only if an older daemon
    // omits it.
    let cdp_port = poll_status(&info.host, info.port, &info.token)
        .and_then(|s| s.cdp_port)
        .unwrap_or(DEFAULT_CDP_PORT);
    on_ready(
        &app,
        ReadyInfo {
            daemon_port: info.port,
            cdp_port,
            token: info.token.clone(),
        },
    );

    let mut last_connected: Option<bool> = None;
    let mut misses: u32 = 0;
    loop {
        if kill_rx.try_recv().is_ok() {
            eprintln!("[runner] adopt watcher: stop requested (leaving adopted daemon running)");
            on_crash(&app);
            return;
        }

        match poll_status(&info.host, info.port, &info.token) {
            Some(status) => {
                misses = 0;
                if last_connected != Some(status.cdp_connected) {
                    last_connected = Some(status.cdp_connected);
                    on_cdp_status(&app, status.cdp_connected);
                }
            }
            None => {
                // Tolerate a couple of transient misses; a sustained silence
                // means the adopted daemon is gone, so hand back to the
                // supervisor, which restarts → spawn() reaps the corpse and
                // launches a fresh tray-owned daemon.
                misses += 1;
                if misses >= 3 {
                    eprintln!("[runner] adopted daemon stopped responding; relinquishing to respawn");
                    on_crash(&app);
                    return;
                }
            }
        }

        thread::sleep(Duration::from_millis(1500));
    }
}

/// Parsed subset of the daemon's `GET /status` response.
struct DaemonStatus {
    cdp_connected: bool,
    /// The CDP port the daemon is using, if it reports one (`cdpPort`). Older
    /// daemons omit it; callers fall back to `DEFAULT_CDP_PORT`.
    cdp_port: Option<u16>,
}

/// Best-effort raw-HTTP `GET /status` against `host:daemon_port`. Returns `None`
/// on any error so transient failures don't flap the tray. `host` honours the
/// address advertised in daemon.json (the daemon may bind/advertise something
/// other than loopback).
fn poll_status(host: &str, daemon_port: u16, token: &str) -> Option<DaemonStatus> {
    let mut stream = TcpStream::connect((host, daemon_port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let req = format!(
        "GET /status HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut body = String::new();
    stream.read_to_string(&mut body).ok()?;
    // Tolerate both `"key":true` and `"key": true`.
    let has = |key: &str, val: bool| {
        body.contains(&format!("\"{key}\":{val}")) || body.contains(&format!("\"{key}\": {val}"))
    };
    // Only treat the response as valid if it carried cdpConnected at all.
    if !has("cdpConnected", true) && !has("cdpConnected", false) {
        return None;
    }
    Some(DaemonStatus {
        cdp_connected: has("cdpConnected", true),
        cdp_port: json_u16(&body, "cdpPort"),
    })
}

/// Extract a numeric JSON field (`"key":12345` or `"key": 12345`) from a raw
/// body. Returns None if absent or not a u16.
fn json_u16(body: &str, key: &str) -> Option<u16> {
    let pat = format!("\"{key}\":");
    let start = body.find(&pat)? + pat.len();
    let digits: String = body[start..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Push a CDP connection-status change into the controller and repaint.
fn on_cdp_status(app: &AppHandle, connected: bool) {
    eprintln!("[runner] cdp status poll -> connected={connected}");
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        {
            let state = app_clone.state::<crate::app::AppState>();
            let mut c = state.controller.lock().unwrap();
            c.set_cdp_state(if connected {
                CdpState::Connected
            } else {
                CdpState::Reconnecting
            });
        }
        crate::app::refresh_tray_public(&app_clone);
    });
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

#[cfg(test)]
mod tests {
    use super::strip_verbatim_prefix;

    #[test]
    fn strips_plain_verbatim_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\Z:\Apps\bb-browser-tray\daemon\index.js"),
            r"Z:\Apps\bb-browser-tray\daemon\index.js"
        );
    }

    #[test]
    fn rewrites_verbatim_unc_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\daemon\index.js"),
            r"\\server\share\daemon\index.js"
        );
    }

    #[test]
    fn leaves_normal_path_untouched() {
        assert_eq!(
            strip_verbatim_prefix(r"Z:\Apps\daemon\index.js"),
            r"Z:\Apps\daemon\index.js"
        );
    }
}
