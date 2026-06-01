/**
 * bb-browser Daemon — CDP-direct backend
 *
 * Unified daemon that handles ALL browser commands (operations + observation)
 * via direct Chrome DevTools Protocol connection.
 *
 * Two-phase startup:
 *   1. HTTP server starts immediately (commands queue until CDP is ready)
 *   2. CDP connection established asynchronously
 */

import { parseArgs } from "node:util";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  DAEMON_PORT,
  DAEMON_HOST,
  launchManagedBrowser,
  isConfiguredBrowserRunning,
} from "@bb-browser/shared";
import { HttpServer, installLogInterceptor, type DaemonRuntimeStatus } from "./http-server.js";
import { CdpConnection } from "./cdp-connection.js";
import { TabStateManager } from "./tab-state.js";
import { CommandHistory } from "./command-history.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAEMON_DIR = process.env.BB_BROWSER_HOME || path.join(os.homedir(), ".bb-browser");
const DAEMON_JSON = path.join(DAEMON_DIR, "daemon.json");
const DEFAULT_CDP_PORT = 19825;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface DaemonOptions {
  host: string;
  port: number;
  cdpHost: string;
  cdpPort: number;
  token: string;
}

function parseOptions(): DaemonOptions {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      host: {
        type: "string",
        short: "H",
        default: DAEMON_HOST,
      },
      port: {
        type: "string",
        short: "p",
        default: String(DAEMON_PORT),
      },
      "cdp-host": {
        type: "string",
        default: "127.0.0.1",
      },
      "cdp-port": {
        type: "string",
        default: String(DEFAULT_CDP_PORT),
      },
      token: {
        type: "string",
        default: "",
      },
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
    },
  });

  if (values.help) {
    console.error(`
bb-browser-daemon — CDP-direct backend for bb-browser

Usage:
  bb-browser-daemon [options]

Options:
  -H, --host <host>          HTTP server host (default: ${DAEMON_HOST})
  -p, --port <port>          HTTP server port (default: ${DAEMON_PORT})
      --cdp-host <host>      Chrome CDP host (default: 127.0.0.1)
      --cdp-port <port>      Chrome CDP port (default: ${DEFAULT_CDP_PORT})
      --token <token>        Bearer auth token (auto-generated if empty)
  -h, --help                 Show this help message

Endpoints:
  POST /command      Send command and get result (via CDP)
  GET  /status       Daemon health + per-tab stats
  POST /shutdown     Graceful shutdown
`);
    process.exit(0);
  }

  // Auto-generate token if not provided
  let token = values.token ?? "";
  if (!token) {
    token = randomBytes(16).toString("hex");
  }

  return {
    host: values.host ?? DAEMON_HOST,
    port: parseInt(values.port ?? String(DAEMON_PORT), 10),
    cdpHost: values["cdp-host"] ?? "127.0.0.1",
    cdpPort: parseInt(values["cdp-port"] ?? String(DEFAULT_CDP_PORT), 10),
    token,
  };
}

// ---------------------------------------------------------------------------
// daemon.json management
// ---------------------------------------------------------------------------

interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
}

/**
 * daemon.json advertises a *connectable* host. When the server binds a
 * wildcard address (0.0.0.0 / ::) we can't tell clients to dial there, so we
 * advertise loopback instead: same-host clients reach it directly, and the WSL
 * client rewrites loopback → Windows host IP on its own (see daemon-client.ts).
 */
function advertisedHost(bindHost: string): string {
  return bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
}

function writeDaemonJson(info: DaemonInfo): void {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true });
    writeFileSync(DAEMON_JSON, JSON.stringify(info), { mode: 0o600 });
  } catch {}
}

function cleanupDaemonJson(): void {
  if (existsSync(DAEMON_JSON)) {
    try {
      unlinkSync(DAEMON_JSON);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// CDP port discovery (simplified — daemon is told the port)
// ---------------------------------------------------------------------------

async function discoverCdpPort(
  host: string,
  port: number,
  allowKill = false,
): Promise<{ host: string; port: number }> {
  // Try connecting to the specified port first
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`http://${host}:${port}/json/version`, {
        signal: controller.signal,
      });
      if (response.ok) {
        return { host, port };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {}

  // Try reading managed browser port file
  const managedPortFile = path.join(DAEMON_DIR, "browser", "cdp-port");
  try {
    const rawPort = readFileSync(managedPortFile, "utf8").trim();
    const managedPort = parseInt(rawPort, 10);
    if (Number.isInteger(managedPort) && managedPort > 0) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const response = await fetch(`http://127.0.0.1:${managedPort}/json/version`, {
            signal: controller.signal,
          });
          if (response.ok) {
            return { host: "127.0.0.1", port: managedPort };
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {}
    }
  } catch {}

  // Last resort: launch a managed Chrome on the requested (free) CDP port.
  // The CLI does this before spawning the daemon, but the tray supervisor
  // does not — so the daemon must be able to bootstrap its own browser.
  //
  // `killExisting` (gated on user confirmation via BB_ALLOW_BROWSER_KILL) —
  // if the user's browser is already open WITHOUT remote debugging, its
  // single-instance lock would swallow our launch and never expose a CDP
  // port. With consent we close the running instance and relaunch the SAME
  // real profile with debugging on (logins preserved).
  console.error(
    `[Daemon] No Chrome reachable at ${host}:${port}; launching a managed browser` +
      `${allowKill ? " (will close any running instance first)" : ""}...`,
  );
  const launched = await launchManagedBrowser(port, { killExisting: allowKill });
  if (launched) {
    return launched;
  }

  // Throwing here is non-fatal: bringUpCdp() catches it and retries. This
  // covers the case where the user's browser is open without debugging but we
  // don't have consent to close it — we keep retrying so that the moment they
  // close it themselves (or grant consent), we connect.
  throw new Error(
    `Cannot connect to Chrome CDP at ${host}:${port}, and no debuggable ` +
      `browser is available.` +
      (allowKill
        ? " Install Chrome/Edge/Brave or start Chrome with --remote-debugging-port."
        : " A browser appears to be running without remote debugging; waiting" +
          " for it to become debuggable (close-and-relaunch not authorized)."),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Persist all daemon logs to ~/.bb-browser/logs/daemon.log so startup
  // failures are diagnosable (the tray's "打开日志文件夹" opens this dir).
  installLogInterceptor(path.join(DAEMON_DIR, "logs", "daemon.log"));

  const options = parseOptions();

  // Create tab state manager and CDP connection. The CDP endpoint is not yet
  // known — the background bring-up loop (below) discovers/launches Chrome and
  // repoints the connection. We seed it with the requested port so /status has
  // a sensible cdpPort to report before the first connect.
  const tabManager = new TabStateManager();
  const history = new CommandHistory();
  const cdp = new CdpConnection(options.cdpHost, options.cdpPort, tabManager);
  const runtimeStatus: DaemonRuntimeStatus = { needsBrowserConsent: false };

  // Graceful shutdown handler (guarded against double-call)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[Daemon] Shutting down...");
    cdp.disconnect();
    await httpServer.stop();
    cleanupDaemonJson();
    process.exit(0);
  };

  // ----- Phase 1: bring up the HTTP server and signal READY immediately -----
  //
  // CRITICAL: the HTTP server must start and BB_DAEMON_READY must be emitted
  // BEFORE any CDP work. CDP discovery may kill+relaunch the browser and wait
  // several seconds; doing that synchronously here would blow the tray's
  // READY timeout and make a transient startup look like a hard failure (the
  // supervisor would land in FailedToStart with no auto-retry). Keeping the
  // HTTP server alive lets the tray see cdpConnected=false (yellow) instead.
  const httpServer = new HttpServer({
    host: options.host,
    port: options.port,
    cdpPort: options.cdpPort,
    token: options.token,
    cdp,
    history,
    onShutdown: shutdown,
    runtimeStatus,
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await httpServer.start();
  writeDaemonJson({
    pid: process.pid,
    host: advertisedHost(options.host),
    port: options.port,
    token: options.token,
  });

  // Emit a machine-readable READY line on stdout so the tray supervisor
  // (packages/tray-app/src-tauri/src/daemon_spawner.rs) can pick up the
  // resolved ports and token. The prefix is fixed by `READY_PREFIX`; the
  // payload is `ReadyInfo` in the Rust side (camelCase).
  //
  // NOTE: write directly to stdout — NOT console.log — because
  // installLogInterceptor() rewrites console.log to prepend "[Daemon] ",
  // which would corrupt the READY line and break the Rust parser.
  process.stdout.write(
    `BB_DAEMON_READY ${JSON.stringify({
      daemonPort: options.port,
      cdpPort: options.cdpPort,
      token: options.token,
    })}\n`,
  );

  console.error(
    `[Daemon] HTTP server listening on http://${options.host}:${options.port}`,
  );
  console.error(`[Daemon] Auth token: ${options.token}`);

  // ----- Phase 2: connect to CDP in the background, retrying until ready -----
  //
  // Runs detached from startup so a failure here never kills the daemon — the
  // HTTP server stays up and /status keeps reporting cdpConnected=false until
  // we succeed. The tray's /status poller renders that as yellow (重连中).
  void bringUpCdp(cdp, options, runtimeStatus);

  // Self-heal: if the established CDP socket drops (e.g. user closed Chrome),
  // restart the bring-up loop so we re-discover/relaunch and return to green.
  cdp.onUnexpectedClose = () => {
    console.error("[Daemon] CDP connection dropped; restarting bring-up loop...");
    void bringUpCdp(cdp, options, runtimeStatus);
  };
}

/** Guards against overlapping bring-up loops (initial start + reconnect). */
let bringUpInFlight = false;

/**
 * Background loop that resolves a CDP endpoint and connects, retrying with a
 * capped backoff until it succeeds. Never throws — every failure is logged
 * and retried, so the daemon self-heals from a browser that wasn't ready yet
 * or a relaunch that raced.
 *
 * Browser kill+relaunch (`killExisting`) is gated on `BB_ALLOW_BROWSER_KILL`,
 * which the tray sets only after the user confirms the "close & relaunch"
 * prompt. Without it, we still discover/connect to an already-debuggable
 * Chrome but never close a normally-running browser behind the user's back.
 */
async function bringUpCdp(
  cdp: CdpConnection,
  options: DaemonOptions,
  runtimeStatus: DaemonRuntimeStatus,
): Promise<void> {
  // Only one bring-up loop at a time. The initial start and a reconnect after
  // a drop can both call this; the guard prevents two competing retry loops.
  if (bringUpInFlight) return;
  bringUpInFlight = true;
  try {
    await bringUpCdpLoop(cdp, options, runtimeStatus);
  } finally {
    bringUpInFlight = false;
  }
}

async function bringUpCdpLoop(
  cdp: CdpConnection,
  options: DaemonOptions,
  runtimeStatus: DaemonRuntimeStatus,
): Promise<void> {
  const allowKill = process.env.BB_ALLOW_BROWSER_KILL === "1";
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // If something reconnected us already, stop.
    if (cdp.connected) return;
    attempt += 1;
    try {
      const endpoint = await discoverCdpPort(options.cdpHost, options.cdpPort, allowKill);
      runtimeStatus.needsBrowserConsent = false;
      cdp.repoint(endpoint.host, endpoint.port);
      console.error(
        `[Daemon] Connecting to Chrome CDP at ${endpoint.host}:${endpoint.port} (attempt ${attempt})...`,
      );
      await cdp.connect();
      console.error(`[Daemon] CDP connected, monitoring ${cdp.tabManager.tabCount} tab(s)`);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // If a browser is running but not debuggable and we lack consent to
      // close it, surface that to the tray so it can prompt the user. (When
      // consent IS granted we'd have closed+relaunched, so this only trips in
      // the no-consent path.)
      if (!allowKill) {
        runtimeStatus.needsBrowserConsent = await isConfiguredBrowserRunning();
      }
      // Capped exponential backoff: 1s, 2s, 4s … max 15s.
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4));
      console.error(
        `[Daemon] CDP bring-up attempt ${attempt} failed: ${msg}. Retrying in ${Math.round(delayMs / 1000)}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

main().catch((error) => {
  console.error("[Daemon] Fatal error:", error);
  cleanupDaemonJson();
  process.exit(1);
});
