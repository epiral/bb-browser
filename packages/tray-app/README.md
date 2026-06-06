# @bb-browser/tray-app

Windows system tray daemon UI for bb-browser.

## Architecture

A **Tauri v2** application that owns the Windows tray presence and supervises the bb-browser daemon (Node subprocess).

```
packages/tray-app/
├── src-tauri/                       # Rust crate
│   ├── Cargo.toml
│   ├── build.rs
│   ├── src/
│   │   ├── lib.rs                   # Library root — all testable logic
│   │   ├── port_discovery.rs        # Dual port allocation (even / odd chains)
│   │   ├── daemon_config.rs         # ~/.bb-browser/daemon.json read/write
│   │   ├── restart_policy.rs        # 3-crashes-in-5-min sliding window
│   │   ├── supervisor.rs            # State machine: Stopped→Starting→Running→…
│   │   ├── tray_state.rs            # (daemon, CDP) → (color, tooltip)
│   │   ├── daemon_spawner.rs        # Node subprocess + READY parsing
│   │   └── main.rs                  # Tauri shell (behind `tauri-app` feature)
│   └── tests/
│       └── spawn_integration.rs     # Integration tests using `node -e`
└── src/                             # Frontend (WebView2) — minimal HTML/CSS/JS
    ├── index.html
    ├── styles.css
    └── main.js
```

## Phase 1 Scope

### Done (TDD)

- [x] Port discovery algorithm — even/odd dual chains, parity-checked, fall-back on EADDRINUSE
- [x] Daemon config (daemon.json) — schema versioning, atomic writes, round-trip tests
- [x] Restart policy — sliding-window crash budget, deterministic clock for tests
- [x] Supervisor state machine — full transition matrix covered
- [x] Tray status calculator — every (daemon, CDP) combination → color
- [x] Daemon spawner — subprocess lifecycle, READY parsing, timeout, idempotent kill

### Next

- [ ] Tauri tray-icon + menu wiring (UI surface — manual smoke testing)
- [ ] WebView2 popup window — content + Acrylic styling
- [ ] Toast notifications (Windows 11 native)
- [ ] Right-click context menu
- [ ] Wire daemon to emit `BB_DAEMON_READY <json>` on stdout

See [docs/system-tray-design.md](../../docs/system-tray-design.md) §5–10 for the full UI design.

## Build & Test

The library crate (`src-tauri/src/lib.rs`) has no Tauri dependency, so unit tests run without a GUI toolchain:

```bash
cd packages/tray-app/src-tauri
cargo test --lib              # ~50 unit tests
cargo test --test spawn_integration   # integration tests (need `node` on PATH)
```

Building the actual Tauri binary requires the `tauri-app` feature (and the MSVC or MinGW toolchain):

```bash
cargo build --features tauri-app --release
```

For development with hot reload:

```bash
cd packages/tray-app
pnpm install
pnpm dev
```

## Module Reference

| Module | Purpose | Test count |
|--------|---------|-----------:|
| `port_discovery` | Find a free even/odd port pair | 11 |
| `daemon_config` | Persist daemon settings to disk | 9 |
| `restart_policy` | Decide whether to restart after a crash | 8 |
| `supervisor` | State machine driving daemon lifecycle | 11 |
| `tray_state` | Compute icon color + tooltip text | 11 |
| `daemon_spawner` | Spawn Node subprocess, parse READY | 4 unit + 6 integration |

## References

- Design spec: [docs/system-tray-design.md](../../docs/system-tray-design.md)
- Deferred features: [docs/system-tray-future.md](../../docs/system-tray-future.md)
- Decisions: [docs/system-tray-design.md §14](../../docs/system-tray-design.md)
