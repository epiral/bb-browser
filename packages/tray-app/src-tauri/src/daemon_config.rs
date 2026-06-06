//! Read `~/.bb-browser/daemon.json`.
//!
//! The daemon writes this file on startup so MCP clients (and the CLI) can
//! discover its port + token without a hardcoded value. The schema is owned by
//! the daemon (`packages/daemon/src/index.ts` `writeDaemonJson`) and read by
//! the MCP/CLI clients (`packages/shared/src/daemon-client.ts`):
//!
//! ```json
//! {
//!   "pid": 12345,
//!   "host": "127.0.0.1",
//!   "port": 19824,
//!   "token": "0d50a5e3..."
//! }
//! ```
//!
//! The tray only ever *reads* this file (to reap/adopt the advertised daemon);
//! it never writes it. The struct below must therefore match exactly what the
//! daemon writes — an older, camelCase `{schemaVersion,daemonPort,cdpPort}`
//! shape never existed on disk and made every read fail to parse.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Daemon connection info as persisted to `~/.bb-browser/daemon.json` by the
/// daemon. Field names match the on-disk JSON exactly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DaemonConfig {
    /// PID of the running daemon. Used to reap an orphan. The daemon always
    /// writes it; `default` tolerates an older/partial file.
    #[serde(default)]
    pub pid: Option<u32>,
    /// Connectable host the daemon advertises (loopback when it bound 0.0.0.0).
    pub host: String,
    /// Daemon HTTP port.
    pub port: u16,
    /// Bearer token for the daemon HTTP API.
    pub token: String,
}

impl DaemonConfig {
    pub fn new(port: u16, token: impl Into<String>) -> Self {
        Self {
            pid: None,
            host: "127.0.0.1".into(),
            port,
            token: token.into(),
        }
    }
}

/// Errors reading or writing the config file.
#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    Parse(serde_json::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "io error: {e}"),
            ConfigError::Parse(e) => write!(f, "parse error: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<std::io::Error> for ConfigError {
    fn from(e: std::io::Error) -> Self {
        ConfigError::Io(e)
    }
}

impl From<serde_json::Error> for ConfigError {
    fn from(e: serde_json::Error) -> Self {
        ConfigError::Parse(e)
    }
}

/// Default location: `~/.bb-browser/daemon.json`.
pub fn default_config_path() -> Option<PathBuf> {
    let home = home_dir()?;
    Some(home.join(".bb-browser").join("daemon.json"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Read and parse `daemon.json`. Returns `Ok(None)` if the file does not exist.
pub fn read_config(path: &Path) -> Result<Option<DaemonConfig>, ConfigError> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    let config: DaemonConfig = serde_json::from_slice(&bytes)?;
    Ok(Some(config))
}

/// Atomically write `daemon.json`. Writes to a temp file in the same
/// directory and renames into place so a crash during write leaves the
/// previous file intact. (The tray does not write this file in production; this
/// exists for completeness and tests.)
pub fn write_config(path: &Path, config: &DaemonConfig) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec(config)?;
    let tmp = with_extension(path, "tmp");
    std::fs::write(&tmp, &json)?;
    // On Windows, std::fs::rename replaces an existing destination.
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn with_extension(path: &Path, ext: &str) -> PathBuf {
    let mut buf = path.as_os_str().to_os_string();
    buf.push(".");
    buf.push(ext);
    PathBuf::from(buf)
}

/// Remove `daemon.json`. No-op if it does not exist.
pub fn remove_config(path: &Path) -> Result<(), ConfigError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ConfigError::Io(e)),
    }
}

// ---------------------------------------------------------------------------
// Orphan daemon reaping
// ---------------------------------------------------------------------------
//
// The tray only tracks the daemon *it* spawned. A daemon left behind by a
// previous tray crash, a manual `node daemon.js`, or the bb-daemon-run.bat
// launcher is invisible to it. Such an orphan keeps port 19824 bound (forcing
// the new daemon onto 19826) and — critically — a second daemon attached to the
// same Chrome runs its own SessionManager / lease table, silently defeating the
// per-session tab isolation. So before spawning, the tray reaps whatever pid
// the existing daemon.json advertises (mirrors bb-daemon-run.bat step 1).

/// Decide which pid (if any) should be reaped before spawning a fresh daemon.
///
/// Returns the advertised pid unless it is our own process (a corrupt/foreign
/// daemon.json could otherwise make the tray kill itself). A `None` config or a
/// config without a pid yields `None`.
pub fn decide_reap(config: Option<&DaemonConfig>, self_pid: u32) -> Option<u32> {
    let pid = config?.pid?;
    if pid == self_pid {
        return None;
    }
    Some(pid)
}

/// Force-kill a process by pid. Returns true if the kill command reported
/// success. A pid that is already dead yields false (harmless). Best-effort:
/// any spawn failure is swallowed into `false`.
pub fn kill_process(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Suppress the console window the tray GUI would otherwise flash.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Resolve the daemon.json path the *daemon* would write, honouring
/// `BB_BROWSER_HOME` (which the daemon uses) before falling back to
/// `~/.bb-browser`. This keeps the tray's reap target aligned with wherever the
/// daemon actually persists its config.
pub fn daemon_config_path() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("BB_BROWSER_HOME") {
        return Some(PathBuf::from(home).join("daemon.json"));
    }
    default_config_path()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Create a unique temp dir for an isolated test.
    fn temp_dir(name: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("bb-browser-test-{pid}-{n}-{name}"));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    // ---- read_config ----

    #[test]
    fn read_returns_none_for_missing_file() {
        let dir = temp_dir("missing");
        let path = dir.join("daemon.json");
        let result = read_config(&path).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn read_parses_real_daemon_written_shape() {
        // Exactly what packages/daemon/src/index.ts writeDaemonJson emits.
        let dir = temp_dir("real-shape");
        let path = dir.join("daemon.json");
        let json = r#"{"pid":12345,"host":"127.0.0.1","port":19824,"token":"abc123"}"#;
        std::fs::write(&path, json).unwrap();

        let cfg = read_config(&path).unwrap().expect("should parse");
        assert_eq!(cfg.pid, Some(12345));
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 19824);
        assert_eq!(cfg.token, "abc123");
    }

    #[test]
    fn read_tolerates_missing_pid() {
        let dir = temp_dir("no-pid");
        let path = dir.join("daemon.json");
        let json = r#"{"host":"127.0.0.1","port":19824,"token":"abc"}"#;
        std::fs::write(&path, json).unwrap();

        let cfg = read_config(&path).unwrap().expect("should parse");
        assert_eq!(cfg.pid, None);
    }

    #[test]
    fn read_fails_on_invalid_json() {
        let dir = temp_dir("bad-json");
        let path = dir.join("daemon.json");
        std::fs::write(&path, "{ not json }").unwrap();

        let err = read_config(&path).unwrap_err();
        match err {
            ConfigError::Parse(_) => {}
            other => panic!("expected Parse, got {other:?}"),
        }
    }

    // ---- write_config ----

    #[test]
    fn write_creates_parent_directory() {
        let dir = temp_dir("nested");
        let path = dir.join("nested-dir").join("daemon.json");
        let cfg = DaemonConfig::new(19824, "abc");

        write_config(&path, &cfg).unwrap();
        assert!(path.exists(), "file should be created");
    }

    #[test]
    fn write_and_read_round_trip() {
        let dir = temp_dir("rt");
        let path = dir.join("daemon.json");
        let cfg = DaemonConfig {
            pid: Some(12345),
            host: "127.0.0.1".into(),
            port: 19828,
            token: "xyz".into(),
        };

        write_config(&path, &cfg).unwrap();
        let read = read_config(&path).unwrap().expect("should exist");
        assert_eq!(read, cfg);
    }

    #[test]
    fn write_uses_daemon_field_names() {
        let dir = temp_dir("fields");
        let path = dir.join("daemon.json");
        let cfg = DaemonConfig::new(19824, "abc");
        write_config(&path, &cfg).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"host\""));
        assert!(text.contains("\"port\""));
        assert!(text.contains("\"token\""));
    }

    #[test]
    fn write_replaces_existing_file_atomically() {
        let dir = temp_dir("atomic");
        let path = dir.join("daemon.json");

        let first = DaemonConfig::new(19824, "first");
        write_config(&path, &first).unwrap();

        let second = DaemonConfig::new(19826, "second");
        write_config(&path, &second).unwrap();

        let read = read_config(&path).unwrap().unwrap();
        assert_eq!(read, second);

        let tmp = with_extension(&path, "tmp");
        assert!(!tmp.exists(), "tmp file should be cleaned up");
    }

    // ---- remove_config ----

    #[test]
    fn remove_succeeds_when_file_does_not_exist() {
        let dir = temp_dir("rm-missing");
        let path = dir.join("daemon.json");
        remove_config(&path).expect("should not error");
    }

    #[test]
    fn remove_deletes_existing_file() {
        let dir = temp_dir("rm-exists");
        let path = dir.join("daemon.json");
        let cfg = DaemonConfig::new(19824, "abc");
        write_config(&path, &cfg).unwrap();
        assert!(path.exists());

        remove_config(&path).unwrap();
        assert!(!path.exists());
    }

    // ---- decide_reap ----

    fn cfg_with_pid(pid: Option<u32>) -> DaemonConfig {
        DaemonConfig {
            pid,
            host: "127.0.0.1".into(),
            port: 19824,
            token: "t".into(),
        }
    }

    #[test]
    fn reap_returns_advertised_pid() {
        let cfg = cfg_with_pid(Some(4321));
        assert_eq!(decide_reap(Some(&cfg), 1000), Some(4321));
    }

    #[test]
    fn reap_skips_when_no_config() {
        assert_eq!(decide_reap(None, 1000), None);
    }

    #[test]
    fn reap_skips_when_config_has_no_pid() {
        let cfg = cfg_with_pid(None);
        assert_eq!(decide_reap(Some(&cfg), 1000), None);
    }

    #[test]
    fn reap_never_kills_self() {
        let cfg = cfg_with_pid(Some(1000));
        assert_eq!(decide_reap(Some(&cfg), 1000), None);
    }
}
