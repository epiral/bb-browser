# Privacy Policy — bb-browser

**Last updated:** 2026-06-01

## What bb-browser does

bb-browser is a browser automation tool that lets AI agents control your Chrome browser via the Chrome DevTools Protocol (CDP). It consists of a CLI and a local HTTP daemon. In Hub mode, the daemon can also register with Pinix Hub so remote clients can invoke the same commands.

## Data handling

All communication happens **locally on your machine**:

```
AI Agent ↔ CLI ↔ localhost:19824 (daemon) ↔ Chrome CDP
```

In local CLI mode, no browser data is sent to any external server. There is no telemetry or analytics. In Hub mode, command requests and responses flow through the configured Hub endpoint because that mode is explicitly remote.

## What data is accessed

When you use bb-browser, the daemon may access the following data:

| Data type | How it's used | Stored? |
|-----------|---------------|---------|
| **Tab URLs and titles** | To list and route commands to the correct tab | In memory only, cleared on daemon restart |
| **Page content** | Snapshot (accessibility tree) and eval commands read page DOM | Not stored, returned to the CLI or Hub caller |
| **Authentication state** | Fetch commands use the browser's existing cookies/sessions | Not accessed directly, browser handles this natively |
| **User activity** | Trace feature records clicks, keystrokes, and scrolling for replay | In memory only, cleared on stop |
| **Network requests** | Network monitoring captures request/response data | In memory only, bounded buffer, cleared on tab close |

## What data is NOT collected

- No personally identifiable information
- No browsing history is recorded or persisted
- No data is transmitted to external servers in local CLI mode
- No analytics or telemetry
- No cookies or credentials are extracted or stored

## Data retention

Browser data exists only in memory during the daemon session. When the daemon or browser is closed, in-memory tab state and event buffers are gone.

## Third parties

In local CLI mode, bb-browser does not share data with third parties. In Hub mode, the daemon communicates with the Hub endpoint you configured.

## Open source

bb-browser is fully open source. You can audit the code at:
https://github.com/epiral/bb-browser

## Contact

For privacy questions, open an issue at:
https://github.com/epiral/bb-browser/issues
