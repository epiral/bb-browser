fn main() {
    // Only invoke tauri-build when the tauri-app feature is active.
    // For pure-logic library tests, we skip it entirely.
    #[cfg(feature = "tauri-app")]
    tauri_build::build();
}
