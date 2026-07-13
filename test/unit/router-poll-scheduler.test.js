// Unit tests for src/router-poll-scheduler.js (P2-30 PR 2).
// All timers are injected (schedulePoll/cancelPoll) so the schedule is
// driven manually — no real waiting, no flakiness (P2-32 pattern).
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRouterPollScheduler } = require('../../src/router-poll-scheduler');

// Manual timer: collects scheduled tasks; tests fire them explicitly.
function makeManualTimer() {
  const tasks = [];
  return {
    tasks,
    schedulePoll(fn, delay) {
      const task = { fn, delay, canceled: false, fired: false };
      tasks.push(task);
      return task;
    },
    cancelPoll(task) { if (task) task.canceled = true; },
    pending() { return tasks.filter(t => !t.canceled && !t.fired); },
    fire(task) { task.fired = true; task.fn(); },
    async fireAllPending() {
      for (const t of this.pending()) this.fire(t);
      await settle();
    },
  };
}

// Let queued microtasks (slot acquisition, cycle promises) run.
function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

function entryOf(id, kind = 'cisco') {
  return { id, kind, adapter: {} };
}

// A runCycle whose promises the test resolves by hand.
function makeDeferredCycle() {
  const calls = [];
  let concurrent = 0;
  let highWater = 0;
  const runCycle = entry => new Promise((resolve, reject) => {
    concurrent++;
    highWater = Math.max(highWater, concurrent);
    calls.push({
      id: entry.id,
      resolve: v => { concurrent--; resolve(v); },
      reject:  e => { concurrent--; reject(e); },
    });
  });
  return { runCycle, calls, getHighWater: () => highWater };
}

describe('router-poll-scheduler: staggered start', () => {
  it('spreads initial polls by start order', () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async () => {},
      pollIntervalMs: 60_000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    sched.start(entryOf('cisco-22222222'));
    sched.start(entryOf('yamaha1', 'yamaha'));
    const delays = timer.pending().map(t => t.delay);
    assert.deepEqual(delays, [0, 6_000, 12_000]); // interval/10 step
  });

  it('start returns false for an already-scheduled id', () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async () => {},
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    assert.equal(sched.start(entryOf('cisco-11111111')), true);
    assert.equal(sched.start(entryOf('cisco-11111111')), false);
  });
});

describe('router-poll-scheduler: cycle execution', () => {
  it('runs the cycle and reschedules at the poll interval on success', async () => {
    const timer = makeManualTimer();
    const ran = [];
    const sched = createRouterPollScheduler({
      runCycle: async e => { ran.push(e.id); },
      pollIntervalMs: 60_000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    await timer.fireAllPending();

    assert.deepEqual(ran, ['cisco-11111111']);
    // one pending task: the next poll at the normal interval
    // (the cycle-timeout task was cancelled on completion)
    const next = timer.pending();
    assert.equal(next.length, 1);
    assert.equal(next[0].delay, 60_000);
  });

  it('cancels the cycle-timeout timer once the cycle settles', async () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async () => {},
      cycleTimeoutMs: 120_000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    await timer.fireAllPending();
    const timeoutTasks = timer.tasks.filter(t => t.delay === 120_000);
    assert.equal(timeoutTasks.length, 1);
    assert.ok(timeoutTasks[0].canceled, 'timeout timer must be cancelled after completion');
  });
});

describe('router-poll-scheduler: concurrency cap', () => {
  it('never runs more cycles than maxConcurrent', async () => {
    const timer = makeManualTimer();
    const cycle = makeDeferredCycle();
    const sched = createRouterPollScheduler({
      runCycle: cycle.runCycle,
      maxConcurrent: 2,
      staggerStepMs: 1000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    for (let i = 1; i <= 4; i++) sched.start(entryOf(`cisco-0000000${i}`));
    await timer.fireAllPending();

    assert.equal(cycle.calls.length, 2, 'only maxConcurrent cycles may start');
    cycle.calls[0].resolve();
    await settle();
    assert.equal(cycle.calls.length, 3, 'a freed slot admits the next waiter');
    cycle.calls[1].resolve();
    cycle.calls[2].resolve();
    await settle();
    assert.equal(cycle.calls.length, 4);
    cycle.calls[3].resolve();
    await settle();
    assert.equal(cycle.getHighWater(), 2);
  });

  it('caps 10 routers at the default of 3 concurrent cycles', async () => {
    const timer = makeManualTimer();
    const cycle = makeDeferredCycle();
    const sched = createRouterPollScheduler({
      runCycle: cycle.runCycle,
      staggerStepMs: 1000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    for (let i = 0; i < 10; i++) sched.start(entryOf(`cisco-0000000${i}`));
    await timer.fireAllPending();

    // Drain everything, resolving as slots open
    while (cycle.calls.some(c => c.resolve)) {
      const next = cycle.calls.find(c => c.resolve);
      const r = next.resolve; next.resolve = null;
      r();
      await settle();
    }
    assert.equal(cycle.calls.length, 10, 'every router polled exactly once');
    assert.equal(cycle.getHighWater(), 3, 'default concurrency cap is 3');
  });
});

describe('router-poll-scheduler: failure isolation and backoff', () => {
  it('one router failing does not affect the others', async () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async e => {
        if (e.id === 'cisco-bad00000') throw new Error('auth failed');
      },
      pollIntervalMs: 60_000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-bad00000'));
    sched.start(entryOf('cisco-good0000'));
    await timer.fireAllPending();

    const byDelay = timer.pending().map(t => t.delay).sort((a, b) => a - b);
    // good: normal interval; bad: backoff (interval * 2^1)
    assert.deepEqual(byDelay, [60_000, 120_000]);

    const status = Object.fromEntries(sched.status().map(s => [s.id, s]));
    assert.equal(status['cisco-bad00000'].consecutiveFailures, 1);
    assert.match(status['cisco-bad00000'].lastError, /auth failed/);
    assert.equal(status['cisco-good0000'].consecutiveFailures, 0);
    assert.equal(status['cisco-good0000'].lastError, null);
  });

  it('backoff grows exponentially and is capped', async () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async () => { throw new Error('down'); },
      pollIntervalMs: 60_000,
      maxBackoffMs: 300_000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    await timer.fireAllPending();  // fail 1 → 120s
    assert.equal(timer.pending()[0].delay, 120_000);
    await timer.fireAllPending();  // fail 2 → 240s
    assert.equal(timer.pending()[0].delay, 240_000);
    await timer.fireAllPending();  // fail 3 → capped at 300s
    assert.equal(timer.pending()[0].delay, 300_000);
  });

  it('a success resets the failure count and the interval', async () => {
    const timer = makeManualTimer();
    let failOnce = true;
    const sched = createRouterPollScheduler({
      runCycle: async () => {
        if (failOnce) { failOnce = false; throw new Error('flaky'); }
      },
      pollIntervalMs: 60_000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    await timer.fireAllPending();  // failure → backoff
    assert.equal(timer.pending()[0].delay, 120_000);
    await timer.fireAllPending();  // success → normal interval
    assert.equal(timer.pending()[0].delay, 60_000);
    assert.equal(sched.status()[0].consecutiveFailures, 0);
    assert.ok(sched.status()[0].lastSuccessAt);
  });
});

describe('router-poll-scheduler: cycle timeout', () => {
  it('treats a hung cycle as a failure and notifies onTimeout', async () => {
    const timer = makeManualTimer();
    const timedOut = [];
    const sched = createRouterPollScheduler({
      runCycle: () => new Promise(() => {}),  // never settles
      pollIntervalMs: 60_000,
      cycleTimeoutMs: 120_000,
      onTimeout: e => timedOut.push(e.id),
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    await timer.fireAllPending();  // starts the cycle + schedules its timeout

    const timeoutTask = timer.pending().find(t => t.delay === 120_000);
    assert.ok(timeoutTask, 'a timeout task must be scheduled');
    timer.fire(timeoutTask);
    await settle();

    assert.deepEqual(timedOut, ['cisco-11111111']);
    const st = sched.status()[0];
    assert.equal(st.consecutiveFailures, 1);
    assert.match(st.lastError, /timeout/);
    // rescheduled with backoff despite the cycle promise never settling
    assert.equal(timer.pending()[0].delay, 120_000);
  });
});

describe('router-poll-scheduler: stop', () => {
  it('stop cancels the pending timer and removes the router', () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async () => {},
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    assert.equal(sched.isScheduled('cisco-11111111'), true);
    assert.equal(sched.stop('cisco-11111111'), true);
    assert.equal(sched.isScheduled('cisco-11111111'), false);
    assert.equal(timer.pending().length, 0, 'pending poll must be cancelled');
    assert.equal(sched.stop('cisco-11111111'), false);
  });

  it('stopAll stops every router', () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async () => {},
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    sched.start(entryOf('yamaha1', 'yamaha'));
    sched.stopAll();
    assert.equal(sched.status().length, 0);
    assert.equal(timer.pending().length, 0);
  });

  it('a stopped router does not run even if its cycle was queued for a slot', async () => {
    const timer = makeManualTimer();
    const cycle = makeDeferredCycle();
    const sched = createRouterPollScheduler({
      runCycle: cycle.runCycle,
      maxConcurrent: 1,
      staggerStepMs: 1000,
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
    });
    sched.start(entryOf('cisco-11111111'));
    sched.start(entryOf('cisco-22222222'));
    await timer.fireAllPending();
    assert.equal(cycle.calls.length, 1);       // second waits for the slot

    sched.stop('cisco-22222222');              // stop while queued
    cycle.calls[0].resolve();
    await settle();
    assert.equal(cycle.calls.length, 1, 'stopped router must not start its cycle');
  });
});

describe('router-poll-scheduler: status', () => {
  it('exposes id, kind, and scheduling fields', () => {
    const timer = makeManualTimer();
    const sched = createRouterPollScheduler({
      runCycle: async () => {},
      schedulePoll: timer.schedulePoll,
      cancelPoll: timer.cancelPoll,
      now: () => 1_000_000,
    });
    sched.start(entryOf('cisco-11111111'));
    const [st] = sched.status();
    assert.equal(st.id, 'cisco-11111111');
    assert.equal(st.kind, 'cisco');
    assert.equal(st.running, false);
    assert.equal(st.consecutiveFailures, 0);
    assert.equal(st.lastSuccessAt, null);
    assert.equal(st.lastError, null);
    assert.equal(st.nextRunAt, 1_000_000); // first stagger offset is 0
  });
});
