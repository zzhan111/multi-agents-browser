import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProcessHint {
  port: number;
  pid: number;
  userDataDir?: string;
}

export function readDevToolsActivePort(userDataDir: string): number | null {
  try {
    const port = Number(readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0].trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** Split a command line on spaces outside double quotes, dropping the quotes. */
export function splitCommandLine(line: string): string[] {
  return (line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((t) => t.replace(/"/g, ""));
}

export function hintFromArgs(args: string[], pid: number): ProcessHint | null {
  if (args.some((a) => a.startsWith("--type="))) return null;
  let port: number | undefined;
  let userDataDir: string | undefined;
  for (const a of args) {
    const p = /^--remote-debugging-port=(\d+)$/.exec(a);
    if (p) port = Number(p[1]);
    const d = /^--user-data-dir=(.+)$/.exec(a);
    if (d) userDataDir = d[1].replace(/^"|"$/g, "");
  }
  if (port === undefined) return null;
  if (port === 0 && userDataDir) port = readDevToolsActivePort(userDataDir) ?? 0;
  return port > 0 ? { port, pid, userDataDir } : null;
}

export function defaultUserDataDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"].map((d) => path.join(base, d));
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return ["Google/Chrome/User Data", "Google/Chrome Beta/User Data", "Google/Chrome SxS/User Data", "Chromium/User Data", "Microsoft/Edge/User Data", "BraveSoftware/Brave-Browser/User Data"].map((d) => path.join(base, d));
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"].map((d) => path.join(base, d));
}

function normalizeUserDataDir(dir: string): string {
  const resolved = path.resolve(dir).replace(/(?:\|\/)+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `userDataDir` points to a standard browser profile shared with daily windows. */
export function isDefaultUserDataDir(userDataDir?: string): boolean {
  if (!userDataDir || !userDataDir.trim()) return true;
  const target = normalizeUserDataDir(userDataDir);
  return defaultUserDataDirs().some((d) => normalizeUserDataDir(d) === target);
}

/** True only when a process explicitly runs under its own non-default `--user-data-dir`. */
export function isIsolatedUserDataDir(userDataDir?: string): boolean {
  return Boolean(userDataDir && userDataDir.trim() && !isDefaultUserDataDir(userDataDir));
}
