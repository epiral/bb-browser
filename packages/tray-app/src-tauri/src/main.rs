// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "tauri-app")]
mod app;
#[cfg(feature = "tauri-app")]
mod commands;
#[cfg(feature = "tauri-app")]
mod daemon_runner;
#[cfg(feature = "tauri-app")]
mod notifier;

#[cfg(feature = "tauri-app")]
fn main() {
    app::run();
}

#[cfg(not(feature = "tauri-app"))]
fn main() {
    eprintln!(
        "bb-browser-tray was built without the `tauri-app` feature. \
         Rebuild with `cargo build --features tauri-app` to produce the GUI binary."
    );
    std::process::exit(2);
}
