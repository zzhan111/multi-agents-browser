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
 * Keeping this in one place ensures both paths agree on the managed
 * user-data dir, the port file, and the launch flags.
 */

import { execFile, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DAEMON_DIR } from "./daemon-client.js";

/** Default CDP debugging port (odd chain start). */
export const DEFAULT_CDP_PORT = 19825;

/** Directory holding managed-browser bookkeeping. */
export const MANAGED_BROWSER_DIR = path.join(DAEMON_DIR, "browser");

/** File recording the port of the managed browser, if any. */
export const MANAGED_PORT_FILE = path.join(MANAGED_BROWSER_DIR, "cdp-port");

const LOCAL_CHROME_USER_DATA_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "360ChromeX",
  "Chrome",
  "User Data",
);
const MANAGED_USER_DATA_DIR = LOCAL_CHROME_USER_DATA_DIR;

/** Probe a CDP endpoint by hitting /json/version. */
async function canConnect(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(`http://${host}:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/** Run a command, resolving with stdout (empty string on any error). */
function runCmd(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // windowsHide prevents a console window ("黑框") flashing when the daemon
    // (a windowless GUI subprocess) shells out to taskkill/tasklist.
    execFile(command, args, { encoding: "utf8", windowsHide: true }, (_err, stdout) => {
      resolve(stdout ?? "");
    });
  });
}

/** True if at least one process with the given executable image is running. */
async function isBrowserRunning(image: string): Promise<boolean> {
  if (process.platform === "win32") {
    const out = await runCmd("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"]);
    return out.toLowerCase().includes(image.toLowerCase());
  }
  const out = await runCmd("pgrep", ["-x", image]);
  return out.trim().length > 0;
}

/**
 * True if the browser bb-browser would manage (the one returned by
 * {@link findBrowserExecutable}) currently has a process running — regardless
 * of whether it has remote debugging enabled. Used to decide whether closing
 * it (to relaunch with debugging) would disrupt the user.
 */
export async function isConfiguredBrowserRunning(): Promise<boolean> {
  const exe = findBrowserExecutable();
  if (!exe) return false;
  return isBrowserRunning(path.basename(exe));
}

/**
 * Forcefully close every process matching the given executable image, then
 * wait (up to ~5s) for them to exit so the browser's single-instance lock on
 * the profile is released before we relaunch.
 *
 * Note: a normally-launched browser has no `--user-data-dir` marker on its
 * command line, so there is no reliable way to target only the processes
 * using a specific profile — we close instances by image name.
 */
async function killBrowserProcesses(image: string): Promise<void> {
  if (process.platform === "win32") {
    await runCmd("taskkill", ["/F", "/T", "/IM", image]);
  } else {
    await runCmd("pkill", ["-x", image]);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await isBrowserRunning(image))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
      // 360ChromeX
      ...(localAppData ? [`${localAppData}/360ChromeX/Chrome/Application/360ChromeX.exe`] : []),
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

/** Options for {@link launchManagedBrowser}. */
export interface LaunchManagedBrowserOptions {
  /**
   * When true and no debuggable endpoint is reachable, close any already-
   * running instance of the browser first, then relaunch the SAME (real)
   * profile with remote debugging enabled.
   *
   * This is required when the user's browser is already open normally:
   * Chrome's single-instance model would otherwise hand our launch off to
   * the existing (non-debuggable) process and never expose a CDP port.
   * Because it reuses the real profile on disk, logins are preserved.
   */
  killExisting?: boolean;
}

/**
 * Launch a managed Chromium browser on the given CDP port and wait until it
 * is reachable. Writes the resolved port to MANAGED_PORT_FILE so other
 * processes (and the daemon's own fallback) can find it. Returns null if no
 * browser executable is found or it never becomes reachable.
 */
export async function launchManagedBrowser(
  port: number = DEFAULT_CDP_PORT,
  options: LaunchManagedBrowserOptions = {},
): Promise<{ host: string; port: number } | null> {
  const executable = findBrowserExecutable();
  if (!executable) {
    return null;
  }

  // Already debuggable on this port? Nothing to launch.
  if (await canConnect("127.0.0.1", port)) {
    return { host: "127.0.0.1", port };
  }

  // The user's browser may already be open without remote debugging. Its
  // single-instance lock would swallow our launch and never expose a CDP
  // port. Two cases:
  const image = path.basename(executable);
  const running = await isBrowserRunning(image);
  if (running) {
    if (options.killExisting) {
      // Consent given — close it and relaunch the same profile with debugging.
      // eslint-disable-next-line no-console
      console.error(
        `[bb-browser] closing running ${image} to relaunch with remote debugging (real profile, logins preserved)...`,
      );
      await killBrowserProcesses(image);
    } else {
      // No consent — do NOT spawn (it would just open a junk tab in the
      // user's session via the single-instance handoff, without exposing a
      // port). Bail so the caller keeps waiting for the user to act.
      // eslint-disable-next-line no-console
      console.error(
        `[bb-browser] ${image} is running without remote debugging and close-and-relaunch is not authorized; not launching.`,
      );
      return null;
    }
  }

  await mkdir(MANAGED_USER_DATA_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${MANAGED_USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--use-mock-keychain",
    "about:blank",
  ];

  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    return null;
  }

  await mkdir(MANAGED_BROWSER_DIR, { recursive: true });
  await writeFile(MANAGED_PORT_FILE, String(port), "utf8");

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await canConnect("127.0.0.1", port)) {
      return { host: "127.0.0.1", port };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}
