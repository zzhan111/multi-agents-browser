/**
 * Daemon manager - spawn, health-check, and communicate with the daemon process
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Request, Response } from "@ma-browser/shared";
import {
  DaemonTimeoutError,
  clientCommandTimeoutMs,
  commandTimeoutMs,
  describeDaemonTimeout,
  type DaemonInfo,
  readDaemonJson,
  httpJson,
} from "@ma-browser/shared";
import { preferredCdpEndpoint } from "./cdp-discovery.js";

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedInfo: DaemonInfo | null = null;
let daemonReady = false;

let starting: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getDaemonPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const sameDirPath = resolve(currentDir, "daemon.js");
  if (existsSync(sameDirPath)) {
    return sameDirPath;
  }
  return resolve(currentDir, "../../daemon/dist/index.js");
}

/**
 * Ensure the daemon is running and ready to accept commands.
 * Probe the advertised HTTP endpoint first, then start a daemon if needed.
 * Browser discovery and launch are owned by the daemon.
 */
export async function ensureDaemon(): Promise<void> {
  if (!starting) starting = startOrConnect().finally(() => { starting = null; });
  return starting;
}

async function startOrConnect(): Promise<void> {
  if (daemonReady && cachedInfo) {
    // Quick re-check: is the HTTP server still reachable?
    // We no longer gate on cdpConnected — the daemon may be in a connecting
    // state (cdpConnected=false / yellow) while the browser starts up or
    // recovers. The command handler already queues commands via
    // `cdp.waitUntilReady()`, so we must not kill and re-spawn in this state.
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", cachedInfo, undefined, 2000);
      if (status.running) {
        return;
      }
    } catch {}
    daemonReady = false;
    cachedInfo = null;
  }

  let info = await readDaemonJson();
  if (info) {
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (status.running) {
        cachedInfo = info;
        daemonReady = true;
        return;
      }
    } catch {}
  }

  // Only forward an explicit preference; daemon owns discovery and launch.
  const cdpInfo = preferredCdpEndpoint();
  const cdpArgs = cdpInfo ? ["--cdp-host", cdpInfo.host, "--cdp-port", String(cdpInfo.port)] : [];

  // Spawn daemon process.
  // Suppress the console window on Windows (the MCP server is windowless).
  const daemonPath = getDaemonPath();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  };
  const child = spawn(process.execPath, [daemonPath, ...cdpArgs], spawnOpts);
  child.on("error", () => {});
  child.unref();

  // Wait for daemon to become healthy (up to 10 seconds — includes Chrome launch time)
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    // Re-read daemon.json each iteration (daemon writes it on startup)
    info = await readDaemonJson();
    if (!info) continue;
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (status.running) {
        cachedInfo = info;
        daemonReady = true;
        return;
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error(
    "ma-browser: Daemon did not start in time.\n\n" +
    "The daemon process did not become reachable.\n" +
    "Try: ma-browser daemon status",
  );
}

/**
 * Send a command to the daemon via POST /command.
 */
export async function daemonCommand(request: Request): Promise<Response> {
  if (!cachedInfo) {
    cachedInfo = await readDaemonJson();
  }
  if (!cachedInfo) {
    throw new Error("No daemon.json found. Is the daemon running?");
  }
  // Send our per-action budget so the daemon enforces the caller's policy, and
  // wait slightly longer than it so its structured 504 timeout arrives first.
  const body: Request = { ...request, timeoutMs: request.timeoutMs ?? commandTimeoutMs(request) };
  const clientTimeout = clientCommandTimeoutMs(body);
  try {
    return await httpJson<Response>("POST", "/command", cachedInfo, body, clientTimeout, { resolveStatuses: [504] });
  } catch (error) {
    if (error instanceof DaemonTimeoutError) {
      throw new Error(await describeDaemonTimeout(cachedInfo, request.action, clientTimeout));
    }
    throw error;
  }
}

/**
 * Stop the daemon via POST /shutdown.
 */
export async function stopDaemon(): Promise<boolean> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) return false;
  try {
    await httpJson("POST", "/shutdown", info);
    daemonReady = false;
    cachedInfo = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is running by querying GET /status.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) return false;
  try {
    const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
    return status.running === true;
  } catch {
    return false;
  }
}

/**
 * Get full daemon status (for the status command).
 */
export async function getDaemonStatus(): Promise<Record<string, unknown> | null> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) return null;
  try {
    return await httpJson<Record<string, unknown>>("GET", "/status", info, undefined, 2000);
  } catch {
    return null;
  }
}

/**
 * Legacy alias for backward compatibility.
 * Commands that import ensureDaemonRunning will continue to work.
 */
export const ensureDaemonRunning = ensureDaemon;
