/**
 * CommandScheduler unit tests — admission control, no Chrome needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CommandScheduler } from "../command-scheduler.js";

/** Drain the microtask + immediate queues so pending acquire() promises settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("CommandScheduler", () => {
  it("admits immediately when under capacity and tracks in-flight", async () => {
    const s = new CommandScheduler({ globalLimit: 12, perSessionLimit: 4 });
    const release = await s.acquire("a");
    assert.equal(s.stats().globalInFlight, 1);
    assert.deepEqual(s.stats().inFlightBySession, { a: 1 });

    release();
    assert.equal(s.stats().globalInFlight, 0);
    assert.deepEqual(s.stats().inFlightBySession, {});
  });

  it("enforces the global concurrency limit", async () => {
    // Distinct sessions so the per-session cap never binds.
    const s = new CommandScheduler({ globalLimit: 2, perSessionLimit: 10 });
    const r1 = await s.acquire("a");
    const r2 = await s.acquire("b");
    assert.equal(s.stats().globalInFlight, 2);

    let admitted3 = false;
    const p3 = s.acquire("c").then((r) => {
      admitted3 = true;
      return r;
    });
    await flush();
    assert.equal(admitted3, false, "third must queue while global is full");
    assert.equal(s.stats().queueDepth, 1);

    r1();
    await flush();
    assert.equal(admitted3, true, "releasing a slot admits the queued waiter");
    assert.equal(s.stats().globalInFlight, 2);

    (await p3)();
    r2();
    assert.equal(s.stats().globalInFlight, 0);
  });

  it("enforces the per-session concurrency limit", async () => {
    const s = new CommandScheduler({ globalLimit: 10, perSessionLimit: 2 });
    const r1 = await s.acquire("a");
    await s.acquire("a");

    let admitted3 = false;
    s.acquire("a").then(() => {
      admitted3 = true;
    });
    await flush();
    assert.equal(admitted3, false, "session at its cap must queue even with global room");
    assert.equal(s.stats().globalInFlight, 2);

    r1();
    await flush();
    assert.equal(admitted3, true, "releasing one of the session's slots admits the next");
  });

  it("serves a quiet session ahead of a noisy session's backlog (fairness)", async () => {
    const s = new CommandScheduler({ globalLimit: 2, perSessionLimit: 2 });
    // A floods first: fills both global slots and queues two more.
    const ra1 = await s.acquire("a");
    await s.acquire("a");
    const order: string[] = [];
    s.acquire("a").then(() => order.push("a3"));
    s.acquire("a").then(() => order.push("a4"));
    // B arrives AFTER A's backlog is already queued.
    s.acquire("b").then(() => order.push("b1"));
    await flush();
    assert.deepEqual(order, [], "nothing admitted while global is full");

    // Free one slot: B (0 in flight) must win over A (1 in flight) despite FIFO.
    ra1();
    await flush();
    assert.deepEqual(order, ["b1"], "quiet session B is admitted before A's backlog");
  });

  it("breaks ties by FIFO arrival order", async () => {
    const s = new CommandScheduler({ globalLimit: 1, perSessionLimit: 5 });
    const r1 = await s.acquire("a"); // holds the only slot
    const order: string[] = [];
    // Two waiters from DIFFERENT sessions, both with 0 in flight → tie → FIFO.
    s.acquire("b").then(() => order.push("b"));
    s.acquire("c").then(() => order.push("c"));

    r1();
    await flush();
    // Only one slot, so only the first (FIFO) tie-winner is admitted.
    assert.deepEqual(order, ["b"]);
  });

  it("ignores a double release", async () => {
    const s = new CommandScheduler({ globalLimit: 2, perSessionLimit: 2 });
    const release = await s.acquire("a");
    release();
    release(); // no-op; must not drive counters negative
    assert.equal(s.stats().globalInFlight, 0);
    assert.deepEqual(s.stats().inFlightBySession, {});
  });
});
