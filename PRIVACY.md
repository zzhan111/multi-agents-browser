# ma-browser privacy and security

ma-browser is a local browser-control tool. Commands are sent to a daemon on
the same machine and then to the real Chrome tab; there is no cloud relay or
default telemetry collection.

## Local daemon

- The HTTP daemon binds to `127.0.0.1` by default. Binding to a LAN address or
  `0.0.0.0` is an explicit opt-in (`--host` for standalone use, or
  `BB_DAEMON_BIND_HOST` for the tray) and is shown as a yellow tray warning.
- Bearer authentication is required for daemon endpoints. CORS is disabled by
  default; `BB_CORS_ORIGINS` enables an exact comma-separated origin allowlist.
  Preflight requests do not bypass authentication.
- `GET /ping` is a secret-free health check and returns only `{ "pong": true }`.
  It never returns the bearer token. The token is stored in
  `$BB_BROWSER_HOME/daemon.json` (or `~/.bb-browser/daemon.json`) with mode
  `0600`, and is not emitted in `BB_DAEMON_READY` or daemon logs.
- The tray is the daemon owner. When `daemon.json` exists, CLI and MCP clients
  connect to it and do not start a competing daemon.

## Agent sessions

Every client sends an `X-BB-Session` identifier. Sessions default to
`no-eval`; `full` must be explicitly requested. `eval`, `site_run`, and trace
start are privileged operations. `site_run` executes the adapter against the
matching real browser tab, so that tab's cookies and page state are used.

## Data and files

Site adapters run locally. Community-adapter updates are user-triggered and
their code should be reviewed before use. Screenshots are written locally
under `$BB_BROWSER_HOME/screenshots` unless an explicit output path is given.
Command history, journals, and vault data remain in the configured local
state directory.

## Detailed data handling

ma-browser is a browser automation tool that lets AI agents control Chrome via
the Chrome DevTools Protocol (CDP). All communication happens locally:

```
AI Agent ↔ CLI/MCP ↔ localhost:19824 (daemon) ↔ Chrome
```

No data is sent to an external server by the daemon. There is no telemetry,
analytics, or cloud service built into ma-browser.

The local runtime may access tab URLs and titles, page content, authentication
state already held by Chrome, trace events, and bounded network/console/error
buffers in order to perform the requested command. Page content and command
results are returned only to the local CLI/MCP caller. Cookies and credentials
are not extracted by ma-browser; browser requests use Chrome's existing login
state.

Data may remain locally in bounded command history, journals, vault databases,
adapter state, and screenshot files according to the configured local state
directory. Review and remove those files if the machine is shared.

The project is open source at
https://github.com/zzhan111/multi-agents-browser. Privacy questions can be
raised through the project's issue tracker.
