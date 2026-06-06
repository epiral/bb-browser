/**
 * CommandScheduler — fair admission control for commands dispatched against the
 * single shared CDP connection.
 *
 * Without it, every incoming /command runs dispatchRequest immediately and
 * concurrently, so N agents interleave at every await boundary and one agent
 * firing a burst can starve the others. The scheduler bounds concurrency two
 * ways and serves waiters fairly:
 *
 *   - globalLimit      — max commands in flight across all sessions
 *   - perSessionLimit  — max commands in flight for any single session
 *
 * Fairness comes from least-loaded-first admission: when a slot frees, the
 * next waiter chosen is the one whose session currently has the FEWEST commands
 * in flight (ties broken by FIFO arrival). A bursty session that already holds
 * its share of slots is therefore passed over for a session with none in
 * flight — so a command from a quiet agent is not stuck behind a noisy agent's
 * backlog.
 *
 * Orthogonal to tab leases: a slot is held only while dispatchRequest runs, and
 * a lease conflict fails immediately (never blocks), so a slot holder can never
 * deadlock waiting on another session's lease.
 */

interface Waiter {
  sessionId: string;
  admit: () => void;
}

export interface SchedulerOptions {
  globalLimit: number;
  perSessionLimit: number;
}

export interface SchedulerStats {
  globalInFlight: number;
  queueDepth: number;
  inFlightBySession: Record<string, number>;
}

export class CommandScheduler {
  private readonly globalLimit: number;
  private readonly perSessionLimit: number;
  private globalInFlight = 0;
  private readonly inFlightBySession = new Map<string, number>();
  private readonly waiters: Waiter[] = [];

  constructor(opts: SchedulerOptions) {
    this.globalLimit = Math.max(1, Math.floor(opts.globalLimit));
    this.perSessionLimit = Math.max(1, Math.floor(opts.perSessionLimit));
  }

  /**
   * Acquire an execution slot for `sessionId`. Resolves immediately if there is
   * capacity, otherwise once this caller is admitted. The returned release
   * function MUST be called exactly once when the command finishes (extra calls
   * are ignored).
   */
  acquire(sessionId: string): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const admit = () => {
        this.take(sessionId);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release(sessionId);
        });
      };
      if (this.canAdmit(sessionId)) {
        admit();
      } else {
        this.waiters.push({ sessionId, admit });
      }
    });
  }

  stats(): SchedulerStats {
    return {
      globalInFlight: this.globalInFlight,
      queueDepth: this.waiters.length,
      inFlightBySession: Object.fromEntries(this.inFlightBySession),
    };
  }

  private canAdmit(sessionId: string): boolean {
    return (
      this.globalInFlight < this.globalLimit &&
      (this.inFlightBySession.get(sessionId) ?? 0) < this.perSessionLimit
    );
  }

  private take(sessionId: string): void {
    this.globalInFlight += 1;
    this.inFlightBySession.set(sessionId, (this.inFlightBySession.get(sessionId) ?? 0) + 1);
  }

  private release(sessionId: string): void {
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    const next = (this.inFlightBySession.get(sessionId) ?? 1) - 1;
    if (next <= 0) this.inFlightBySession.delete(sessionId);
    else this.inFlightBySession.set(sessionId, next);
    this.pump();
  }

  /**
   * Admit waiters while global capacity remains, picking each via
   * {@link pickNextWaiter} (least-loaded session first).
   */
  private pump(): void {
    while (this.globalInFlight < this.globalLimit) {
      const idx = this.pickNextWaiter();
      if (idx === -1) break;
      const [waiter] = this.waiters.splice(idx, 1);
      waiter.admit();
    }
  }

  /**
   * Index of the next waiter to admit: among waiters whose session is under the
   * per-session cap, the one whose session has the fewest commands in flight
   * (least-loaded-first → fairness), tie-broken by FIFO arrival order. Returns
   * -1 when no waiter can be admitted right now.
   */
  private pickNextWaiter(): number {
    let best = -1;
    let bestInFlight = Infinity;
    for (let i = 0; i < this.waiters.length; i++) {
      const inFlight = this.inFlightBySession.get(this.waiters[i].sessionId) ?? 0;
      if (inFlight >= this.perSessionLimit) continue;
      // Strict `<` keeps the earliest (FIFO) waiter on ties.
      if (inFlight < bestInFlight) {
        best = i;
        bestInFlight = inFlight;
      }
    }
    return best;
  }
}
