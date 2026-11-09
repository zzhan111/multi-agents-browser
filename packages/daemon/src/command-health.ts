/**
 * CommandHealth — tracks whether /command is actually making progress, so
 * /status can report a half-dead daemon ("can list tabs but screenshot never
 * returns") instead of just `cdpConnected: true` (issue #30).
 *
 * Signals:
 *   - lastCommandAt / lastSuccessAt / lastTimeoutAt
 *   - consecutiveTimeouts (reset by any successful command) + per-kind totals
 *   - orphaned commands: timed out, but their dispatch is still running in the
 *     background — the clearest sign of a wedged tab or browser
 *   - in-flight commands with their age
 *   - event-loop lag (sampled by drift of a periodic timer)
 *
 * Pure bookkeeping; the HTTP layer feeds it and adds CDP-side facts at
 * snapshot time.
 */

import type { CommandTimeoutInfo, CommandTimeoutKind } from "@ma-browser/shared";

export type HealthState = "ok" | "degraded" | "stalled" | "disconnected";

/** Consecutive timeouts after which the daemon is reported as stalled. */
export const STALLED_AFTER_TIMEOUTS = 3;
/** Event-loop lag (ms) that marks the daemon degraded / stalled. */
export const LAG_DEGRADED_MS = 500;
export const LAG_STALLED_MS = 2_000;
/** Window over which the max event-loop lag is reported. */
const LAG_WINDOW_MS = 30_000;

interface Inflight {
  action: string;
  sessionId: string;
  startedAt: number;
  orphaned: boolean;
}

export interface HealthExtras {
  cdpConnected: boolean;
  cdpPending?: { count: number; oldestMethod?: string; oldestAgeMs?: number };
}

export interface HealthSnapshot {
  state: HealthState;
  reasons: string[];
  hint?: string;
  lastCommandAt: number | null;
  lastSuccessAt: number | null;
  lastTimeoutAt: number | null;
  consecutiveTimeouts: number;
  timeouts: Record<CommandTimeoutKind, number>;
  lastError: { at: number; action: string; message: string; timeout?: CommandTimeoutInfo } | null;
  inflight: Array<{ action: string; sessionId: string; ageMs: number; orphaned?: true }>;
  orphanedCommands: number;
  eventLoopLagMs: number;
  cdpPending?: HealthExtras["cdpPending"];
}

export class CommandHealth {
  private nextToken = 1;
  private readonly inflight = new Map<number, Inflight>();
  private lastCommandAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastTimeoutAt: number | null = null;
  private consecutiveTimeouts = 0;
  private readonly timeouts: Record<CommandTimeoutKind, number> = {
    cdp_connect: 0,
    queue: 0,
    cdp: 0,
    dispatch: 0,
  };
  private lastError: HealthSnapshot["lastError"] = null;
  private lagSamples: Array<{ at: number; lagMs: number }> = [];
  private lagTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Register a command; returns a token for {@link finish} / {@link timedOut}. */
  start(action: string, sessionId: string): number {
    const token = this.nextToken++;
    const at = this.now();
    this.lastCommandAt = at;
    this.inflight.set(token, { action, sessionId, startedAt: at, orphaned: false });
    return token;
  }

  /**
   * The command settled. A command that already timed out (orphaned) is only
   * removed from the in-flight list — its late result does not count as a
   * success or failure, the caller already got the timeout.
   */
  finish(token: number, ok: boolean, error?: string): void {
    const entry = this.inflight.get(token);
    if (!entry) return;
    this.inflight.delete(token);
    if (entry.orphaned) return;
    if (ok) {
      this.lastSuccessAt = this.now();
      this.consecutiveTimeouts = 0;
    } else if (error) {
      this.lastError = { at: this.now(), action: entry.action, message: error };
    }
  }

  /**
   * The command exceeded its budget. For kind=queue/cdp_connect nothing is
   * left running, so the entry is dropped; otherwise it stays as orphaned
   * until the background dispatch settles (pass `stillRunning`).
   */
  timedOut(token: number, info: CommandTimeoutInfo, message: string, stillRunning: boolean): void {
    const at = this.now();
    const entry = this.inflight.get(token);
    if (entry && stillRunning) entry.orphaned = true;
    else this.inflight.delete(token);
    this.lastTimeoutAt = at;
    this.consecutiveTimeouts += 1;
    this.timeouts[info.kind] += 1;
    this.lastError = { at, action: info.action, message, timeout: info };
  }

  /** Commands that timed out but whose dispatch is still running. */
  orphanedCount(): number {
    let n = 0;
    for (const e of this.inflight.values()) if (e.orphaned) n += 1;
    return n;
  }

  /** Record one event-loop lag sample (ms the timer fired late). */
  recordLag(lagMs: number): void {
    const at = this.now();
    this.lagSamples.push({ at, lagMs: Math.max(0, Math.round(lagMs)) });
    const cutoff = at - LAG_WINDOW_MS;
    while (this.lagSamples.length > 0 && this.lagSamples[0].at < cutoff) this.lagSamples.shift();
  }

  /** Start sampling event-loop lag every `intervalMs` (unref'd timer). */
  startLagMonitor(intervalMs = 500): void {
    if (this.lagTimer) return;
    let expected = Date.now() + intervalMs;
    this.lagTimer = setInterval(() => {
      const t = Date.now();
      this.recordLag(t - expected);
      expected = t + intervalMs;
    }, intervalMs);
    this.lagTimer.unref?.();
  }

  stopLagMonitor(): void {
    if (this.lagTimer) clearInterval(this.lagTimer);
    this.lagTimer = null;
  }

  snapshot(extras: HealthExtras): HealthSnapshot {
    const now = this.now();
    const eventLoopLagMs = this.lagSamples.reduce((m, s) => Math.max(m, s.lagMs), 0);
    const inflight = [...this.inflight.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, 10)
      .map((e) => ({
        action: e.action,
        sessionId: e.sessionId,
        ageMs: now - e.startedAt,
        ...(e.orphaned ? { orphaned: true as const } : {}),
      }));
    const orphanedCommands = this.orphanedCount();

    const reasons: string[] = [];
    let state: HealthState = "ok";
    const escalate = (to: HealthState, reason: string) => {
      reasons.push(reason);
      const rank: Record<HealthState, number> = { ok: 0, degraded: 1, stalled: 2, disconnected: 3 };
      if (rank[to] > rank[state]) state = to;
    };

    if (!extras.cdpConnected) escalate("disconnected", "CDP not connected");
    if (this.consecutiveTimeouts >= STALLED_AFTER_TIMEOUTS) {
      escalate("stalled", `${this.consecutiveTimeouts} consecutive command timeouts`);
    } else if (this.consecutiveTimeouts > 0) {
      escalate("degraded", `${this.consecutiveTimeouts} consecutive command timeout(s)`);
    }
    if (orphanedCommands > 0) {
      escalate("degraded", `${orphanedCommands} timed-out command(s) still running`);
    }
    if (eventLoopLagMs >= LAG_STALLED_MS) escalate("stalled", `event loop lag ${eventLoopLagMs}ms`);
    else if (eventLoopLagMs >= LAG_DEGRADED_MS) escalate("degraded", `event loop lag ${eventLoopLagMs}ms`);

    return {
      state,
      reasons,
      hint: state === "ok" ? undefined : recoveryHint(state, this.lastError?.timeout?.kind, eventLoopLagMs),
      lastCommandAt: this.lastCommandAt,
      lastSuccessAt: this.lastSuccessAt,
      lastTimeoutAt: this.lastTimeoutAt,
      consecutiveTimeouts: this.consecutiveTimeouts,
      timeouts: { ...this.timeouts },
      lastError: this.lastError,
      inflight,
      orphanedCommands,
      eventLoopLagMs,
      ...(extras.cdpPending ? { cdpPending: extras.cdpPending } : {}),
    };
  }
}

/** Human-readable recovery path for a non-ok state. */
export function recoveryHint(
  state: HealthState,
  lastKind: CommandTimeoutKind | undefined,
  eventLoopLagMs = 0,
): string {
  if (state === "disconnected") {
    return "Browser/CDP is not connected. Windows tray: `ma-browser mode headed` restarts the managed browser; otherwise restart the browser, then `ma-browser tab list`.";
  }
  if (eventLoopLagMs >= LAG_STALLED_MS) {
    return "The daemon event loop is blocked. Restart it: `ma-browser daemon shutdown` (the tray or the next CLI call starts a fresh one).";
  }
  switch (lastKind) {
    case "cdp":
      return "The browser stopped answering CDP calls. Dismiss any open dialog (`ma-browser dialog accept`) or close the wedged tab (`ma-browser tab close --id <tab>`); if it persists, restart the browser (`ma-browser mode headed` on the Windows tray).";
    case "queue":
      return "Commands are queued behind slow or stuck ones. Check `ma-browser status --json` → health.inflight; close the tab they target or restart the browser.";
    case "cdp_connect":
      return "The browser connection did not become ready. Restart the browser (`ma-browser mode headed` on the Windows tray) and retry.";
    default:
      return "Commands are timing out inside the daemon. Close the target tab and retry; if it persists, `ma-browser daemon shutdown` to restart the daemon.";
  }
}
