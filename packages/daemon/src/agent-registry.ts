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
}

const FILENAME = "agents.json";

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
    return rec;
  }

  all(): AgentRecord[] {
    return Array.from(this.records.values());
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): void {
    const data = this.store.read<{ records: AgentRecord[] }>(FILENAME);
    if (!data?.records) return;
    for (const rec of data.records) {
      this.records.set(rec.agentId, rec);
      if (rec.label) {
        this.labelIndex.set(slugify(rec.label), rec.agentId);
      }
    }
  }

  save(): void {
    // Only persist named agents (cases 1 & 2); anonymous sessions are in-memory only.
    const named = Array.from(this.records.values()).filter(
      (r) => r.agentId !== r.knownSessionIds[0] || r.label,
    );
    this.store.write(FILENAME, { records: named });
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
      rec = { agentId, label, knownSessionIds: [], firstSeen: now, lastSeen: now };
      this.records.set(agentId, rec);
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
