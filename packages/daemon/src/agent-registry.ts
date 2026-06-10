/**
 * AgentRegistry — stable, cross-restart agent identity.
 *
 * Problem: session IDs are ephemeral (per-process or per-agent-startup), so
 * per-agent memory (journal, bindings) can't key on them directly. We need a
 * stable "agentId" that survives daemon and browser restarts.
 *
 * Derivation priority (first match wins):
 *   1. x-bb-agent header  → use verbatim (agent explicitly claims identity)
 *   2. x-bb-session-label → normalise to slug → look up or create a UUID
 *   3. fallback           → sessionId used as-is (no persistence benefit,
 *                           preserves existing behaviour for anonymous agents)
 *
 * Records for cases 1 & 2 are persisted to BB_BROWSER_HOME/state/agents.json
 * via StateStore's atomic-write so they survive restarts.
 */

import { randomUUID } from "node:crypto";
import type { StateStore } from "./state-store.js";

export interface AgentRecord {
  agentId: string;
  label?: string;
  /** All session IDs this agent has connected under. */
  knownSessionIds: string[];
  firstSeen: number;
  lastSeen: number;
  /** True for cases 1 & 2 (explicit id or label-based) — persisted across restarts. */
  persistent?: boolean;
}

const FILENAME = "agents.json";

/** Maximum number of anonymous (non-persistent) records kept in memory. */
const MAX_ANON_RECORDS = 500;

/** Normalise a human label to a stable lookup key (lowercase, trimmed). */
function slugify(label: string): string {
  return label.trim().toLowerCase();
}

export class AgentRegistry {
  /** agentId → record */
  private records = new Map<string, AgentRecord>();
  /** slugified label → agentId */
  private labelIndex = new Map<string, string>();

  constructor(private readonly store: StateStore) {
    this.load();
  }

  /**
   * Resolve or create a stable agentId for the incoming request.
   * Side-effect: persists when a new record is created or an existing record's
   * sessionId / lastSeen changes.
   */
  resolveOrCreate(opts: {
    sessionId: string;
    explicitAgentId?: string;
    label?: string;
  }): AgentRecord {
    const { sessionId, explicitAgentId, label } = opts;
    const now = Date.now();

    // Case 1: caller provided an explicit stable id.
    if (explicitAgentId) {
      return this.upsert(explicitAgentId, sessionId, label, now, true);
    }

    // Case 2: label-based lookup.
    if (label) {
      const slug = slugify(label);
      const existing = this.labelIndex.get(slug);
      if (existing) {
        return this.upsert(existing, sessionId, label, now, true);
      }
      // New label — create a UUID-based agentId.
      const agentId = randomUUID();
      this.labelIndex.set(slug, agentId);
      return this.upsert(agentId, sessionId, label, now, true);
    }

    // Case 3: anonymous session — use sessionId as agentId, no persistence.
    const anon = this.records.get(sessionId);
    if (anon) {
      anon.lastSeen = now;
      if (!anon.knownSessionIds.includes(sessionId)) {
        anon.knownSessionIds.push(sessionId);
      }
      return anon;
    }
    const rec: AgentRecord = {
      agentId: sessionId,
      knownSessionIds: [sessionId],
      firstSeen: now,
      lastSeen: now,
    };
    this.records.set(sessionId, rec);
    this.evictAnonIfNeeded();
    return rec;
  }

  all(): AgentRecord[] {
    return Array.from(this.records.values());
  }

  /** Evict the oldest anonymous records when the cap is exceeded. */
  private evictAnonIfNeeded(): void {
    const anon = Array.from(this.records.values()).filter((r) => !r.persistent);
    if (anon.length <= MAX_ANON_RECORDS) return;
    anon.sort((a, b) => a.lastSeen - b.lastSeen);
    const toEvict = anon.slice(0, anon.length - MAX_ANON_RECORDS);
    for (const r of toEvict) {
      this.records.delete(r.agentId);
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): void {
    const data = this.store.read<{ records: AgentRecord[] }>(FILENAME);
    if (!data?.records) return;
    for (const rec of data.records) {
      rec.persistent = true; // loaded from disk ⇒ was intentionally saved
      this.records.set(rec.agentId, rec);
      if (rec.label) {
        this.labelIndex.set(slugify(rec.label), rec.agentId);
      }
    }
  }

  save(): void {
    const toSave = Array.from(this.records.values()).filter((r) => r.persistent);
    this.store.write(FILENAME, { records: toSave });
  }

  /**
   * Rename an existing named agent. Updates the label index so future
   * connections using the new label resolve to the same agentId.
   * Returns false if the agentId is not found or is anonymous.
   */
  updateLabel(agentId: string, label: string): boolean | "conflict" {
    const rec = this.records.get(agentId);
    if (!rec || !rec.persistent) return false;
    const trimmed = label.trim();
    if (!trimmed) return false;
    // Reject if the slug is already claimed by a different agent.
    const slug = slugify(trimmed);
    const existing = this.labelIndex.get(slug);
    if (existing && existing !== agentId) return "conflict";
    // Remove old label from index, set new one.
    if (rec.label) this.labelIndex.delete(slugify(rec.label));
    rec.label = trimmed;
    this.labelIndex.set(slug, agentId);
    this.save();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private upsert(
    agentId: string,
    sessionId: string,
    label: string | undefined,
    now: number,
    persist: boolean,
  ): AgentRecord {
    let rec = this.records.get(agentId);
    let changed = false;

    if (!rec) {
      rec = { agentId, label, knownSessionIds: [], firstSeen: now, lastSeen: now, persistent: persist };
      this.records.set(agentId, rec);
      changed = true;
    } else if (persist && !rec.persistent) {
      rec.persistent = true;
      changed = true;
    }

    if (label && rec.label !== label) {
      rec.label = label;
      changed = true;
    }

    if (!rec.knownSessionIds.includes(sessionId)) {
      rec.knownSessionIds.push(sessionId);
      changed = true;
    }

    rec.lastSeen = now;

    if (persist && changed) {
      this.save();
    }

    return rec;
  }
}
