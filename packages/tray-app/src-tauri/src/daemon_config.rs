//! Read/write `~/.bb-browser/daemon.json`.
//!
//! The daemon writes this file on startup so MCP clients (and the CLI) can
//! discover its port + token without a hardcoded value. The tray app reads
//! and writes it too.
//!
//! Schema:
//! ```json
//! {
//!   "schemaVersion": 1,
//!   "daemonPort": 19824,
//!   "cdpPort": 19825,
//!   "token": "0d50a5e3...",
//!   "pid": 12345,
//!   "startedAt": "2026-05-21T10:00:00Z"
//! }
//! ```
//!
//! See docs/system-tray-design.md §8.1.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Daemon connection info persisted to `~/.bb-browser/daemon.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonConfig {
    pub schema_version: u32,
    pub daemon_port: u16,
    pub cdp_port: u16,
    pub token: String,
    /// PID of the running daemon. Used to detect stale config from an
    /// old crashed daemon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// RFC-3339 timestamp of when the daemon started. Optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

impl DaemonConfig {
    pub fn new(daemon_port: u16, cdp_port: u16, token: impl Into<String>) -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            daemon_port,
            cdp_port,
            token: token.into(),
            pid: None,
            started_at: None,
        }
    }
}

/// Errors reading or writing the config file.
#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    Parse(serde_json::Error),
    UnsupportedSchema { found: u32, expected: u32 },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "io error: {e}"),
            ConfigError::Parse(e) => write!(f, "parse error: {e}"),
            ConfigError::UnsupportedSchema { found, expected } => {
                write!(f, "unsupported schemaVersion {found} (expected {expected})")
            }
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
    if config.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(ConfigError::UnsupportedSchema {
            found: config.schema_version,
            expected: CURRENT_SCHEMA_VERSION,
        });
    }
    Ok(Some(config))
}

/// Atomically write `daemon.json`. Writes to a temp file in the same
/// directory and renames into place so a crash during write leaves the
/// previous file intact.
pub fn write_config(path: &Path, config: &DaemonConfig) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(config)?;
    let tmp = with_extension(path, "tmp");
    std::fs::write(&tmp, &json)?;
    // On Windows, rename will fail if the destination already exists;
    // std::fs::rename does the right thing here by replacing.
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

    // ---- DaemonConfig::new ----

    #[test]
    fn new_uses_current_schema_version() {
        let cfg = DaemonConfig::new(19824, 19825, "abc");
        assert_eq!(cfg.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(cfg.daemon_port, 19824);
        assert_eq!(cfg.cdp_port, 19825);
        assert_eq!(cfg.token, "abc");
        assert_eq!(cfg.pid, None);
        assert_eq!(cfg.started_at, None);
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
    fn read_parses_valid_config() {
        let dir = temp_dir("valid");
        let path = dir.join("daemon.json");
        let json = r#"{
            "schemaVersion": 1,
            "daemonPort": 19824,
            "cdpPort": 19825,
            "token": "abc123"
        }"#;
        std::fs::write(&path, json).unwrap();

        let cfg = read_config(&path).unwrap().expect("should parse");
        assert_eq!(cfg.daemon_port, 19824);
        assert_eq!(cfg.cdp_port, 19825);
        assert_eq!(cfg.token, "abc123");
    }

    #[test]
    fn read_rejects_unsupported_schema_version() {
        let dir = temp_dir("schema-bad");
        let path = dir.join("daemon.json");
        let json = r#"{
            "schemaVersion": 99,
            "daemonPort": 19824,
            "cdpPort": 19825,
            "token": "abc"
        }"#;
        std::fs::write(&path, json).unwrap();

        let err = read_config(&path).unwrap_err();
        match err {
            ConfigError::UnsupportedSchema { found, expected } => {
                assert_eq!(found, 99);
                assert_eq!(expected, CURRENT_SCHEMA_VERSION);
            }
            other => panic!("expected UnsupportedSchema, got {other:?}"),
        }
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
        let cfg = DaemonConfig::new(19824, 19825, "abc");

        write_config(&path, &cfg).unwrap();
        assert!(path.exists(), "file should be created");
    }

    #[test]
    fn write_and_read_round_trip() {
        let dir = temp_dir("rt");
        let path = dir.join("daemon.json");
        let cfg = DaemonConfig {
            schema_version: 1,
            daemon_port: 19828,
            cdp_port: 19829,
            token: "xyz".into(),
            pid: Some(12345),
            started_at: Some("2026-05-21T10:00:00Z".into()),
        };

        write_config(&path, &cfg).unwrap();
        let read = read_config(&path).unwrap().expect("should exist");
        assert_eq!(read, cfg);
    }

    #[test]
    fn write_uses_camel_case_keys() {
        let dir = temp_dir("camel");
        let path = dir.join("daemon.json");
        let cfg = DaemonConfig::new(19824, 19825, "abc");
        write_config(&path, &cfg).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"schemaVersion\""));
        assert!(text.contains("\"daemonPort\""));
        assert!(text.contains("\"cdpPort\""));
        // pid + startedAt are None → must be omitted, not serialized as null.
        assert!(!text.contains("pid"));
        assert!(!text.contains("startedAt"));
    }

    #[test]
    fn write_replaces_existing_file_atomically() {
        let dir = temp_dir("atomic");
        let path = dir.join("daemon.json");

        // Initial write.
        let first = DaemonConfig::new(19824, 19825, "first");
        write_config(&path, &first).unwrap();

        // Overwrite.
        let second = DaemonConfig::new(19826, 19827, "second");
        write_config(&path, &second).unwrap();

        let read = read_config(&path).unwrap().unwrap();
        assert_eq!(read, second);

        // No leftover .tmp file.
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
        let cfg = DaemonConfig::new(19824, 19825, "abc");
        write_config(&path, &cfg).unwrap();
        assert!(path.exists());

        remove_config(&path).unwrap();
        assert!(!path.exists());
    }
}
