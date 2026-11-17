/**
 * Per-action command timeout policy (issue #30).
 *
 * A single fixed 30 s budget killed slow-but-healthy commands (full-page
 * screenshots, heavy eval, site adapters) and — because the client used the
 * same 30 s as the daemon — the client always gave up first, so the daemon's
 * more specific timeout reason never reached the caller.
 *
 * Policy:
 *   - every action has a tier budget (default 30 s, slow actions 60 s,
 *     site_run 120 s; `wait` = its own `ms` + headroom)
 *   - `BB_COMMAND_TIMEOUT_<ACTION>_MS` overrides one action exactly
 *   - `BB_COMMAND_TIMEOUT_MS` raises the floor for every action
 *   - `request.timeoutMs` (set by the client) wins on the daemon side, so the
 *     caller's environment is the source of truth even when the daemon was
 *     started by another process (e.g. the Windows tray)
 *   - the client waits budget + CLIENT_TIMEOUT_GRACE_MS, so the daemon's
 *     structured timeout response always arrives before the client gives up
 */

import { COMMAND_TIMEOUT } from "./constants.js";

/** Lowest / highest budget accepted from env or request.timeoutMs. */
export const MIN_COMMAND_TIMEOUT_MS = 1_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/** Extra time the client waits beyond the daemon budget. */
export const CLIENT_TIMEOUT_GRACE_MS = 5_000;

/** Headroom added on top of `wait`'s own duration. */
const WAIT_HEADROOM_MS = 5_000;

const SLOW_TIMEOUT = 60_000;
const LONG_TIMEOUT = 120_000;

/** Tier budgets for actions that are routinely slower than the default. */
export const ACTION_TIMEOUTS: Readonly<Record<string, number>> = {
  screenshot: SLOW_TIMEOUT,
  eval: SLOW_TIMEOUT,
  snapshot: SLOW_TIMEOUT,
  open: SLOW_TIMEOUT,
  refresh: SLOW_TIMEOUT,
  back: SLOW_TIMEOUT,
  forward: SLOW_TIMEOUT,
  site_update: SLOW_TIMEOUT,
  site_run: LONG_TIMEOUT,
};

function clamp(ms: number): number {
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(MIN_COMMAND_TIMEOUT_MS, Math.floor(ms)));
}

function envMs(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? clamp(n) : undefined;
}

/** Name of the per-action override env var, e.g. `BB_COMMAND_TIMEOUT_SITE_RUN_MS`. */
export function actionTimeoutEnvName(action: string): string {
  return `BB_COMMAND_TIMEOUT_${action.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MS`;
}

export interface TimeoutRequestLike {
  action?: string;
  ms?: number;
  timeoutMs?: number;
}

/**
 * Daemon-side execution budget for one request, in ms. Covers waiting for
 * CDP, waiting for a scheduler slot and the dispatch itself.
 */
export function commandTimeoutMs(
  request: TimeoutRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0) {
    return clamp(request.timeoutMs);
  }
  const action = request.action ?? "";
  const exact = action ? envMs(env, actionTimeoutEnvName(action)) : undefined;
  if (exact !== undefined) return exact;

  let budget = ACTION_TIMEOUTS[action] ?? COMMAND_TIMEOUT;
  if (action === "wait" && typeof request.ms === "number" && request.ms > 0) {
    budget = Math.max(budget, request.ms + WAIT_HEADROOM_MS);
  }
  const floor = envMs(env, "BB_COMMAND_TIMEOUT_MS");
  if (floor !== undefined) budget = Math.max(budget, floor);
  return clamp(budget);
}

/** How long the HTTP client should wait for a /command response. */
export function clientCommandTimeoutMs(
  request: TimeoutRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return commandTimeoutMs(request, env) + CLIENT_TIMEOUT_GRACE_MS;
}

/**
 * Where a command timed out:
 *   - cdp_connect — the browser/CDP connection never became ready
 *   - queue       — waited for a scheduler slot (other commands hogging it)
 *   - cdp         — a CDP call to the browser never answered
 *   - dispatch    — daemon-side work (tab lock, polling) did not finish
 */
export type CommandTimeoutKind = "cdp_connect" | "queue" | "cdp" | "dispatch";

export interface CommandTimeoutInfo {
  kind: CommandTimeoutKind;
  action: string;
  budgetMs: number;
  elapsedMs: number;
  /** The oldest CDP method still waiting when the timeout fired (kind=cdp). */
  cdpMethod?: string;
  /** Age of that CDP call, ms. */
  cdpPendingMs?: number;
}
