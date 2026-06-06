//! bb-browser tray-app library crate.
//!
//! Most logic lives here so it is unit-testable without spinning up Tauri.
//! `main.rs` is a thin entry that wires this library into the Tauri shell.

pub mod autostart;
pub mod controller;
pub mod daemon_config;
pub mod daemon_spawner;
pub mod port_discovery;
pub mod restart_policy;
pub mod supervisor;
pub mod tray_state;
