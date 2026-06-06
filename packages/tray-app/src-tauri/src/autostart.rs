//! Windows 开机自启 — 读写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run
//!
//! 只在 Windows 上编译；其他平台的 stub 始终返回 `false` / 不做任何事。

#[cfg(windows)]
mod inner {
    use std::path::PathBuf;

    const REG_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APP_NAME: &str = "bb-browser-tray";

    /// Read the HKCU Run key and return true if our entry is present.
    pub fn is_enabled() -> bool {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(REG_KEY) else {
            return false;
        };
        hkcu.get_value::<String, _>(APP_NAME).is_ok()
    }

    /// Set or remove the autostart entry.
    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey_with_flags(REG_KEY, KEY_SET_VALUE)
            .map_err(|e| format!("Cannot open Run registry key: {e}"))?;

        if enabled {
            let exe = current_exe()?;
            key.set_value(APP_NAME, &exe)
                .map_err(|e| format!("Cannot write autostart entry: {e}"))
        } else {
            // Ignore "not found" — deleting a nonexistent value is a no-op.
            match key.delete_value(APP_NAME) {
                Ok(()) | Err(_) => Ok(()),
            }
        }
    }

    fn current_exe() -> Result<String, String> {
        std::env::current_exe()
            .map(|p: PathBuf| p.to_string_lossy().into_owned())
            .map_err(|e| format!("Cannot resolve current exe path: {e}"))
    }
}

// ---------------------------------------------------------------------------
// Public API (platform-agnostic stubs for non-Windows builds)
// ---------------------------------------------------------------------------

/// Returns `true` when the tray app is registered to run at login.
pub fn is_enabled() -> bool {
    #[cfg(windows)]
    return inner::is_enabled();
    #[cfg(not(windows))]
    false
}

/// Enable or disable autostart. Returns an error string on failure.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    return inner::set_enabled(enabled);
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(())
    }
}
