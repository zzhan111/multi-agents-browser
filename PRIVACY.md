# Privacy Policy — ma-browser

**Last updated:** 2026-03-14

## What ma-browser does

ma-browser is a browser automation tool that lets AI agents control your Chrome browser via the Chrome DevTools Protocol (CDP). It consists of a CLI, an MCP server, a local HTTP daemon, and a Chrome extension.

## Data handling

All communication happens **locally on your machine**:

```
AI Agent ↔ CLI/MCP ↔ localhost:19824 (daemon) ↔ Chrome Extension
```

**No data is sent to any external server.** There is no telemetry, no analytics, no cloud service.

## What data is accessed

When you use ma-browser, the extension may access the following data **locally**:

| Data type | How it's used | Stored? |
|-----------|---------------|---------|
| **Tab URLs and titles** | To list and route commands to the correct tab | In memory only, cleared on extension restart |
| **Page content** | Snapshot (accessibility tree) and eval commands read page DOM | Not stored, returned to local CLI/MCP only |
| **Authentication state** | Fetch commands use the browser's existing cookies/sessions | Not accessed directly, browser handles this natively |
| **User activity** | Trace feature records clicks, keystrokes, and scrolling for replay | In memory only, cleared on stop |
| **Network requests** | Network monitoring captures request/response data | In memory only, bounded buffer, cleared on tab close |

## What data is NOT collected

- No personally identifiable information
- No browsing history is recorded or persisted
- No data is transmitted to external servers
- No analytics or telemetry
- No cookies or credentials are extracted or stored

## Data retention

All data exists only in memory during the browser session. No data is written to disk by the extension. When the extension is unloaded or the browser is closed, all data is gone.

## Third parties

ma-browser does not share any data with third parties. The extension communicates exclusively with a daemon process running on localhost.

## Open source

ma-browser is fully open source. You can audit the code at:
https://github.com/zzhan111/multi-agents-browser

## Contact

For privacy questions, open an issue at:
https://github.com/zzhan111/multi-agents-browser/issues
