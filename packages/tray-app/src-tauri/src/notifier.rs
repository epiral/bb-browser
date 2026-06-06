//! Toast notification helpers.
//!
//! Wraps `tauri-plugin-notification` to surface the five MVP scenarios
//! defined in docs/system-tray-design.md §6.1:
//!
//! 1. Port fallback   — `daemon 改用端口 N（M 被占用）`
//! 2. Auto-restart    — `daemon 已自动重启（第 N 次）`
//! 3. CDP dropped 30s — `Chrome 调试连接已断开 30 秒`
//! 4. Give up         — `daemon 5 分钟内崩溃 3 次，已暂停自动重启`
//! 5. (M2+)           — Long operation done (Trace export, etc.)
//!
//! Cross-platform: on Win11 these go through the native ToastNotification
//! API; on Win10 the plugin falls back to a balloon. Both honor the
//! user's system "do not disturb" / Focus Assist setting.

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

/// Compile-time toggle for whether the user has enabled notifications.
/// MVP holds this in memory; persistence comes later.
pub fn notifications_enabled(app: &AppHandle) -> bool {
    let state = app.state::<crate::app::AppState>();
    let guard = state.notifications_enabled.lock().unwrap();
    *guard
}

/// Send a one-shot toast. `title` shows bold; `body` is the main message.
fn send(app: &AppHandle, title: &str, body: &str) {
    if !notifications_enabled(app) {
        eprintln!("[toast] suppressed (user disabled): {title} — {body}");
        return;
    }
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        eprintln!("[toast] failed to show notification: {e}");
    }
}

// ---------------------------------------------------------------------------
// Scenario-specific helpers
// ---------------------------------------------------------------------------

/// §6.1 scenario 1 — daemon ended up on a different port than requested.
pub fn port_fallback(app: &AppHandle, original: u16, used: u16) {
    send(
        app,
        "bb-browser · 端口已切换",
        &format!("daemon 改用端口 {used}（{original} 被占用）"),
    );
}

/// §6.1 scenario 2 — supervisor auto-restarted after a crash.
pub fn auto_restart(app: &AppHandle, count: usize) {
    send(
        app,
        "bb-browser · daemon 已重启",
        &format!("daemon 已自动重启（第 {count} 次）"),
    );
}

/// §6.1 scenario 3 — Chrome / CDP has been unreachable for ≥30s.
pub fn cdp_disconnected(app: &AppHandle) {
    send(
        app,
        "bb-browser · Chrome 连接断开",
        "Chrome 调试连接已断开 30 秒。检查 Chrome 是否还在运行。",
    );
}

/// §6.1 scenario 4 — supervisor gave up after repeated crashes.
pub fn gave_up(app: &AppHandle, crashes: usize) {
    send(
        app,
        "bb-browser · 已暂停自动重启",
        &format!(
            "daemon 5 分钟内崩溃 {crashes} 次，已暂停自动重启。\
             右键托盘 → 重启 daemon 可手动重启。"
        ),
    );
}
