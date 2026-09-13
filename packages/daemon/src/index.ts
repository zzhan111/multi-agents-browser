/**
 * ma-browser Daemon — CDP-direct backend
 *
 * Unified daemon that handles ALL browser commands (operations + observation)
 * via direct Chrome DevTools Protocol connection.
 *
 * Two-phase startup:
 *   1. HTTP server starts immediately (commands queue until CDP is ready)
 *   2. CDP connection established asynchronously
 */

import { chmodSync, writeFileSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  DAEMON_PORT,
  DAEMON_HOST,
  MANAGED_PORT_FILE,
  launchManagedBrowser,
  probeCdp,
  isProcessAlive,
} from "@ma-browser/shared";
import { HttpServer, installLogInterceptor, type DaemonRuntimeStatus } from "./http-server.js";
import { CdpConnection } from "./cdp-connection.js";
import { TabStateManager } from "./tab-state.js";
import { CommandHistory } from "./command-history.js";
import { StateStore } from "./state-store.js";
import { AgentRegistry } from "./agent-registry.js";
import { BindingStore } from "./binding-store.js";
import { JournalManager } from "./agent-journal.js";
import { getVaultManager } from "./vault/manager.js";
import { ScratchpadManager } from "./scratchpad-manager.js";
import { AdapterCache, adapterCacheDir } from "./adapter-cache.js";
import { AdapterHealthStore } from "./adapter-health.js";
import {
  DEFAULT_CDP_PORT,
  buildDaemonFileInfo,
  parseListenArgs,
  type DaemonFileInfo,
} from "./listen-config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAEMON_DIR = process.env.BB_BROWSER_HOME || path.join(os.homedir(), ".bb-browser");
const DAEMON_JSON = path.join(DAEMON_DIR, "daemon.json");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface DaemonOptions {
  host: string;
  advertiseHost?: string;
  port: number;
  cdpHost: string;
  cdpPort: number;
  token: string;
  remoteAccess: boolean;
}

function parseOptions(): DaemonOptions {
  const values = parseListenArgs(process.argv.slice(2), process.env);

  if (values.help) {
    console.error(`
ma-browser-daemon — CDP-direct backend for ma-browser

Usage:
  ma-browser-daemon [options]

Options:
  -H, --host <host>              HTTP listen address (default: ${DAEMON_HOST}; env: BB_DAEMON_HOST)
                                 127.0.0.1 (default), a Tailscale IP, or 0.0.0.0 (advanced)
      --advertise-host <host>    Client connect address written to daemon.json
                                 (env: BB_DAEMON_ADVERTISE_HOST). Used when remote access is on.
      --remote-access            Allow remote clients; do not rewrite advertise host to 127.0.0.1
                                 (env: BB_REMOTE_ACCESS=1; flag wins over env)
  -p, --port <port>              HTTP server port (default: ${DAEMON_PORT})
      --cdp-host <host>          Chrome CDP host (default: 127.0.0.1)
      --cdp-port <port>          Chrome CDP port (default: ${DEFAULT_CDP_PORT})
      --token <token>            Bearer auth token (auto-generated if empty)
  -h, --help                     Show this help message

Endpoints:
  POST /command      Send command and get result (via CDP)
  GET  /status       Daemon health + per-tab stats
  POST /shutdown     Graceful shutdown
`);
    process.exit(0);
  }

  // Auto-generate token if not provided
  let token = values.token;
  if (!token) {
    token = randomBytes(16).toString("hex");
  }

  return {
    host: values.host,
    advertiseHost: values.advertiseHost,
    port: values.port,
    cdpHost: values.cdpHost,
    cdpPort: values.cdpPort,
    token,
    remoteAccess: values.remoteAccess,
  };
}

// ---------------------------------------------------------------------------
// daemon.json management
// ---------------------------------------------------------------------------

function writeDaemonJson(info: DaemonFileInfo): void {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true });
    // Write a temp file in the same dir, then atomically rename it over
    // daemon.json. A reader (e.g. a WSL agent) therefore never observes a
    // truncated/half-written file: it sees either the previous contents or the
    // new ones in full, never an empty or partial JSON mid-write.
    const tmp = path.join(DAEMON_DIR, `daemon.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
    renameSync(tmp, DAEMON_JSON);
    chmodSync(DAEMON_JSON, 0o600);
  } catch (err) {
    console.error("[Daemon] Failed to write daemon.json (atomic):", (err as Error)?.message ?? err);
    // Fall back to a direct write if rename isn't available (e.g. a transient
    // sharing violation on Windows). A brief non-atomic window beats no file.
    try {
      writeFileSync(DAEMON_JSON, JSON.stringify(info), { mode: 0o600 });
      chmodSync(DAEMON_JSON, 0o600);
    } catch (err2) {
      console.error("[Daemon] Failed to write daemon.json (fallback):", (err2 as Error)?.message ?? err2);
    }
  }
}

/**
 * Remove daemon.json ONLY if it advertises a stale entry — i.e. the pid it
 * records is this process, or a process that no longer exists. This realizes
 * the original intent ("remove a stale entry pointing at a now-dead process")
 * without the hazard of the previous unconditional unlink: when several daemon
 * instances/projects share a DAEMON_DIR (or BB_BROWSER_HOME paths overlap), a
 * fatal crash in one must not delete a daemon.json that a *different*, still-
 * healthy daemon wrote — doing so would silently break discovery for WSL agents
 * and the tray. If the recorded pid belongs to another live process, we leave
 * the file untouched.
 */
function safeRemoveStaleDaemonJson(): void {
  let pid: number | undefined;
  try {
    const raw = JSON.parse(readFileSync(DAEMON_JSON, "utf8")) as Partial<DaemonFileInfo>;
    if (typeof raw.pid === "number") pid = raw.pid;
  } catch {
    // Missing or unparseable file — nothing to remove (and nothing to corrupt).
    return;
  }
  if (pid === undefined) return;
  // Own entry, or an entry whose owner has already died → safe to remove.
  if (pid === process.pid || !isProcessAlive(pid)) {
    try {
      unlinkSync(DAEMON_JSON);
    } catch {}
  }
  // Otherwise: another live daemon owns this file — leave it alone.
}

// ---------------------------------------------------------------------------
// CDP port discovery (simplified — daemon is told the port)
// ---------------------------------------------------------------------------

async function discoverCdpPort(
  host: string,
  port: number,
): Promise<{ host: string; port: number }> {
  // Try the configured port first, on both IPv4 and IPv6.
  const direct = await probeCdp(port);
  if (direct) {
    return { host: direct, port };
  }

  // Try the port recorded for a previously-launched managed browser.
  const managedPortFile = MANAGED_PORT_FILE;
  try {
    const managedPort = parseInt(readFileSync(managedPortFile, "utf8").trim(), 10);
    if (Number.isInteger(managedPort) && managedPort > 0) {
      const managedHost = await probeCdp(managedPort);
      if (managedHost) {
        return { host: managedHost, port: managedPort };
      }
    }
  } catch {}

  // Scan well-known CDP ports plus a wide run of odd ports from the default.
  // Windows port-exclusion zones (Hyper-V/WSL) can displace the tray's chosen
  // port by many hops; 20 extra odd ports (40 apart) covers common exclusion
  // clusters without exhausting the probe budget.
  const CDP_SCAN_CANDIDATES: number[] = [9222, 9229];
  for (let p = DEFAULT_CDP_PORT; p <= DEFAULT_CDP_PORT + 40; p += 2) {
    CDP_SCAN_CANDIDATES.push(p);
  }
  for (const candidate of CDP_SCAN_CANDIDATES) {
    if (candidate === port) continue; // already tried above
    const h = await probeCdp(candidate);
    if (h) {
      console.error(`[Daemon] Found existing browser at ${h}:${candidate}; using it.`);
      return { host: h, port: candidate };
    }
  }

  // Last resort: launch a managed browser under a dedicated profile. The CLI
  // pre-launches Chrome before spawning the daemon, but the tray supervisor
  // does not — so the daemon must be able to bootstrap its own browser. The
  // managed instance uses its own --user-data-dir, so it coexists with the
  // user's normal browser and never closes it.
  console.error(
    `[Daemon] No Chrome reachable at ${host}:${port}; launching a managed browser (dedicated profile)...`,
  );
  const launched = await launchManagedBrowser(port);
  if (launched) {
    return launched;
  }

  // Throwing here is non-fatal: bringUpCdp() catches it and retries, so the
  // daemon self-heals once a browser becomes available.
  throw new Error(
    `Cannot connect to Chrome CDP at ${host}:${port}, and could not launch a ` +
      `managed browser. Install Chrome/Edge/Brave, or start your browser with ` +
      `--remote-debugging-port=${port}.`,
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
  const stateStore = new StateStore(path.join(DAEMON_DIR, "state"));
  const agentRegistry = new AgentRegistry(stateStore);
  const bindingStore = new BindingStore(stateStore);
  const journalManager = new JournalManager(stateStore);
  const scratchpadManager = new ScratchpadManager();
  const adapterCache = new AdapterCache({ dir: adapterCacheDir(DAEMON_DIR) });
  const adapterHealth = new AdapterHealthStore({ store: stateStore });
  // Evict TTL-expired scratchpad entries every minute; flush journals every 2s.
  const scratchpadGcTimer = setInterval(() => scratchpadManager.gc(), 60_000);
  const journalFlushTimer = setInterval(() => journalManager.flushAll(), 2_000);

  // Graceful shutdown handler (guarded against double-call)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[Daemon] Shutting down...");
    clearInterval(scratchpadGcTimer);
    clearInterval(journalFlushTimer);
    journalManager.flushAll(); // flush any unflushed entries before exit
    getVaultManager().shutdown(); // stop watchers + close SQLite cleanly (WAL checkpoint)
    cdp.disconnect();
    await httpServer.stop();
    // daemon.json intentionally NOT deleted — a tray-driven restart may already
    // have a replacement daemon running, and WSL agents need the file to
    // discover the daemon. The replacement daemon overwrites daemon.json on its
    // own startup, so stale entries are harmless.
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
    token: options.token,
    remoteAccess: options.remoteAccess,
    cdp,
    history,
    agentRegistry,
    bindingStore,
    journalManager,
    scratchpadManager,
    adapterCache,
    adapterHealth,
    onShutdown: shutdown,
    runtimeStatus,
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await httpServer.start();
  writeDaemonJson(buildDaemonFileInfo({
    pid: process.pid,
    bindHost: options.host,
    port: options.port,
    token: options.token,
    remoteAccess: options.remoteAccess,
    advertiseHost: options.advertiseHost,
  }));

  // Emit a machine-readable READY line on stdout so the tray supervisor
  // (packages/tray-app/src-tauri/src/daemon_spawner.rs) can pick up the
  // resolved ports and token. The prefix is fixed by `READY_PREFIX`; the
  // payload is `ReadyInfo` in the Rust side (camelCase).
  //
  // NOTE: write directly to stdout — NOT console.log — because
  // installLogInterceptor() rewrites console.log to prepend "[Daemon] ",
  // which would corrupt the READY line and break the Rust parser.
  // S4: never emit token on READY/stdout — supervisors read daemon.json (0600).
  process.stdout.write(
    `BB_DAEMON_READY ${JSON.stringify({
      daemonPort: options.port,
      cdpPort: options.cdpPort,
    })}\n`,
  );

  console.error(
    `[Daemon] HTTP server listening on http://${options.host}:${options.port}`,
  );
  if (options.remoteAccess) {
    console.error(
      `[Daemon] remote access enabled; listening on http://${options.host}:${options.port}; clients must use token`,
    );
  }
  console.error("[Daemon] Auth token written to daemon.json (not logged)");

  // ----- Phase 2: connect to CDP in the background, retrying until ready -----
  //
  // Runs detached from startup so a failure here never kills the daemon — the
  // HTTP server stays up and /status keeps reporting cdpConnected=false until
  // we succeed. The tray's /status poller renders that as yellow (重连中).
  void bringUpCdp(cdp, options, runtimeStatus);

  // Vault feature: load the registry + start watchers in the background.
  // Same detachment rules as bringUpCdp — a vault indexing failure must never
  // take the daemon down, and the first index of a large vault can take a while.
  void getVaultManager()
    .init()
    .catch((e) =>
      console.error(`[Vault] startup init failed: ${e instanceof Error ? e.message : e}`),
    );

  // Self-heal: if the established CDP socket drops (e.g. user closed Chrome,
  // managed browser crashed, or network blip), restart the bring-up loop so we
  // re-discover/relaunch and return to green. The close cause (code/reason) is
  // logged by CdpConnection just before this fires.
  cdp.onUnexpectedClose = () => {
    console.error(
      `[Daemon] CDP connection dropped${cdp.lastError ? ` (${cdp.lastError})` : ""}; restarting bring-up loop...`,
    );
    void bringUpCdp(cdp, options, runtimeStatus);
  };
}

/** Guards against overlapping bring-up loops (initial start + reconnect). */
let bringUpInFlight = false;
/** Resolves the backoff sleep early when a reconnect arrives mid-sleep. */
let _bringUpWakeUp: (() => void) | null = null;

/**
 * Background loop that resolves a CDP endpoint and connects, retrying with a
 * capped backoff until it succeeds. Never throws — every failure is logged
 * and retried, so the daemon self-heals from a browser that wasn't ready yet
 * or a managed-browser launch that was still starting up.
 *
 * If no debuggable browser is reachable, launchManagedBrowser starts one under
 * a dedicated profile (never touching the user's own browser).
 */
async function bringUpCdp(
  cdp: CdpConnection,
  options: DaemonOptions,
  runtimeStatus: DaemonRuntimeStatus,
): Promise<void> {
  // Only one bring-up loop at a time. If a reconnect fires while the loop is
  // sleeping in backoff, wake it up so it retries immediately rather than
  // waiting the full backoff delay.
  if (bringUpInFlight) {
    _bringUpWakeUp?.();
    return;
  }
  bringUpInFlight = true;
  try {
    await bringUpCdpLoop(cdp, options, runtimeStatus);
  } finally {
    bringUpInFlight = false;
    _bringUpWakeUp = null;
  }
}

async function bringUpCdpLoop(
  cdp: CdpConnection,
  options: DaemonOptions,
  runtimeStatus: DaemonRuntimeStatus,
): Promise<void> {
  let attempt = 0;
  // Log attempt 1 always, then every 20th — avoids log bloat for long outages
  // and correctly handles alternating error messages (which would never match a
  // lastLoggedMsg guard and would log every single retry).
  const HEARTBEAT_EVERY = 20;

  while (true) {
    // If something reconnected us already, stop.
    if (cdp.connected) return;
    attempt += 1;
    try {
      const endpoint = await discoverCdpPort(options.cdpHost, options.cdpPort);
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
      runtimeStatus.needsBrowserConsent = false;
      // Capped exponential backoff: 1s, 2s, 4s … max 15s.
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4));
      const everySecs = Math.round(delayMs / 1000);
      if (attempt === 1 || attempt % HEARTBEAT_EVERY === 0) {
        console.error(
          `[Daemon] CDP bring-up attempt ${attempt} failed: ${msg}. Retrying every ${everySecs}s...`,
        );
      }
      // Interruptible sleep: a reconnect event resolves this early via
      // _bringUpWakeUp so we retry immediately instead of waiting the full cap.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        _bringUpWakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      _bringUpWakeUp = null;
    }
  }
}

main().catch((error) => {
  console.error("[Daemon] Fatal error:", error);
  // Remove daemon.json so a tray-spawned replacement doesn't find a stale
  // entry pointing at this now-dead process. (Graceful shutdown intentionally
  // skips this because a replacement daemon may already have overwritten it.)
  // safeRemoveStaleDaemonJson() only acts when the file's pid is ours or dead —
  // never when another live daemon owns it (see its doc comment).
  safeRemoveStaleDaemonJson();
  process.exit(1);
});
