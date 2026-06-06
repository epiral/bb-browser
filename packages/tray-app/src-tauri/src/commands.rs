//! Tauri IPC commands invoked by the popup frontend (`src/main.js`).
//!
//! Only compiled with `--features tauri-app`. Each `#[tauri::command]`
//! corresponds to a `window.__TAURI__.core.invoke("...", { ... })` call
//! in JS. Keep the surface area narrow and stable — the popup HTML treats
//! it as a contract.

use crate::app::AppState;
use bb_browser_tray::supervisor::Event;
use bb_browser_tray::tray_state::TrayColor;

use serde::Serialize;
use tauri::{Manager, State};

/// One recent command for the popup's "最近命令" list.
#[derive(Serialize, Clone)]
pub struct RecentCommand {
    pub text: String,
    /// Human-friendly age, e.g. "now", "2s", "1m".
    pub age: String,
}

/// Full state payload for the popup. Matches the shape the JS `render()`
/// function expects.
#[derive(Serialize)]
pub struct StatusPayload {
    /// "green" / "yellow" / "red".
    pub color: &'static str,
    /// Localized status text — e.g. "已连接", "重连中", "未运行".
    pub status_text: String,
    pub daemon_port: Option<u16>,
    pub cdp_port: Option<u16>,
    pub token: Option<String>,
    /// Human-friendly Chrome info line, e.g. "Chrome v130 · 6 tabs".
    pub chrome_info: String,
    pub recent_commands: Vec<RecentCommand>,
    /// Optional red banner text. `None` = no banner shown.
    pub error_message: Option<String>,
}

/// Get the current popup payload. Pure read-only.
#[tauri::command]
pub fn get_status(state: State<'_, AppState>) -> StatusPayload {
    let c = state.controller.lock().unwrap();
    let snap = c.snapshot();
    StatusPayload {
        color: match snap.color {
            TrayColor::Green => "green",
            TrayColor::Yellow => "yellow",
            TrayColor::Red => "red",
        },
        status_text: snap.status_text,
        daemon_port: c.daemon_port_value(),
        // Phase 2.6 stubs — CDP port + token will be populated by the
        // spawner (Phase 2.8) and CDP watcher (post-MVP1).
        cdp_port: c.cdp_port_value(),
        token: c.token_value(),
        chrome_info: "Chrome 未连接".to_string(),
        recent_commands: vec![],
        error_message: None,
    }
}

/// Copy `text` to the system clipboard via tauri-plugin-clipboard-manager.
#[tauri::command]
pub fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// Restart the daemon. From `Stopped/Failed/GaveUp` it does a fresh start;
/// from `Running/Starting` it issues `UserRestart` which clears the crash
/// budget and respawns.
#[tauri::command]
pub fn restart_daemon(app: tauri::AppHandle, state: State<'_, AppState>) {
    let is_active = state.controller.lock().unwrap().is_active();
    let evt = if is_active {
        Event::UserRestart
    } else {
        Event::UserStart
    };
    crate::app::dispatch_event(&app, evt);
}

/// Start the daemon (if not already running). Idempotent.
#[tauri::command]
pub fn start_daemon(app: tauri::AppHandle, state: State<'_, AppState>) {
    if !state.controller.lock().unwrap().is_active() {
        crate::app::dispatch_event(&app, Event::UserStart);
    }
}

/// Stop the daemon. Idempotent.
#[tauri::command]
pub fn stop_daemon(app: tauri::AppHandle, state: State<'_, AppState>) {
    if state.controller.lock().unwrap().is_active() {
        crate::app::dispatch_event(&app, Event::UserStop);
    }
}

/// Open the daemon logs folder (`~/.bb-browser/logs/`) in Explorer.
#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let home = dirs_home();
    let path = home.join(".bb-browser").join("logs");
    // Best-effort: create the dir so opening doesn't fail on first run.
    let _ = std::fs::create_dir_all(&path);
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Open (or focus) the control panel window.
#[tauri::command]
pub fn open_control_panel(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("control-panel") else {
        return Err("控制面板窗口未注册".to_string());
    };
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Quit the application (cleanly killing the daemon first).
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle, state: State<'_, AppState>) {
    state.runner.kill();
    app.exit(0);
}

/// Read current autostart state.
#[tauri::command]
pub fn get_autostart() -> bool {
    bb_browser_tray::autostart::is_enabled()
}

/// Enable or disable autostart.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    bb_browser_tray::autostart::set_enabled(enabled)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve the user's home directory. Falls back to current dir on failure
/// (very unlikely on Windows).
fn dirs_home() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}
