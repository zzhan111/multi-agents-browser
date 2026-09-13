/**
 * Daemon listen / advertise address resolution (remote takeover M1).
 *
 * Bind (`host` / `bindHost`) is where the HTTP server listens.
 * Advertise (`daemon.json` `host`) is what clients should dial.
 *
 * When remote access is off, wildcard binds still advertise loopback so
 * local CONNECT_ONLY and WSL rewrite keep working. When remote is on,
 * a user-chosen advertise host is never rewritten to 127.0.0.1.
 */

import { parseArgs } from "node:util";
import { DAEMON_HOST, DAEMON_PORT } from "@ma-browser/shared";

export const DEFAULT_CDP_PORT = 19825;

export interface DaemonFileInfo {
  pid: number;
  /** Address clients should connect to. */
  host: string;
  /** Address the HTTP server actually listens on. */
  bindHost: string;
  port: number;
  token: string;
  remoteAccess: boolean;
}

export interface ParsedListenArgs {
  /** HTTP listen address (bind). */
  host: string;
  /** Optional client-facing address; omitted when unset. */
  advertiseHost?: string;
  port: number;
  cdpHost: string;
  cdpPort: number;
  token: string;
  remoteAccess: boolean;
  help: boolean;
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** True for `1` / `true` / `yes` / `on` (case-insensitive). */
export function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function pickString(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return undefined;
}

/**
 * daemon.json advertises a *connectable* host.
 *
 * Remote off (today): wildcard bind (`0.0.0.0` / `::`) → `127.0.0.1`.
 * Remote on: use `advertiseHost` when set; otherwise the bind address as-is.
 * Never rewrite a remote advertise address back to `127.0.0.1`.
 */
export function advertisedHost(
  bindHost: string,
  opts: { remoteAccess?: boolean; advertiseHost?: string } = {},
): string {
  const explicit = pickString(opts.advertiseHost);
  if (opts.remoteAccess) {
    if (explicit) return explicit;
    return bindHost;
  }
  return isWildcardHost(bindHost) ? "127.0.0.1" : bindHost;
}

/**
 * Remote access is an explicit opt-in (`--remote-access` / `BB_REMOTE_ACCESS=1`)
 * plus the cases where the user already chose a non-loopback advertise or
 * bind address. Wildcard `0.0.0.0` alone stays local (advertise loopback).
 *
 * Flag wins over env when the flag is present.
 */
export function resolveRemoteAccess(input: {
  flag?: boolean;
  envValue?: string;
  bindHost: string;
  advertiseHost?: string;
}): boolean {
  if (input.flag === true) return true;
  if (envTruthy(input.envValue)) return true;
  const advertised = pickString(input.advertiseHost);
  if (advertised && !isLoopbackHost(advertised) && !isWildcardHost(advertised)) {
    return true;
  }
  if (!isLoopbackHost(input.bindHost) && !isWildcardHost(input.bindHost)) {
    return true;
  }
  return false;
}

export function buildDaemonFileInfo(input: {
  pid: number;
  bindHost: string;
  port: number;
  token: string;
  remoteAccess: boolean;
  advertiseHost?: string;
}): DaemonFileInfo {
  return {
    pid: input.pid,
    host: advertisedHost(input.bindHost, {
      remoteAccess: input.remoteAccess,
      advertiseHost: input.advertiseHost,
    }),
    bindHost: input.bindHost,
    port: input.port,
    token: input.token,
    remoteAccess: input.remoteAccess,
  };
}

export function parseListenArgs(
  argv: string[],
  env: NodeJS.Dict<string> = process.env,
): ParsedListenArgs {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: "string", short: "H" },
      port: { type: "string", short: "p" },
      "advertise-host": { type: "string" },
      "remote-access": { type: "boolean" },
      "cdp-host": { type: "string" },
      "cdp-port": { type: "string" },
      token: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const host = pickString(values.host, env.BB_DAEMON_HOST) ?? DAEMON_HOST;
  const advertiseHost = pickString(values["advertise-host"], env.BB_DAEMON_ADVERTISE_HOST);
  const remoteAccess = resolveRemoteAccess({
    flag: values["remote-access"] === true ? true : undefined,
    envValue: env.BB_REMOTE_ACCESS,
    bindHost: host,
    advertiseHost,
  });

  return {
    host,
    advertiseHost,
    port: parseInt(pickString(values.port) ?? String(DAEMON_PORT), 10),
    cdpHost: pickString(values["cdp-host"]) ?? "127.0.0.1",
    cdpPort: parseInt(pickString(values["cdp-port"]) ?? String(DEFAULT_CDP_PORT), 10),
    token: values.token ?? "",
    remoteAccess,
    help: values.help === true,
  };
}
