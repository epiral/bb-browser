//! Integration tests for `daemon_spawner`.
//!
//! These tests spawn a real subprocess. They use `node` (the project's
//! existing runtime) because we can rely on it being installed wherever
//! the tray-app is developed — the daemon itself runs on Node.
//!
//! Each test passes a small inline script via `node -e "…"` that simulates
//! one of the daemon startup paths (ready, exit, malformed, slow).

use bb_browser_tray::daemon_spawner::{
    DaemonProcess, ReadyInfo, SpawnConfig, SpawnOutcome, DEFAULT_READY_TIMEOUT,
};
use std::path::PathBuf;
use std::time::Duration;

fn node_program() -> PathBuf {
    // On Windows, node may be `node.exe`. PATH lookup handles both.
    PathBuf::from("node")
}

fn cfg_with_script(script: &str, ready_timeout: Duration) -> SpawnConfig {
    SpawnConfig {
        program: node_program(),
        args: vec!["-e".into(), script.into()],
        cwd: None,
        env: Vec::new(),
        ready_timeout,
    }
}

/// Returns true if `node` is available on PATH; otherwise tests are skipped
/// with an informative message so CI without Node still passes.
fn node_available() -> bool {
    std::process::Command::new(node_program())
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn ready_line_is_parsed() {
    if !node_available() {
        eprintln!("skipped: node not available on PATH");
        return;
    }
    let script = r#"console.log('BB_DAEMON_READY {"daemonPort":19824,"cdpPort":19825,"token":"abc"}'); setInterval(()=>{}, 1000);"#;
    let cfg = cfg_with_script(script, DEFAULT_READY_TIMEOUT);
    let mut proc = DaemonProcess::spawn(&cfg).expect("spawn");
    let outcome = proc.wait_for_ready(cfg.ready_timeout);

    match outcome {
        SpawnOutcome::Ready(info) => {
            assert_eq!(
                info,
                ReadyInfo {
                    daemon_port: 19824,
                    cdp_port: 19825,
                    token: "abc".into(),
                }
            );
        }
        other => panic!("expected Ready, got {other:?}"),
    }

    proc.kill().expect("kill");
}

#[test]
fn early_exit_is_detected() {
    if !node_available() {
        eprintln!("skipped: node not available on PATH");
        return;
    }
    // Exit immediately with non-zero status without emitting READY.
    let script = r#"console.error('boom'); process.exit(42);"#;
    let cfg = cfg_with_script(script, Duration::from_secs(5));
    let mut proc = DaemonProcess::spawn(&cfg).expect("spawn");
    let outcome = proc.wait_for_ready(cfg.ready_timeout);

    match outcome {
        SpawnOutcome::ExitedEarly { exit_code } => {
            assert_eq!(exit_code, Some(42));
        }
        other => panic!("expected ExitedEarly, got {other:?}"),
    }
}

#[test]
fn malformed_ready_line_is_surfaced() {
    if !node_available() {
        eprintln!("skipped: node not available on PATH");
        return;
    }
    // Valid prefix but the JSON is broken.
    let script = r#"console.log('BB_DAEMON_READY {not json}'); setInterval(()=>{}, 1000);"#;
    let cfg = cfg_with_script(script, DEFAULT_READY_TIMEOUT);
    let mut proc = DaemonProcess::spawn(&cfg).expect("spawn");
    let outcome = proc.wait_for_ready(cfg.ready_timeout);

    match outcome {
        SpawnOutcome::MalformedReady { line, .. } => {
            assert!(line.contains("BB_DAEMON_READY"));
        }
        other => panic!("expected MalformedReady, got {other:?}"),
    }

    proc.kill().expect("kill");
}

#[test]
fn timeout_fires_when_ready_never_arrives() {
    if !node_available() {
        eprintln!("skipped: node not available on PATH");
        return;
    }
    // Runs forever without ever emitting READY.
    let script = r#"setInterval(()=>{}, 1000);"#;
    let cfg = cfg_with_script(script, Duration::from_millis(500));
    let mut proc = DaemonProcess::spawn(&cfg).expect("spawn");
    let outcome = proc.wait_for_ready(cfg.ready_timeout);

    match outcome {
        SpawnOutcome::Timeout => {}
        other => panic!("expected Timeout, got {other:?}"),
    }

    proc.kill().expect("kill");
}

#[test]
fn kill_is_idempotent() {
    if !node_available() {
        eprintln!("skipped: node not available on PATH");
        return;
    }
    let script = r#"setInterval(()=>{}, 1000);"#;
    let cfg = cfg_with_script(script, Duration::from_millis(200));
    let mut proc = DaemonProcess::spawn(&cfg).expect("spawn");

    proc.kill().expect("first kill");
    // Second kill should not return an error even though the child is gone.
    proc.kill().expect("second kill");
}

#[test]
fn is_alive_reflects_subprocess_state() {
    if !node_available() {
        eprintln!("skipped: node not available on PATH");
        return;
    }
    let script = r#"setInterval(()=>{}, 1000);"#;
    let cfg = cfg_with_script(script, Duration::from_millis(200));
    let mut proc = DaemonProcess::spawn(&cfg).expect("spawn");
    assert!(proc.is_alive());

    proc.kill().expect("kill");
    // Give the OS a moment to reap.
    std::thread::sleep(Duration::from_millis(200));
    assert!(!proc.is_alive());
}
