/**
 * Daemon manager - spawn, health-check, and communicate with the daemon process
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Request, Response } from "@ma-browser/shared";
import {
  COMMAND_TIMEOUT,
  DAEMON_JSON,
  type DaemonInfo,
  readDaemonJson,
  isProcessAlive,
  httpJson,
} from "@ma-browser/shared";
import { discoverCdpPort } from "./cdp-discovery.js";

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedInfo: DaemonInfo | null = null;
let daemonReady = false;

// ---------------------------------------------------------------------------
// daemon.json helpers
// ---------------------------------------------------------------------------

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
 * - Reads ~/.bb-browser/daemon.json for pid, host, port, token
 * - Checks if pid is alive via signal 0
 * - If daemon.json exists, never spawns a second daemon; the tray owns startup
 * - Checks health via GET /status
 * - If not running, spawns daemon process (detached) and waits for health
 */
export async function ensureDaemon(): Promise<void> {
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

  // daemon.json is the tray's ownership marker. Never remove it or spawn a
  // second daemon around it, even when the advertised process is restarting.
  const daemonJsonPresent = existsSync(DAEMON_JSON);
  let info = await readDaemonJson();
  if (daemonJsonPresent) {
    if (!info) {
      throw new Error("ma-browser: daemon.json exists but is unreadable; start or restart the tray");
    }
    if (!isProcessAlive(info.pid)) {
      throw new Error("ma-browser: daemon.json belongs to a stopped daemon; start or restart the tray");
    }
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", info, undefined, 2000);
      if (status.running) {
        cachedInfo = info;
        daemonReady = true;
        return;
      }
    } catch {
      // The tray remains the sole owner while its daemon is restarting.
    }
    throw new Error("ma-browser: cannot reach the tray-owned daemon; wait for the tray to become ready");
  }
  // Discover CDP port (auto-launches Chrome if needed)
  const cdpInfo = await discoverCdpPort();
  if (!cdpInfo) {
    throw new Error(
      "ma-browser: Cannot find a Chromium-based browser.\n\n" +
      "Please do one of the following:\n" +
      "  1. Install Google Chrome, Edge, or Brave\n" +
      "  2. Start Chrome with: google-chrome --remote-debugging-port=19825\n" +
      "  3. Set BB_BROWSER_CDP_URL=http://host:port",
    );
  }

  // Spawn daemon process with discovered CDP endpoint.
  // Suppress the console window on Windows (the MCP server is windowless).
  const daemonPath = getDaemonPath();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  };
  const child = spawn(process.execPath, [daemonPath, "--cdp-host", cdpInfo.host, "--cdp-port", String(cdpInfo.port)], spawnOpts);
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
    "Chrome CDP is reachable, but the daemon process failed to initialize.\n" +
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
  return httpJson<Response>("POST", "/command", cachedInfo, request, COMMAND_TIMEOUT);
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
