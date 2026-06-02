//! Daemon subprocess lifecycle wrapper.
//!
//! Bridges the Rust supervisor state machine to a real `node packages/daemon`
//! subprocess. When the supervisor says `Spawn`, this module launches the
//! daemon, reads the `BB_DAEMON_READY` line from stdout, posts identity
//! back to the controller, and watches for the process to exit.
//!
//! Thread model:
//! - One watcher thread per spawn. Owns the `DaemonProcess`.
//! - Communicates back to the main app via `AppHandle::run_on_main_thread`
//!   (Tauri marshals to its event loop), which then calls
//!   `crate::app::dispatch_event`.

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use bb_browser_tray::daemon_config::{
    daemon_config_path, decide_reap, kill_process, read_config, remove_config,
};
use bb_browser_tray::daemon_spawner::{
    DaemonProcess, ReadyInfo, SpawnConfig, SpawnOutcome, DEFAULT_READY_TIMEOUT,
};
use bb_browser_tray::port_discovery::{
    find_even_port, OsPortChecker, DEFAULT_CDP_PORT, DEFAULT_DAEMON_PORT,
};
use bb_browser_tray::supervisor::Event;
use bb_browser_tray::tray_state::CdpState;
use tauri::{AppHandle, Manager};

/// Owns the side-band kill signal for the active daemon (if any). The
/// actual `DaemonProcess` lives on the watcher thread.
pub struct DaemonRunner {
    /// `Some(sender)` while a watcher is running; `None` when idle.
    kill_tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /// When true, the next spawn passes `BB_ALLOW_BROWSER_KILL=1` so the
    /// daemon may close a non-debuggable browser and relaunch it. Set after
    /// the user accepts the consent dialog; persists across auto-restarts.
    allow_browser_kill: std::sync::atomic::AtomicBool,
}

impl Default for DaemonRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl DaemonRunner {
    /// Grant (or revoke) consent to close the user's running browser on the
    /// next spawn. Sticky so it survives supervisor auto-restarts.
    pub fn set_allow_browser_kill(&self, allow: bool) {
        self.allow_browser_kill
            .store(allow, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn new() -> Self {
        Self {
            kill_tx: Mutex::new(None),
            allow_browser_kill: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Launch the daemon and start the lifecycle watcher. If a previous
    /// daemon is still running, kill it first.
    pub fn spawn(&self, app: AppHandle) {
        self.kill();

        // Reap any orphan daemon advertised in daemon.json before spawning. The
        // tray's own kill() only covers the process it tracks; an orphan from a
        // prior crash / manual launch / bb-daemon-run.bat keeps the port bound
        // AND runs a second SessionManager on the same Chrome, which would
        // silently break per-session tab isolation. See daemon_config::decide_reap.
        reap_orphan_daemon();

        let mut config = match build_spawn_config(&app) {
            Ok(c) => c,
            Err(msg) => {
                eprintln!("[runner] cannot build spawn config: {msg}");
                let app_clone = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::app::dispatch_event(
                        &app_clone,
                        Event::DaemonExited {
                            now_ms: now_ms(),
                            during_startup: true,
                        },
                    );
                });
                return;
            }
        };

        // If the user has consented to closing their browser, pass the gate
        // through to the daemon. Sticky across auto-restarts.
        if self
            .allow_browser_kill
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            config
                .env
                .push(("BB_ALLOW_BROWSER_KILL".into(), "1".into()));
            eprintln!("[runner] BB_ALLOW_BROWSER_KILL=1 (user consented to browser relaunch)");
        }

        let process = match DaemonProcess::spawn(&config) {
            Ok(p) => p,
            Err(e) => {
                // Primary was the bare name "node" (PATH search). If that
                // fails, retry with the absolute path resolved by `which`
                // (covers environments where PATH isn't inherited).
                eprintln!(
                    "[runner] daemon spawn failed: {e} | program={:?}; retrying with absolute node path",
                    config.program
                );
                let fallback = which::which("node").ok().map(|abs| {
                    let mut c = config.clone();
                    c.program = abs;
                    c
                });
                match fallback.as_ref().map(DaemonProcess::spawn) {
                    Some(Ok(p)) => {
                        eprintln!("[runner] fallback spawn with absolute node path succeeded");
                        p
                    }
                    other => {
                        if let Some(Err(e2)) = other {
                            eprintln!("[runner] fallback spawn also failed: {e2}");
                        } else {
                            eprintln!("[runner] no absolute node path available for fallback");
                        }
                        let app_clone = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            crate::app::dispatch_event(
                                &app_clone,
                                Event::DaemonExited {
                                    now_ms: now_ms(),
                                    during_startup: true,
                                },
                            );
                        });
                        return;
                    }
                }
            }
        };

        let (tx, rx) = std::sync::mpsc::channel::<()>();
        *self.kill_tx.lock().unwrap() = Some(tx);

        let app_clone = app.clone();
        let ready_timeout = config.ready_timeout;
        thread::spawn(move || {
            run_watcher(app_clone, process, ready_timeout, rx);
        });
    }

    /// Kill any currently-running daemon. Idempotent — silently no-ops if
    /// nothing is running.
    pub fn kill(&self) {
        if let Some(tx) = self.kill_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

// ---------------------------------------------------------------------------
// Orphan daemon reaping
// ---------------------------------------------------------------------------

/// Read daemon.json, and if it advertises a foreign pid, kill it and delete the
/// file so the fresh daemon starts from a clean slate (single global daemon).
/// Best-effort: every failure path is logged and swallowed so reaping never
/// blocks startup.
fn reap_orphan_daemon() {
    let path = match daemon_config_path() {
        Some(p) => p,
        None => return,
    };

    let config = match read_config(&path) {
        Ok(c) => c,
        // A corrupt / unsupported daemon.json still warrants removal so the new
        // daemon isn't read against stale data.
        Err(e) => {
            eprintln!("[runner] reap: unreadable daemon.json ({e}); removing it");
            let _ = remove_config(&path);
            return;
        }
    };

    let self_pid = std::process::id();
    match decide_reap(config.as_ref(), self_pid) {
        Some(pid) => {
            let killed = kill_process(pid);
            eprintln!("[runner] reap: killed orphan daemon pid={pid} (success={killed}); removing daemon.json");
            let _ = remove_config(&path);
        }
        None => {
            // Either no file, no pid, or it was our own pid — nothing to reap.
        }
    }
}

// ---------------------------------------------------------------------------
// Spawn config builder
// ---------------------------------------------------------------------------

/// Locate `node` + `packages/daemon/dist/index.js` and build a SpawnConfig.
///
/// Probes for a free even/odd port pair before launching — this lets the
/// daemon dodge already-bound ports (e.g. another bb-browser instance, or
/// Windows port reservations) without changing the daemon code.
fn build_spawn_config(app: &AppHandle) -> Result<SpawnConfig, String> {
    // Verify node is installed (clear error if not). We then spawn it by the
    // bare name "node" rather than this absolute path: Rust's Windows Command
    // resolution spuriously fails ("program not found") for absolute node
    // paths containing spaces (e.g. C:\Program Files\nodejs\node.exe), whereas
    // its PATH search for the bare name works reliably. The absolute path is
    // kept only as a cross-platform fallback (see DaemonRunner::spawn).
    let node_abs = which::which("node")
        .map_err(|e| format!("node not on PATH: {e}"))?;
    eprintln!("[runner] node on PATH: {node_abs:?} (exists={})", node_abs.exists());
    let daemon_entry = locate_daemon_entry(app)?;
    eprintln!(
        "[runner] resolved daemon entry: {daemon_entry:?} (exists={})",
        daemon_entry.exists()
    );

    // Only the daemon HTTP port is free-allocated. The CDP port is NOT a
    // port we allocate — it must point at where Chrome already listens, so we
    // pass the well-known default and let the Node daemon resolve it
    // (connect there → managed port file → launch a browser).
    let daemon = find_even_port(&OsPortChecker, DEFAULT_DAEMON_PORT)
        .map_err(|e| format!("daemon port discovery failed: {e:?}"))?;
    let cdp = DEFAULT_CDP_PORT;
    eprintln!("[runner] using daemon={daemon}, cdp={cdp}");

    // Node.js cannot run a main module given a Windows extended-length
    // ("verbatim") path like `\\?\Z:\Apps\...\index.js` — it fails with
    // `EISDIR: illegal operation on a directory, lstat 'Z:'`. Tauri's
    // `resource_dir()` returns exactly such a path, so strip the prefix.
    let entry_str = strip_verbatim_prefix(&daemon_entry.to_string_lossy());
    eprintln!("[runner] daemon entry (node arg): {entry_str}");

    Ok(SpawnConfig {
        program: PathBuf::from("node"),
        args: vec![
            entry_str,
            // Bind the wildcard address so agents inside WSL2 can reach the
            // daemon via the Windows host IP (WSL2's loopback is a separate
            // network namespace and can't dial Windows' 127.0.0.1). The daemon
            // still advertises loopback in daemon.json, and Bearer-token auth
            // gates the now-LAN-reachable port.
            "--host".into(),
            "0.0.0.0".into(),
            "--port".into(),
            daemon.to_string(),
            "--cdp-port".into(),
            cdp.to_string(),
        ],
        cwd: None,
        env: Vec::new(),
        ready_timeout: DEFAULT_READY_TIMEOUT,
    })
}

/// Strip a Windows extended-length path prefix (`\\?\` or `\\?\UNC\`) so the
/// result is a normal path Node.js can use as a main module. No-op on
/// non-prefixed paths and on non-Windows platforms.
fn strip_verbatim_prefix(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

/// Find `packages/daemon/dist/index.js`.
///
/// Strategy:
/// 1. In a packaged install: `resource_dir/daemon/index.js`
/// 2. Dev: walk up from the binary until we find `packages/daemon/dist/index.js`
fn locate_daemon_entry(app: &AppHandle) -> Result<PathBuf, String> {
    // Packaged location.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("daemon").join("index.js");
        if p.exists() {
            return Ok(p);
        }
    }

    // Dev location — walk up from current dir.
    let mut cur = std::env::current_dir().map_err(|e| e.to_string())?;
    for _ in 0..6 {
        let candidate = cur
            .join("packages")
            .join("daemon")
            .join("dist")
            .join("index.js");
        if candidate.exists() {
            return Ok(candidate);
        }
        if !cur.pop() {
            break;
        }
    }

    Err(
        "could not locate packages/daemon/dist/index.js. Run `pnpm build` from the repo root."
            .into(),
    )
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

fn run_watcher(
    app: AppHandle,
    mut process: DaemonProcess,
    ready_timeout: Duration,
    kill_rx: std::sync::mpsc::Receiver<()>,
) {
    // Phase 1: wait for the daemon to emit BB_DAEMON_READY.
    let outcome = process.wait_for_ready(ready_timeout);
    let (poll_port, poll_token) = match outcome {
        SpawnOutcome::Ready(info) => {
            let identity = (info.daemon_port, info.token.clone());
            on_ready(&app, info);
            identity
        }
        SpawnOutcome::ExitedEarly { exit_code } => {
            eprintln!("[runner] daemon exited early, code={exit_code:?}");
            on_early_exit(&app);
            return;
        }
        SpawnOutcome::Timeout => {
            eprintln!(
                "[runner] daemon didn't emit READY within {}ms",
                ready_timeout.as_millis()
            );
            let _ = process.kill();
            on_early_exit(&app);
            return;
        }
        SpawnOutcome::MalformedReady { line, error } => {
            eprintln!("[runner] malformed READY: {line:?} ({error})");
            let _ = process.kill();
            on_early_exit(&app);
            return;
        }
    };

    // Phase 2: watch for process exit OR a kill signal, and poll the daemon's
    // real CDP status. READY only means the HTTP server is up — the tray must
    // turn green once Chrome is actually attached, which the daemon reports as
    // `"cdpConnected":true` from GET /status. The daemon also reports
    // `"needsBrowserConsent":true` when it's blocked on closing a
    // non-debuggable browser; we prompt the user once and, on consent, set the
    // sticky gate and restart the daemon so it relaunches with debugging.
    let mut last_connected: Option<bool> = None;
    let mut consent_prompted = false;
    let mut ticks: u32 = 0;
    loop {
        // Check for kill signal first (non-blocking).
        if kill_rx.try_recv().is_ok() {
            eprintln!("[runner] kill requested");
            let _ = process.kill();
            // Treat user-requested kills as the same as a runtime crash so
            // the supervisor enters Stopped via its UserStop path. We use
            // DaemonExited here so the watcher contract stays simple — the
            // controller decides what state to move into.
            on_crash(&app);
            return;
        }

        if !process.is_alive() {
            eprintln!("[runner] daemon exited unexpectedly");
            on_crash(&app);
            return;
        }

        // Poll /status every ~1.5s (every 3rd 500ms tick).
        if ticks % 3 == 0 {
            if let Some(status) = poll_status(poll_port, &poll_token) {
                if last_connected != Some(status.cdp_connected) {
                    last_connected = Some(status.cdp_connected);
                    on_cdp_status(&app, status.cdp_connected);
                }
                // Prompt for browser-close consent at most once per watcher.
                if status.needs_browser_consent && !consent_prompted && !status.cdp_connected {
                    consent_prompted = true;
                    maybe_prompt_browser_consent(&app);
                }
            }
        }
        ticks = ticks.wrapping_add(1);

        thread::sleep(Duration::from_millis(500));
    }
}

/// Parsed subset of the daemon's `GET /status` response.
struct DaemonStatus {
    cdp_connected: bool,
    needs_browser_consent: bool,
}

/// Best-effort raw-HTTP `GET /status`. Returns `None` on any error so
/// transient failures don't flap the tray.
fn poll_status(daemon_port: u16, token: &str) -> Option<DaemonStatus> {
    let mut stream = TcpStream::connect(("127.0.0.1", daemon_port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let req = format!(
        "GET /status HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut body = String::new();
    stream.read_to_string(&mut body).ok()?;
    // Tolerate both `"key":true` and `"key": true`.
    let has = |key: &str, val: bool| {
        body.contains(&format!("\"{key}\":{val}")) || body.contains(&format!("\"{key}\": {val}"))
    };
    // Only treat the response as valid if it carried cdpConnected at all.
    if !has("cdpConnected", true) && !has("cdpConnected", false) {
        return None;
    }
    Some(DaemonStatus {
        cdp_connected: has("cdpConnected", true),
        needs_browser_consent: has("needsBrowserConsent", true),
    })
}

/// Show a native confirm dialog asking whether to close the user's running
/// browser and relaunch it (real profile) with remote debugging. On "yes",
/// set the sticky gate and restart the daemon so it actually performs the
/// close-and-relaunch.
fn maybe_prompt_browser_consent(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let app_for_cb = app_clone.clone();
        app_clone
            .dialog()
            .message(
                "bb-browser 需要浏览器开启远程调试才能连接。\n\n\
                 检测到浏览器正在运行但未开启调试。是否关闭它并用相同的配置文件\
                 （保留登录态）重新打开？\n\n\
                 注意：当前打开的标签页会重新加载。",
            )
            .title("bb-browser · 重启浏览器")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "关闭并重启".into(),
                "暂不".into(),
            ))
            .show(move |accepted| {
                if accepted {
                    eprintln!("[runner] user consented to browser relaunch");
                    let state = app_for_cb.state::<crate::app::AppState>();
                    state.runner.set_allow_browser_kill(true);
                    // Restart the daemon so it spawns with the consent env var.
                    crate::app::dispatch_event(&app_for_cb, Event::UserRestart);
                } else {
                    eprintln!("[runner] user declined browser relaunch");
                }
            });
    });
}

/// Push a CDP connection-status change into the controller and repaint.
fn on_cdp_status(app: &AppHandle, connected: bool) {
    eprintln!("[runner] cdp status poll -> connected={connected}");
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        {
            let state = app_clone.state::<crate::app::AppState>();
            let mut c = state.controller.lock().unwrap();
            c.set_cdp_state(if connected {
                CdpState::Connected
            } else {
                CdpState::Reconnecting
            });
        }
        crate::app::refresh_tray_public(&app_clone);
    });
}

fn on_ready(app: &AppHandle, info: ReadyInfo) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Update the controller's identity first, then dispatch ready.
        {
            let state = app_clone.state::<crate::app::AppState>();
            let mut c = state.controller.lock().unwrap();
            c.set_daemon_identity(info.daemon_port, info.cdp_port, info.token.clone());
        }
        crate::app::dispatch_event(&app_clone, Event::DaemonReady);
    });
}

fn on_early_exit(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::app::dispatch_event(
            &app_clone,
            Event::DaemonExited {
                now_ms: now_ms(),
                during_startup: true,
            },
        );
    });
}

fn on_crash(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::app::dispatch_event(
            &app_clone,
            Event::DaemonExited {
                now_ms: now_ms(),
                during_startup: false,
            },
        );
    });
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::strip_verbatim_prefix;

    #[test]
    fn strips_plain_verbatim_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\Z:\Apps\bb-browser-tray\daemon\index.js"),
            r"Z:\Apps\bb-browser-tray\daemon\index.js"
        );
    }

    #[test]
    fn rewrites_verbatim_unc_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\daemon\index.js"),
            r"\\server\share\daemon\index.js"
        );
    }

    #[test]
    fn leaves_normal_path_untouched() {
        assert_eq!(
            strip_verbatim_prefix(r"Z:\Apps\daemon\index.js"),
            r"Z:\Apps\daemon\index.js"
        );
    }
}
