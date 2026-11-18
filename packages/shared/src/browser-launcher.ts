/**
 * Managed-browser launcher.
 *
 * Locates a Chromium-based browser and launches it with a remote-debugging
 * port so the daemon can attach via CDP. Shared by:
 *   - the CLI orchestrator (cli/cdp-discovery), which pre-launches Chrome
 *     before spawning the daemon; and
 *   - the daemon itself (daemon/index), so a daemon spawned by the tray app
 *     — which, unlike the CLI, does NOT pre-launch Chrome — can still bring
 *     up its own browser instead of dying when no CDP endpoint is reachable.
 *
 * The managed browser runs under a DEDICATED, persistent profile, separate
 * from the user's real profile, so it coexists with the user's normal browser
 * without ever closing or disturbing it. Agent logins accumulate in this
 * managed profile and persist across runs.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { DAEMON_DIR } from "./daemon-client.js";
import {
  readPersistedBrowserMode,
  resolveInitialBrowserMode,
  type BrowserDisplayMode,
} from "./windows-stealth.js";

/** Default CDP debugging port (odd chain start). */
export const DEFAULT_CDP_PORT = 19825;

/** Directory holding managed-browser bookkeeping. */
export const MANAGED_BROWSER_DIR = path.join(DAEMON_DIR, "browser");

/** File recording the port of the managed browser, if any. */
export const MANAGED_PORT_FILE = path.join(MANAGED_BROWSER_DIR, "cdp-port");

/** File recording the PID of the managed browser process, if any. */
export const MANAGED_PID_FILE = path.join(MANAGED_BROWSER_DIR, "browser-pid");

/**
 * Dedicated, persistent profile for the managed debug browser. A distinct
 * `--user-data-dir` gives the managed instance its own single-instance scope,
 * so it runs alongside the user's normal browser without our needing to close
 * theirs. Logins made here persist across runs.
 */
export const MANAGED_USER_DATA_DIR = path.join(MANAGED_BROWSER_DIR, "profile");

export function currentManagedBrowserDir(): string {
  const home = process.env.BB_BROWSER_HOME || DAEMON_DIR;
  return path.join(home, "browser");
}

export function readManagedPort(): number | null {
  try {
    const raw = readFileSync(path.join(currentManagedBrowserDir(), "cdp-port"), "utf8").trim();
    const port = parseInt(raw, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function readManagedPid(): number | null {
  try {
    const raw = readFileSync(path.join(currentManagedBrowserDir(), "browser-pid"), "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Hosts to probe for a CDP endpoint. Some browsers may bind the debug port on
 * IPv6 (`::1`) rather than IPv4 loopback, so we try both to ensure broad
 * compatibility.
 */
export const PROBE_HOSTS = ["127.0.0.1", "[::1]"];

/**
 * Probe a CDP endpoint on `port` across IPv4 and IPv6 in parallel. Returns
 * the host (e.g. `127.0.0.1` or `[::1]`) that answered `/json/version`, or
 * null. Parallel probing halves worst-case latency vs. serial.
 */
export async function probeCdp(port: number): Promise<string | null> {
  const results = await Promise.all(
    PROBE_HOSTS.map(async (host): Promise<string | null> => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        try {
          const response = await fetch(`http://${host}:${port}/json/version`, {
            signal: controller.signal,
          });
          return response.ok ? host : null;
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return null;
      }
    }),
  );
  return results.find((h) => h !== null) ?? null;
}

/** Locate a Chromium-based browser executable for the current platform. */
export function findBrowserExecutable(): string | null {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Arc.app/Contents/MacOS/Arc",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  if (process.platform === "linux") {
    const candidates = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
    for (const candidate of candidates) {
      try {
        const resolved = execSync(`which ${candidate}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (resolved) {
          return resolved;
        }
      } catch {
        // not found — try next
      }
    }
    return null;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = [
      // Google Chrome
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ...(localAppData
        ? [
            `${localAppData}/Google/Chrome Dev/Application/chrome.exe`,
            `${localAppData}/Google/Chrome SxS/Application/chrome.exe`,
            `${localAppData}/Google/Chrome Beta/Application/chrome.exe`,
          ]
        : []),
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  return null;
}

/** Only the browser socket announced by a managed child identifies its launch.
 * Legacy PID/port files remain discovery hints. Neither grants ownership. */
export function isManagedDebugger(host: string, port: number, debuggerUrl: string | null): boolean {
  if (!debuggerUrl || !PROBE_HOSTS.includes(host)) return false;
  try {
    const url = new URL(debuggerUrl);
    if (url.origin !== `ws://${host}:${port}` || !/^\/devtools\/browser\/[\w-]+$/.test(url.pathname)) return false;
    return readFileSync(path.join(currentManagedBrowserDir(), "debugger-url"), "utf8").trim() === debuggerUrl;
  } catch { return false; }
}

/**
 * Return true if no process holds `port` on any interface. Binds `0.0.0.0`
 * to match Chrome's own all-interfaces bind — a port held by a wildcard or
 * IPv6-only listener is invisible to a `127.0.0.1`-only probe.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(port, "0.0.0.0", () => {
      srv.close(() => resolve(true));
    });
    srv.on("error", () => resolve(false));
  });
}

/** Scan odd-numbered ports starting from `start` and return the first free one. */
async function findFreeOddPort(start: number): Promise<number> {
  let port = start % 2 === 0 ? start + 1 : start;
  while (port <= 65533) {
    if (await isPortFree(port)) return port;
    port += 2;
  }
  return start;
}

// Track the most-recently launched managed browser so we can avoid killing it
// during its startup window (Chrome can take > 25 s to bind on slow machines).
let _managedLaunchMs = 0;
let _managedLaunchPort = 0;
/** How long to wait for a freshly-launched browser before giving up and killing it. */
const LAUNCH_GRACE_MS = 60_000;

export interface LaunchManagedBrowserOptions {
  /** Target display mode (`headed` or `headless`). Defaults to `resolveInitialBrowserMode()`. */
  mode?: BrowserDisplayMode;
  /** Force Chromium `--headless=new` instead of Windows stealth window virtualization. */
  nativeHeadless?: boolean;
  /** Pass `--restore-last-session` instead of `about:blank`. */
  restoreSession?: boolean;
  /** Ignore the 60s launch grace window (for an intentional hot-swap restart). */
  bypassGrace?: boolean;
}

/**
 * Launch a managed Chromium browser on the given CDP port under a dedicated
 * profile and wait until it is reachable. Writes the resolved port to
 * MANAGED_PORT_FILE so other processes (and the daemon's own fallback) can find
 * it. Returns the reachable `{host, port}` (host may be IPv4 or IPv6), or null
 * if no browser executable is found or it never becomes reachable.
 *
 * Never closes the user's browser: the dedicated `--user-data-dir` gives the
 * managed instance its own single-instance scope, so it coexists with the
 * user's normal session.
 */
export async function launchManagedBrowser(
  port: number = DEFAULT_CDP_PORT,
  options: LaunchManagedBrowserOptions = {},
): Promise<{ host: string; port: number } | null> {
  // Opt-out for test suites and other sandboxes: never start a real browser.
  // Without this, a daemon under test that finds no CDP endpoint launches a
  // detached Chromium on the default port that outlives the test run.
  if (process.env.MA_BROWSER_NO_LAUNCH === "1") {
    return null;
  }
  const executable = findBrowserExecutable();
  if (!executable) {
    return null;
  }

  if (!options.bypassGrace) {
    // Already debuggable on this port? (Our managed instance from a prior run, or
    // a browser the user started with --remote-debugging-port.) Nothing to launch.
    const existing = await probeCdp(port);
    if (existing) {
      return { host: existing, port };
    }

    // If we launched a managed browser recently, give it more time instead of
    // killing it and starting over — prevents an infinite kill-restart cycle on
    // slow machines where Chrome takes longer than the 25s poll window to bind.
    const age = Date.now() - _managedLaunchMs;
    if (age < LAUNCH_GRACE_MS && _managedLaunchPort > 0) {
      // The launcher may have chosen a different port than `port` — probe it too.
      if (_managedLaunchPort !== port) {
        const h = await probeCdp(_managedLaunchPort);
        if (h) return { host: h, port: _managedLaunchPort };
      }
      console.error(
        `[browser-launcher] managed browser launched ${Math.round(age / 1000)}s ago; still starting up (${Math.round((LAUNCH_GRACE_MS - age) / 1000)}s grace remaining)`,
      );
      return null;
    }
  }

  // The port passed in was free when the Rust tray checked it, but may have been
  // taken by the time we reach here (TOCTOU, or Windows port-exclusion zones that
  // only reject a bind from Chrome's all-interfaces listener). Verify at the Node
  // level and fall back to the next free odd port to avoid Chrome entering a
  // restart loop unable to bind --remote-debugging-port.
  const launchPort = (await isPortFree(port)) ? port : await findFreeOddPort(port + 2);
  if (launchPort !== port) {
    console.error(`[browser-launcher] port ${port} is occupied; using ${launchPort} instead`);
  }

  const browserDir = currentManagedBrowserDir();
  const profileDir = path.join(browserDir, "profile");
  await mkdir(profileDir, { recursive: true });

  const initial = resolveInitialBrowserMode();
  const mode = options.mode ?? initial.mode;
  const nativeHeadless =
    options.nativeHeadless ??
    (mode === "headless" && (process.platform !== "win32" || process.env.MA_BROWSER_NATIVE_HEADLESS === "1"));
  const useWinStealth = process.platform === "win32" && !nativeHeadless;
  const restoreSession =
    options.restoreSession ??
    (process.env.MA_BROWSER_RESTORE_SESSION === "1" ||
      (process.env.MA_BROWSER_RESTORE_SESSION !== "0" && readPersistedBrowserMode() !== null));

  const disabledFeatures = useWinStealth
    ? "Translate,MediaRouter,CalculateNativeWinOcclusion"
    : "Translate,MediaRouter";

  const args = [
    ...(nativeHeadless ? ["--headless=new"] : []),
    ...(useWinStealth && mode === "headless"
      ? ["--window-position=-32000,-32000", "--window-size=1280,850"]
      : []),
    ...(restoreSession ? ["--restore-last-session"] : []),
    `--remote-debugging-port=${launchPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    `--disable-features=${disabledFeatures}`,
    ...(useWinStealth
      ? [
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
        ]
      : []),
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--use-mock-keychain",
    ...(restoreSession ? [] : ["about:blank"]),
  ];

  let announcedUrl = "";
  let childExited = false;
  let launchedPid: number | undefined;
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: !useWinStealth,
    });
    // Only the new child's own stderr can establish provenance. A listener
    // racing our bind, or a profile handoff to an existing Chromium, cannot.
    let partial = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (announcedUrl) return;
      const lines = (partial + chunk).split("\n");
      partial = (lines.pop() ?? "").slice(-2048);
      for (const line of lines) {
        const match = /^DevTools listening on (ws:\/\/\S+)\s*$/.exec(line);
        if (match) announcedUrl = match[1];
      }
    });
    (child.stderr as typeof child.stderr & { unref?(): void }).unref?.();
    child.once("error", () => { childExited = true; });
    child.once("exit", () => { childExited = true; });
    launchedPid = child.pid;
    child.unref();
  } catch {
    return null;
  }

  // Record launch time/port before polling so the grace check works on re-entry.
  _managedLaunchMs = Date.now();
  _managedLaunchPort = launchPort;

  await mkdir(browserDir, { recursive: true });
  await writeFile(path.join(browserDir, "cdp-port"), String(launchPort), "utf8");
  if (launchedPid !== undefined) {
    await writeFile(path.join(browserDir, "browser-pid"), String(launchedPid), "utf8");
  }

  // Authenticate the listening endpoint against the child's announcement before
  // publishing its identity. Windows applies stealth on verified daemon connect.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !childExited) {
    if (announcedUrl) {
      const url = new URL(announcedUrl);
      if (PROBE_HOSTS.includes(url.hostname) && Number(url.port) === launchPort &&
          /^\/devtools\/browser\/[\w-]+$/.test(url.pathname)) {
        const version = await fetch(`http://${url.host}/json/version`, {
          redirect: "error", signal: AbortSignal.timeout(1200),
        }).then(r => r.ok ? (r.json() as Promise<{ webSocketDebuggerUrl?: unknown }>) : null).catch(() => null);
        if (version?.webSocketDebuggerUrl === announcedUrl && !childExited) {
          const file = path.join(browserDir, "debugger-url");
          const tmp = `${file}.${randomUUID()}.tmp`;
          await writeFile(tmp, announcedUrl, { mode: 0o600 });
          await rename(tmp, file);
          return { host: url.hostname, port: launchPort };
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return null;
}
