import type { StateStore } from "./state-store.js";

export interface JournalEntry {
  seq: number;
  ts: number;
  action: string;
  tab?: string;
  url?: string;
  success: boolean;
}

/** Sanitize an agentId to a safe filename segment. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const JOURNAL_CAPACITY = (() => {
  const raw = process.env.BB_JOURNAL_CAPACITY;
  if (!raw) return 200;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 10 ? n : 200;
})();

interface JournalFile {
  entries: JournalEntry[];
  nextSeq: number;
}

class AgentJournal {
  private entries: JournalEntry[] = [];
  private nextSeq = 1;

  constructor(
    readonly agentId: string,
    private readonly store: StateStore,
  ) {
    this.load();
  }

  push(action: string, tab?: string, url?: string, success = true): void {
    if (this.entries.length >= JOURNAL_CAPACITY) {
      this.entries.shift();
    }
    this.entries.push({ seq: this.nextSeq++, ts: Date.now(), action, tab, url, success });
    this.save();
  }

  getRecent(limit = 50): JournalEntry[] {
    return this.entries.slice(-limit);
  }

  private filename(): string {
    return `journal-${safeId(this.agentId)}.json`;
  }

  private load(): void {
    const data = this.store.read<JournalFile>(this.filename());
    if (data) {
      this.entries = data.entries ?? [];
      this.nextSeq = data.nextSeq ?? this.entries.length + 1;
    }
  }

  private save(): void {
    this.store.write<JournalFile>(this.filename(), {
      entries: this.entries,
      nextSeq: this.nextSeq,
    });
  }
}

export class JournalManager {
  private journals = new Map<string, AgentJournal>();

  constructor(private readonly store: StateStore) {}

  record(agentId: string, action: string, tab?: string, url?: string, success = true): void {
    this.getOrCreate(agentId).push(action, tab, url, success);
  }

  getRecent(agentId: string, limit = 50): JournalEntry[] {
    return this.getOrCreate(agentId).getRecent(limit);
  }

  private getOrCreate(agentId: string): AgentJournal {
    let j = this.journals.get(agentId);
    if (!j) {
      j = new AgentJournal(agentId, this.store);
      this.journals.set(agentId, j);
    }
    return j;
  }
}
