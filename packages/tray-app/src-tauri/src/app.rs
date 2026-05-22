//! Tauri application shell.
//!
//! This module is only compiled with `--features tauri-app`. It wires the
//! pure-logic library (`bb_browser_tray::*`) into the Tauri runtime:
//!
//! - Phase 2.1: bootstrap the Tauri app + register a tray icon
//! - Phase 2.2: 3-color PNG icons
//! - Phase 2.3: hook supervisor state → icon color updates
//! - **Phase 2.4 (this file)**: full right-click menu per design §5.1
//!   — 5 groups, dynamic start/stop, settings submenu, status row
//! - Phase 2.5+: popup window, IPC, Toast, daemon integration

use std::sync::Mutex;

use bb_browser_tray::controller::TrayController;
use bb_browser_tray::supervisor::{Event, SupervisorAction};
use bb_browser_tray::tray_state::{CdpState, TrayColor};

use crate::daemon_runner::DaemonRunner;
use crate::notifier;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

// ---------------------------------------------------------------------------
// Menu item IDs — keep these in sync with build_menu() + handle_menu_event()
// ---------------------------------------------------------------------------

const ID_STATUS_ROW: &str = "status_row";
const ID_TOGGLE_DAEMON: &str = "toggle_daemon";
const ID_RESTART: &str = "restart";
const ID_OPEN_LOGS: &str = "open_logs";
const ID_DIAGNOSTICS: &str = "diagnostics";
const ID_AUTOSTART: &str = "set_autostart";
const ID_PORTS: &str = "set_ports";
const ID_BROWSER_PATH: &str = "set_browser_path";
const ID_NOTIFICATIONS: &str = "set_notifications";
const ID_ABOUT: &str = "about";
const ID_QUIT: &str = "quit";

// Debug submenu — temporary, removed after Phase 2.8.
const ID_DBG_START: &str = "dbg_start";
const ID_DBG_READY: &str = "dbg_ready";
const ID_DBG_CDP_OK: &str = "dbg_cdp_ok";
const ID_DBG_CDP_RETRY: &str = "dbg_cdp_retry";
const ID_DBG_CDP_DEAD: &str = "dbg_cdp_dead";
const ID_DBG_CRASH: &str = "dbg_crash";
const ID_DBG_STOP: &str = "dbg_stop";

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Wrapped runtime state, stored in Tauri's state manager.
pub struct AppState {
    pub controller: Mutex<TrayController>,
    /// Handles to the menu items that need to be updated on state changes.
    /// Set in `setup_tray` after the menu is built.
    pub menu_handles: Mutex<Option<MenuHandles>>,
    /// User's Toast notification preference (toggled via settings menu).
    pub notifications_enabled: Mutex<bool>,
    /// Wraps the real Node subprocess. `process_action` calls `.spawn()`
    /// when the supervisor asks for a daemon launch.
    pub runner: DaemonRunner,
}

/// Cloneable handles to dynamic menu items (each `MenuItem<Wry>` wraps an
/// Arc internally, so cloning is cheap).
pub struct MenuHandles {
    pub status_row: MenuItem<tauri::Wry>,
    pub toggle_daemon: MenuItem<tauri::Wry>,
    pub restart: MenuItem<tauri::Wry>,
}

/// Entry point invoked by `main.rs`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            controller: Mutex::new(TrayController::new()),
            menu_handles: Mutex::new(None),
            notifications_enabled: Mutex::new(true),
            runner: DaemonRunner::new(),
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::get_status,
            crate::commands::copy_text,
            crate::commands::restart_daemon,
            crate::commands::start_daemon,
            crate::commands::stop_daemon,
            crate::commands::open_logs_folder,
            crate::commands::open_control_panel,
            crate::commands::quit_app,
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            apply_popup_effects(app.handle());
            refresh_tray(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                if window.label() == "popup" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Apply Desktop Acrylic to the popup window (per design §13).
/// On Win10 < 1903 or when transparency is disabled, this gracefully
/// degrades to the CSS fallback color in `styles.css`.
fn apply_popup_effects(app: &AppHandle) {
    use tauri::window::{Effect, EffectsBuilder};
    let Some(window) = app.get_webview_window("popup") else {
        return;
    };
    let effects = EffectsBuilder::new().effect(Effect::Acrylic).build();
    if let Err(e) = window.set_effects(effects) {
        // Expected on Win10 < 1903; just log and let CSS fallback handle it.
        eprintln!("[popup] Acrylic effect not applied: {e}");
    }
}

// ---------------------------------------------------------------------------
// Menu construction
// ---------------------------------------------------------------------------

/// Build the full right-click menu per design §5.1.
///
/// Layout:
/// ```
/// 状态: {snapshot.status_text} [· :{port}]    (disabled, gray)
/// ───
/// 启动 daemon  /  停止 daemon                  (toggle)
/// 重启 daemon                                  Ctrl+R
/// ───
/// 打开日志文件夹                                Ctrl+L
/// 故障诊断 (M2+)                                (disabled)
/// ───
/// 设置 ▸
///   ☐ 开机自启
///   端口配置...
///   浏览器路径...
///   ☑ 通知开关
/// 调试 / 状态模拟 ▸                          [Phase 2.3 临时]
/// ───
/// 关于 bb-browser
/// 退出                                          Ctrl+Q
/// ```
fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<tauri::Wry>, MenuHandles)> {
    // --- Group 1: status row (disabled, just for display) ---
    let status_row =
        MenuItem::with_id(app, ID_STATUS_ROW, "状态: 未运行", false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    // --- Group 2: daemon control ---
    let toggle_daemon = MenuItem::with_id(
        app,
        ID_TOGGLE_DAEMON,
        "启动 daemon",
        true,
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(app, ID_RESTART, "重启 daemon", false, Some("Ctrl+R"))?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    // --- Group 3: logs + diagnostics ---
    let open_logs =
        MenuItem::with_id(app, ID_OPEN_LOGS, "打开日志文件夹", true, Some("Ctrl+L"))?;
    let diagnostics = MenuItem::with_id(
        app,
        ID_DIAGNOSTICS,
        "故障诊断 → 导出诊断报告 (M2+)",
        false,
        None::<&str>,
    )?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    // --- Group 4: settings submenu ---
    let autostart = CheckMenuItem::with_id(
        app,
        ID_AUTOSTART,
        "开机自启",
        true,
        false,
        None::<&str>,
    )?;
    let ports = MenuItem::with_id(app, ID_PORTS, "端口配置...", true, None::<&str>)?;
    let browser_path =
        MenuItem::with_id(app, ID_BROWSER_PATH, "浏览器路径...", true, None::<&str>)?;
    let notifications = CheckMenuItem::with_id(
        app,
        ID_NOTIFICATIONS,
        "通知开关",
        true,
        true,
        None::<&str>,
    )?;
    let settings_submenu = Submenu::with_items(
        app,
        "设置",
        true,
        &[&autostart, &ports, &browser_path, &notifications],
    )?;

    // --- Group 4b: debug submenu (TEMPORARY — Phase 2.3 manual driver) ---
    let dbg_start = MenuItem::with_id(app, ID_DBG_START, "→ UserStart", true, None::<&str>)?;
    let dbg_ready =
        MenuItem::with_id(app, ID_DBG_READY, "→ DaemonReady (port=19826)", true, None::<&str>)?;
    let dbg_cdp_ok =
        MenuItem::with_id(app, ID_DBG_CDP_OK, "→ CDP Connected", true, None::<&str>)?;
    let dbg_cdp_retry = MenuItem::with_id(
        app,
        ID_DBG_CDP_RETRY,
        "→ CDP Reconnecting",
        true,
        None::<&str>,
    )?;
    let dbg_cdp_dead = MenuItem::with_id(
        app,
        ID_DBG_CDP_DEAD,
        "→ CDP Disconnected",
        true,
        None::<&str>,
    )?;
    let dbg_crash = MenuItem::with_id(
        app,
        ID_DBG_CRASH,
        "→ DaemonExited (crash)",
        true,
        None::<&str>,
    )?;
    let dbg_stop = MenuItem::with_id(app, ID_DBG_STOP, "→ UserStop", true, None::<&str>)?;
    let debug_submenu = Submenu::with_items(
        app,
        "调试 / 状态模拟 (Phase 2.3 临时)",
        true,
        &[
            &dbg_start,
            &dbg_ready,
            &dbg_cdp_ok,
            &dbg_cdp_retry,
            &dbg_cdp_dead,
            &dbg_crash,
            &dbg_stop,
        ],
    )?;
    let sep4 = PredefinedMenuItem::separator(app)?;

    // --- Group 5: about / quit ---
    let about = MenuItem::with_id(app, ID_ABOUT, "关于 bb-browser", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出", true, Some("Ctrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &status_row,
            &sep1,
            &toggle_daemon,
            &restart,
            &sep2,
            &open_logs,
            &diagnostics,
            &sep3,
            &settings_submenu,
            &debug_submenu,
            &sep4,
            &about,
            &quit,
        ],
    )?;
    let handles = MenuHandles {
        status_row,
        toggle_daemon,
        restart,
    };
    Ok((menu, handles))
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let (menu, handles) = build_menu(app)?;
    let icon = load_tray_icon(app, "red");

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("bb-browser · 未运行")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_icon_event)
        .build(app)?;

    // Stash menu handles so refresh_tray can update them.
    let state = app.state::<AppState>();
    *state.menu_handles.lock().unwrap() = Some(handles);

    Ok(())
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id.as_ref();
    eprintln!("[tray] menu: {id}");

    match id {
        // --- Daemon control ---
        ID_TOGGLE_DAEMON => {
            dispatch_toggle(app);
            return; // dispatch_toggle already refreshed
        }
        ID_RESTART => {
            let is_active = {
                let state = app.state::<AppState>();
                let c = state.controller.lock().unwrap();
                c.is_active()
            };
            let evt = if is_active {
                Event::UserRestart
            } else {
                Event::UserStart
            };
            dispatch_event(app, evt);
            return;
        }

        // --- Logs / diagnostics ---
        ID_OPEN_LOGS => {
            if let Err(e) = crate::commands::open_logs_folder(app.clone()) {
                eprintln!("[tray] open_logs_folder failed: {e}");
            }
        }

        // --- Settings ---
        ID_AUTOSTART => {
            eprintln!("[tray] toggle autostart (TODO Phase MVP2)");
        }
        ID_PORTS => eprintln!("[tray] open port config (TODO MVP2)"),
        ID_BROWSER_PATH => eprintln!("[tray] open browser path picker (TODO MVP2)"),
        ID_NOTIFICATIONS => {
            // Flip the in-memory preference; CheckMenuItem state stays in
            // sync via the menu auto-toggle.
            let state = app.state::<AppState>();
            let mut enabled = state.notifications_enabled.lock().unwrap();
            *enabled = !*enabled;
            eprintln!("[tray] notifications -> {}", *enabled);
            // Fire a sample toast so the user has feedback (only if enabling).
            if *enabled {
                drop(enabled);
                notifier::auto_restart(app, 0); // demo toast: "已自动重启（第 0 次）"
            }
        }

        // --- About / quit ---
        ID_ABOUT => eprintln!("[tray] about (TODO MVP2)"),
        ID_QUIT => {
            // Kill the daemon cleanly before exiting.
            let state = app.state::<AppState>();
            state.runner.kill();
            app.exit(0);
            return;
        }

        // --- Debug state simulation (TEMPORARY — removed in Phase 2.8) ---
        ID_DBG_START => {
            dispatch_event(app, Event::UserStart);
            return;
        }
        ID_DBG_READY => {
            // First flip state to Running, then seed identity for the
            // popup demo.
            {
                let state = app.state::<AppState>();
                let mut c = state.controller.lock().unwrap();
                c.handle_event(Event::DaemonReady);
                c.set_daemon_identity(19826, 19827, "0d50a5e3demo".into());
            }
            refresh_tray(app);
            return;
        }
        ID_DBG_CDP_OK => {
            let state = app.state::<AppState>();
            let mut c = state.controller.lock().unwrap();
            c.set_cdp_state(CdpState::Connected);
        }
        ID_DBG_CDP_RETRY => {
            let state = app.state::<AppState>();
            let mut c = state.controller.lock().unwrap();
            c.set_cdp_state(CdpState::Reconnecting);
        }
        ID_DBG_CDP_DEAD => {
            let state = app.state::<AppState>();
            let mut c = state.controller.lock().unwrap();
            c.set_cdp_state(CdpState::Disconnected);
        }
        ID_DBG_CRASH => {
            dispatch_event(
                app,
                Event::DaemonExited {
                    now_ms: now_ms(),
                    during_startup: false,
                },
            );
            return;
        }
        ID_DBG_STOP => {
            {
                let state = app.state::<AppState>();
                let mut c = state.controller.lock().unwrap();
                c.handle_event(Event::UserStop);
                c.set_daemon_port(None);
                c.set_cdp_port(None);
                c.set_token(None);
            }
            refresh_tray(app);
            return;
        }

        _ => {}
    }

    refresh_tray(app);
}

fn handle_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    let app = tray.app_handle();
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            rect,
            ..
        } => {
            let Some(window) = app.get_webview_window("popup") else {
                eprintln!("[tray] popup window not registered (check tauri.conf.json)");
                return;
            };
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
            } else {
                position_popup_near_tray(&window, &rect);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        TrayIconEvent::Click {
            button: MouseButton::Middle,
            button_state: MouseButtonState::Up,
            ..
        } => {
            dispatch_toggle(app);
        }
        _ => {}
    }
}

/// Position the popup adjacent to the tray icon, biased away from the
/// task bar. Falls back gracefully if monitor info isn't available.
///
/// Windows task bars sit at the bottom by default — we put the popup
/// above the icon. If there isn't enough room above, we put it below.
fn position_popup_near_tray(window: &tauri::WebviewWindow, rect: &tauri::Rect) {
    use tauri::{LogicalSize, PhysicalPosition};

    let Ok(monitor) = window.current_monitor() else {
        return;
    };
    let Some(monitor) = monitor else { return };

    let scale = monitor.scale_factor();
    let mon_size = monitor.size();
    let mon_pos = monitor.position();

    // Tray icon position + size (physical px).
    let icon_pos: tauri::PhysicalPosition<i32> = rect.position.to_physical(scale);
    let icon_size: tauri::PhysicalSize<u32> = rect.size.to_physical(scale);
    let icon_x = icon_pos.x;
    let icon_y = icon_pos.y;
    let icon_w = icon_size.width as i32;
    let icon_h = icon_size.height as i32;

    // Popup size in physical pixels.
    let popup_w = (360.0 * scale) as i32;
    let popup_h = (360.0 * scale) as i32;
    let margin = (8.0 * scale) as i32;

    // Default: put popup ABOVE icon (Windows task bar usually at bottom).
    let mut x = icon_x + icon_w / 2 - popup_w / 2;
    let mut y = icon_y - popup_h - margin;

    // If above doesn't fit on screen, put below.
    if y < mon_pos.y {
        y = icon_y + icon_h + margin;
    }

    // Clamp horizontally to monitor.
    let max_x = mon_pos.x + (mon_size.width as i32) - popup_w - margin;
    let min_x = mon_pos.x + margin;
    x = x.clamp(min_x, max_x);

    let _ = window.set_size(LogicalSize::new(360.0, 360.0));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

// ---------------------------------------------------------------------------
// Tray visual updates (icon + tooltip + menu state)
// ---------------------------------------------------------------------------

/// Repaint the tray icon + tooltip + dynamic menu items from the
/// controller's current snapshot.
fn refresh_tray(app: &AppHandle) {
    // Snapshot under lock, then drop the lock before touching Tauri APIs.
    let (snapshot, status_row_text, toggle_label, is_active) = {
        let state = app.state::<AppState>();
        let c = state.controller.lock().unwrap();
        (
            c.snapshot(),
            c.status_row(),
            c.toggle_label(),
            c.is_active(),
        )
    };

    let color = match snapshot.color {
        TrayColor::Green => "green",
        TrayColor::Yellow => "yellow",
        TrayColor::Red => "red",
    };
    eprintln!(
        "[tray] refresh: color={color}, tooltip={:?}, status={status_row_text:?}",
        snapshot.tooltip
    );

    let Some(tray) = app.tray_by_id("main-tray") else {
        eprintln!("[tray] refresh: tray not registered yet");
        return;
    };

    // Icon + tooltip.
    let icon = load_tray_icon(app, color);
    if let Err(e) = tray.set_icon(Some(icon)) {
        eprintln!("[tray] set_icon failed: {e}");
    }
    if let Err(e) = tray.set_tooltip(Some(&snapshot.tooltip)) {
        eprintln!("[tray] set_tooltip failed: {e}");
    }

    // Update dynamic menu items via the cached handles.
    let state = app.state::<AppState>();
    let guard = state.menu_handles.lock().unwrap();
    if let Some(handles) = guard.as_ref() {
        if let Err(e) = handles.status_row.set_text(&status_row_text) {
            eprintln!("[tray] set_text(status_row) failed: {e}");
        }
        if let Err(e) = handles.toggle_daemon.set_text(toggle_label) {
            eprintln!("[tray] set_text(toggle_daemon) failed: {e}");
        }
        // Restart only makes sense when daemon is active.
        if let Err(e) = handles.restart.set_enabled(is_active) {
            eprintln!("[tray] set_enabled(restart) failed: {e}");
        }
    }
    drop(guard);

    // Notify the popup so it re-fetches via get_status().
    if let Err(e) = app.emit("state-changed", ()) {
        eprintln!("[tray] emit(state-changed) failed: {e}");
    }
}

/// Public re-export used by `commands.rs` to repaint the tray after IPC
/// commands mutate state.
pub fn refresh_tray_public(app: &AppHandle) {
    refresh_tray(app);
}

/// Inspect a `SupervisorAction` and:
///  - surface any matching Toast notifications (design §6.1)
///  - drive the real daemon subprocess via `DaemonRunner`
pub fn process_action(app: &AppHandle, action: SupervisorAction) {
    match action {
        SupervisorAction::Spawn { restart_count } => {
            if let Some(n) = restart_count {
                notifier::auto_restart(app, n);
            }
            // Tell the runner to (re)spawn the Node daemon.
            let state = app.state::<AppState>();
            state.runner.spawn(app.clone());
        }
        SupervisorAction::NotifyGaveUp { crash_count } => {
            notifier::gave_up(app, crash_count);
            // After giving up, make sure no zombie process lingers.
            let state = app.state::<AppState>();
            state.runner.kill();
        }
        SupervisorAction::Wait => {}
    }
}

/// Dispatch a single `Event` through the supervisor, fire any resulting
/// toast / spawn / kill, then repaint the tray + popup. Used by every
/// menu handler / IPC command that drives state.
pub fn dispatch_event(app: &AppHandle, event: Event) {
    // UserStop needs special handling — supervisor only sets state to
    // Stopped + returns Wait, so process_action wouldn't kill the runner.
    let kill_on_stop = matches!(event, Event::UserStop);

    let action = {
        let state = app.state::<AppState>();
        let mut c = state.controller.lock().unwrap();
        c.handle_event(event)
    };
    process_action(app, action);

    if kill_on_stop {
        let state = app.state::<AppState>();
        state.runner.kill();
        let mut c = state.controller.lock().unwrap();
        c.set_daemon_port(None);
        c.set_cdp_port(None);
        c.set_token(None);
    }
    refresh_tray(app);
}

/// Same as `dispatch_event`, but uses the controller's smart toggle.
pub fn dispatch_toggle(app: &AppHandle) {
    // Reproduce toggle's event selection so we can decide whether to kill.
    let (action, was_active) = {
        let state = app.state::<AppState>();
        let mut c = state.controller.lock().unwrap();
        let was_active = c.is_active();
        (c.toggle(), was_active)
    };
    if let Some(a) = action {
        process_action(app, a);
    }
    if was_active {
        // We just transitioned active → stopped; kill any running daemon.
        let state = app.state::<AppState>();
        state.runner.kill();
        let mut c = state.controller.lock().unwrap();
        c.set_daemon_port(None);
        c.set_cdp_port(None);
        c.set_token(None);
    }
    refresh_tray(app);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn load_tray_icon(app: &AppHandle, color: &str) -> Image<'static> {
    let path = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join(format!("icons/tray-{color}.png")))
        .filter(|p| p.exists())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .join("icons")
                .join(format!("tray-{color}.png"))
        });

    Image::from_path(&path).unwrap_or_else(|e| {
        eprintln!("[tray] failed to load icon {path:?}: {e}");
        Image::new_owned(vec![0, 0, 0, 0], 1, 1)
    })
}
