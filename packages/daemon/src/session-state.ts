/**
 * AgentSession — per-caller "current tab" state so that multiple MCP clients
 * can work in parallel without sharing a single global currentTargetId.
 *
 * Identity is opt-in: callers pass X-BB-Session (HTTP) / env BB_SESSION_ID.
 * A missing header falls back to the "default" session so old clients are
 * unaffected.
 */

export interface AgentSession {
  id: string;
  label?: string;
  /** The most recently selected/opened tab for this session. */
  currentTargetId?: string;
  lastSeen: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();

  getOrCreate(id: string, label?: string): AgentSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, label, lastSeen: Date.now() };
      this.sessions.set(id, session);
    } else {
      session.lastSeen = Date.now();
      if (label) session.label = label;
    }
    return session;
  }

  all(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  /** Remove sessions idle for longer than maxIdleMs. */
  gcIdle(maxIdleMs: number): void {
    const cutoff = Date.now() - maxIdleMs;
    for (const [id, s] of this.sessions) {
      if (s.lastSeen < cutoff) this.sessions.delete(id);
    }
  }
}
