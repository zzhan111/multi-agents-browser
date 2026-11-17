/**
 * CDP discovery — find Chromium browsers on this machine that already expose a
 * remote-debugging endpoint, so ma-browser can attach to them instead of
 * launching its own managed browser.
 *
 * Shared by the CLI (cold start, before spawning the daemon) and the daemon
 * (bring-up loop, `cdp_list` / `cdp_attach`), so both pick the same browser.
 *
 * Sources, all loopback-only:
 *   - well-known ports (9222, 9229, the managed chain 19825..19865) plus
 *     `BB_CDP_SCAN_PORTS` (e.g. "9300,9400-9410")
 *   - `--remote-debugging-port=N` in running browser command lines
 *   - `DevToolsActivePort` files in default and process-derived profiles
 *     (covers `--remote-debugging-port=0`)
 *
 * Non-loopback endpoints are never scanned; they must be named explicitly.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CDP_PORT,
  MANAGED_PID_FILE,
  MANAGED_PORT_FILE,
  MANAGED_USER_DATA_DIR,
  PROBE_HOSTS,
  launchManagedBrowser,
} from "./browser-launcher.js";

export interface CdpEndpoint {
  /** Browser ID used by `--browser` / `cdp detach`: the port for loopback, else host:port. */
  id: string;
  host: string;
  port: number;
  /** e.g. "Chrome/130.0.6723.116" or "HeadlessChrome/…" */
  browser: string;
  webSocketDebuggerUrl: string;
  /** Number of page targets. */
  tabs: number;
  /** True for ma-browser's own managed browser (dedicated profile). */
  managed: boolean;
  userDataDir?: string;
  pid?: number;
}

export interface CdpAddress {
  host: string;
  port: number;
}

const PROBE_TIMEOUT_MS = 1200;

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** Stable browser ID: the bare port for loopback (IPv4 and IPv6 are one browser), else host:port. */
export function browserIdFor(host: string, port: number): string {
  return isLoopbackHost(host) ? String(port) : `${host}:${port}`;
}

/** Parse "9222", "host:9222", "[::1]:9222", "http://host:9222" or a ws:// debugger URL. */
export function parseCdpAddress(ref: string | number): CdpAddress | null {
  const raw = String(ref).trim();
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    return port > 0 && port < 65536 ? { host: "127.0.0.1", port } : null;
  }
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port <= 0) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

/** `BB_CDP_DISCOVERY`: "0" disables scanning, "all" also auto-attaches everything found. Default on. */
export function cdpDiscoveryMode(): "off" | "on" | "all" {
  const v = (process.env.BB_CDP_DISCOVERY ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false") return "off";
  if (v === "all") return "all";
  return "on";
}

/** Explicit endpoints from `BB_BROWSER_CDP_URL` and the comma-separated `BB_BROWSER_CDP_URLS`. */
export function envCdpAddresses(): CdpAddress[] {
  const raw = [process.env.BB_BROWSER_CDP_URL ?? "", ...(process.env.BB_BROWSER_CDP_URLS ?? "").split(",")];
  const out: CdpAddress[] = [];
  for (const item of raw) {
    const addr = item.trim() ? parseCdpAddress(item) : null;
    if (addr && !out.some((a) => browserIdFor(a.host, a.port) === browserIdFor(addr.host, addr.port))) out.push(addr);
  }
  return out;
}

function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .finally(() => clearTimeout(timer));
}

function bracket(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function inspectHost(host: string, port: number, timeoutMs: number): Promise<CdpEndpoint | null> {
  const base = `http://${bracket(host)}:${port}`;
  try {
    const version = (await fetchJson(`${base}/json/version`, timeoutMs)) as Record<string, unknown>;
    const ws = version.webSocketDebuggerUrl;
    // Node's inspector (often on 9229) answers /json/version without a browser socket.
    if (typeof ws !== "string" || !ws.includes("/devtools/browser/")) return null;
    let tabs = 0;
    try {
      const list = (await fetchJson(`${base}/json/list`, timeoutMs)) as Array<{ type?: string }>;
      tabs = Array.isArray(list) ? list.filter((t) => t.type === "page").length : 0;
    } catch {}
    return {
      id: browserIdFor(host, port),
      host: bracket(host),
      port,
      browser: String(version.Browser ?? version.browser ?? "unknown"),
      webSocketDebuggerUrl: ws,
      tabs,
      managed: false,
    };
  } catch {
    return null;
  }
}

/**
 * Check that `host:port` is a controllable browser endpoint. Loopback is probed
 * on both IPv4 and IPv6, since some browsers bind only `::1`.
 */
export async function inspectCdp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<CdpEndpoint | null> {
  const hosts = isLoopbackHost(host) ? PROBE_HOSTS : [host];
  const results = await Promise.all(hosts.map((h) => inspectHost(h, port, timeoutMs)));
  return results.find((r) => r !== null) ?? null;
}

/** A readable reason why `host:port` can't be attached, with the next step. */
export async function explainCdpFailure(host: string, port: number): Promise<string> {
  const target = `${host}:${port}`;
  const open = await new Promise<"open" | "refused" | "timeout">((resolve) => {
    const socket = connect({ host: host.replace(/^\[|\]$/g, ""), port });
    const done = (r: "open" | "refused" | "timeout") => { socket.destroy(); resolve(r); };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done("timeout"));
    socket.once("connect", () => done("open"));
    socket.once("error", () => done("refused"));
  });
  if (open === "refused") {
    return `Nothing is listening on ${target}. Start Chrome with --remote-debugging-port=${port} ` +
      `(Chrome 136+ also requires a non-default --user-data-dir), or run: ma-browser cdp list`;
  }
  if (open === "timeout") return `Connection to ${target} timed out. Check the host/firewall, or run: ma-browser cdp list`;
  return `Port ${port} is open but is not a Chrome DevTools endpoint (no browser websocket at /json/version). ` +
    `Pick another port from: ma-browser cdp list`;
}

// ---------------------------------------------------------------------------
// Candidate sources
// ---------------------------------------------------------------------------

function parsePortList(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = Math.min(Number(m[2] ?? m[1]), lo + 200);
    for (let p = lo; p <= hi; p++) if (p > 0 && p < 65536) out.push(p);
  }
  return out;
}

/** Ports scanned by default: 9222, 9229, the managed odd-port chain, and `BB_CDP_SCAN_PORTS`. */
export function defaultScanPorts(): number[] {
  const ports = [9222, 9229];
  for (let p = DEFAULT_CDP_PORT; p <= DEFAULT_CDP_PORT + 40; p += 2) ports.push(p);
  ports.push(...parsePortList(process.env.BB_CDP_SCAN_PORTS ?? ""));
  return [...new Set(ports)];
}

interface ProcessHint {
  port: number;
  pid: number;
  userDataDir?: string;
}

function hintFromArgs(args: string[], pid: number): ProcessHint | null {
  if (args.some((a) => a.startsWith("--type="))) return null; // renderer/GPU child
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

/** Split a command line on spaces outside double quotes, dropping the quotes. */
export function splitCommandLine(line: string): string[] {
  return (line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((t) => t.replace(/"/g, ""));
}

function linuxProcessHints(): ProcessHint[] {
  const out: ProcessHint[] = [];
  let pids: string[] = [];
  try { pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const pid of pids) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!raw.includes("--remote-debugging-port=")) continue;
      // Some launchers rewrite the process title into one space-joined string.
      const args = raw.split("\0").filter(Boolean).flatMap((a) => (a.includes(" --") ? a.split(/ (?=--)/) : [a]));
      const hint = hintFromArgs(args, Number(pid));
      if (hint) out.push(hint);
    } catch {}
  }
  return out;
}

function execText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

async function psProcessHints(): Promise<ProcessHint[]> {
  const out: ProcessHint[] = [];
  for (const line of (await execText("ps", ["-axww", "-o", "pid=,command="], 3000)).split("\n")) {
    if (!line.includes("--remote-debugging-port=")) continue;
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    // macOS paths contain spaces; take the user-data-dir up to the next " --".
    const args = m[2].split(/ (?=--)/);
    const hint = hintFromArgs(args, Number(m[1]));
    if (hint) out.push(hint);
  }
  return out;
}

async function windowsProcessHints(): Promise<ProcessHint[]> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"CommandLine like '%--remote-debugging-port=%'\" | " +
    "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const raw = await execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8000);
  const out: ProcessHint[] = [];
  try {
    const parsed = JSON.parse(raw) as { ProcessId: number; CommandLine: string } | Array<{ ProcessId: number; CommandLine: string }>;
    for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!p?.CommandLine) continue;
      const hint = hintFromArgs(splitCommandLine(p.CommandLine), p.ProcessId);
      if (hint) out.push(hint);
    }
  } catch {}
  return out;
}

/**
 * Debug-port hints from running browser command lines. Windows needs a slow
 * CIM query (~1s), so it only runs when `thorough` is set (`cdp list`).
 */
export async function processHints(thorough: boolean): Promise<ProcessHint[]> {
  if (process.platform === "linux") return linuxProcessHints();
  if (process.platform === "darwin") return psProcessHints();
  if (process.platform === "win32" && thorough) return windowsProcessHints();
  return [];
}

function readDevToolsActivePort(userDataDir: string): number | null {
  try {
    const port = Number(readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0].trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function defaultUserDataDirs(): string[] {
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

function managedPort(): number | null {
  try {
    const port = Number(readFileSync(MANAGED_PORT_FILE, "utf8").trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function managedPid(): number | null {
  try {
    const pid = Number(readFileSync(MANAGED_PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  /** Also run slow process heuristics (Windows CIM). Default false. */
  thorough?: boolean;
  /** Ports to probe instead of defaultScanPorts() (tests). */
  ports?: number[];
  /** Read process command lines and DevToolsActivePort files. Default true. */
  processes?: boolean;
}

/** Every controllable loopback CDP endpoint on this machine, sorted by port. */
export async function discoverCdpEndpoints(options: DiscoverOptions = {}): Promise<CdpEndpoint[]> {
  const useProcesses = options.processes !== false;
  const hints = useProcesses ? await processHints(options.thorough ?? false) : [];
  const mPort = managedPort();
  const ports = new Set<number>(options.ports ?? defaultScanPorts());
  if (mPort && useProcesses) ports.add(mPort);
  for (const h of hints) ports.add(h.port);
  for (const dir of useProcesses ? defaultUserDataDirs() : []) {
    const p = readDevToolsActivePort(dir);
    if (p) ports.add(p);
  }

  const found = (await Promise.all([...ports].map((p) => inspectCdp("127.0.0.1", p)))).filter(
    (e): e is CdpEndpoint => e !== null,
  );

  const mPid = managedPid();
  const seen = new Set<string>();
  const out: CdpEndpoint[] = [];
  for (const ep of found.sort((a, b) => a.port - b.port)) {
    if (seen.has(ep.webSocketDebuggerUrl)) continue;
    seen.add(ep.webSocketDebuggerUrl);
    const hint = hints.find((h) => h.port === ep.port);
    if (hint) {
      ep.pid = hint.pid;
      ep.userDataDir = hint.userDataDir;
    }
    ep.managed = ep.userDataDir
      ? samePath(ep.userDataDir, MANAGED_USER_DATA_DIR)
      : ep.port === mPort || (mPid !== null && ep.pid === mPid);
    out.push(ep);
  }
  return out;
}

export interface ResolvedCdp extends CdpAddress {
  source: "explicit" | "managed" | "discovered" | "launched";
}

export interface ResolveOptions {
  /** Explicit endpoints (`--port`, `BB_BROWSER_CDP_URL[S]`, daemon `--cdp-port`), tried first in order. */
  explicit?: CdpAddress[];
  /** Browser IDs to skip (already held by another connection). */
  exclude?: Set<string>;
  /** Launch the managed browser if nothing else is found. Default true. */
  launch?: boolean;
  /** Port for a managed launch. */
  launchPort?: number;
  /** Discovery inputs (tests). */
  discover?: DiscoverOptions;
}

/**
 * Pick the browser to drive, in priority order:
 *   explicit URL/port > running managed browser > discovered user browser > managed launch.
 *
 * The running managed browser wins over other discovered browsers so a daemon
 * restart keeps the agent's profile; other browsers stay available through
 * `cdp attach` (or `BB_CDP_DISCOVERY=all`). Scanning is skipped when
 * `BB_CDP_DISCOVERY=0`.
 */
export async function resolveCdpEndpoint(options: ResolveOptions = {}): Promise<ResolvedCdp | null> {
  const exclude = options.exclude ?? new Set<string>();
  const usable = (host: string, port: number) => !exclude.has(browserIdFor(host, port));

  for (const addr of options.explicit ?? []) {
    if (!usable(addr.host, addr.port)) continue;
    const ep = await inspectCdp(addr.host, addr.port);
    if (ep) return { host: ep.host, port: ep.port, source: "explicit" };
  }

  const mPort = managedPort();
  if (mPort && usable("127.0.0.1", mPort)) {
    const ep = await inspectCdp("127.0.0.1", mPort);
    if (ep) return { host: ep.host, port: ep.port, source: "managed" };
  }

  if (cdpDiscoveryMode() !== "off") {
    const found = (await discoverCdpEndpoints(options.discover)).filter((e) => usable(e.host, e.port));
    const pick = found.find((e) => !e.managed) ?? found[0];
    if (pick) return { host: pick.host, port: pick.port, source: "discovered" };
  }

  if (options.launch === false) return null;
  const launchPort = options.launchPort ?? DEFAULT_CDP_PORT;
  if (!usable("127.0.0.1", launchPort)) return null;
  const launched = await launchManagedBrowser(launchPort);
  return launched ? { ...launched, source: "launched" } : null;
}
