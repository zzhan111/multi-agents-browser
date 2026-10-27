/**
 * AgentSession — per-caller "current tab" state so that multiple MCP clients
 * can work in parallel without sharing a single global currentTargetId.
 *
 * Identity is opt-in: callers pass X-BB-Session (HTTP) / env BB_SESSION_ID.
 * A missing header falls back to the "default" session so old clients are
 * unaffected.
 */

export type SessionScope = "full" | "read-only" | "no-eval";

export interface AgentSession {
  id: string;
  label?: string;
  /** Stable cross-restart agent identity (from AgentRegistry). */
  agentId?: string;
  /** The most recently selected/opened tab for this session. */
  currentTargetId?: string;
  /**
   * Permission scope for this session.
   *   full      — all commands (default, existing behaviour)
   *   read-only — observe-only: snapshot/get/screenshot/network/console/errors/tab_list/history/wait
   *   no-eval   — everything except eval and trace-start (which both run Runtime.evaluate)
   */
  scope: SessionScope;
  lastSeen: number;
}

/** Numeric rank: lower = more restrictive. Used to prevent scope escalation. */
const SCOPE_RANK: Record<SessionScope, number> = {
  "read-only": 0,
  "no-eval":   1,
  "full":      2,
};

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();

  getOrCreate(id: string, label?: string, scope?: SessionScope, agentId?: string): AgentSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, label, agentId, scope: scope ?? "full", lastSeen: Date.now() };
      this.sessions.set(id, session);
    } else {
      session.lastSeen = Date.now();
      if (label) session.label = label;
      if (agentId) session.agentId = agentId;
      // Scope can be tightened on reconnect but never widened for an existing session.
      if (scope && SCOPE_RANK[scope] < SCOPE_RANK[session.scope]) {
        session.scope = scope;
      }
    }
    return session;
  }

  all(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  /** Remove sessions idle for longer than maxIdleMs; returns the removed IDs. */
  gcIdle(maxIdleMs: number, now = Date.now()): string[] {
    const removed: string[] = [];
    for (const [id, s] of this.sessions) {
      if (s.lastSeen < now - maxIdleMs) {
        this.sessions.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
}

/**
 * Drop sessions that sent nothing for maxIdleMs and release the tab leases
 * they still hold, so an agent that exits without `tab release` does not lock
 * its tabs until the daemon restarts.
 */
export function expireIdleSessions(
  sessions: SessionManager,
  tabs: Array<{ leaseOwner?: string; leaseMode: "shared" | "exclusive" }>,
  maxIdleMs: number,
  now = Date.now(),
): string[] {
  const removed = new Set(sessions.gcIdle(maxIdleMs, now));
  for (const tab of tabs) {
    if (tab.leaseOwner && removed.has(tab.leaseOwner)) {
      tab.leaseOwner = undefined;
      tab.leaseMode = "shared";
    }
  }
  return [...removed];
}
