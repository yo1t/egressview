// Generic multi-router poll scheduler (P2-30 PR 2).
//
// Runs one injected poll cycle per router on a fixed interval with:
//  - staggered start times so routers don't all poll at once
//  - a concurrency cap (default 3 cycles in flight)
//  - per-router timeout, exponential backoff, and failure isolation:
//    one router failing or hanging never stops the others
//
// The engine knows nothing about SSH, history, or WebSockets — the caller
// injects `runCycle(entry)`. Timers are injectable (schedulePoll/cancelPoll)
// so tests drive the schedule deterministically (same pattern as P2-32).
'use strict';

const logger = require('./logger');
const runtimeProfiler = require('./runtime-profiler');

const DEFAULT_MAX_CONCURRENT  = 3;
const DEFAULT_CYCLE_TIMEOUT   = 120_000;
const DEFAULT_MAX_BACKOFF     = 10 * 60_000;

/**
 * @param {{
   *   runCycle: (entry: { id: string, adapter: object }, options: { signal: AbortSignal }) => Promise<void>,
 *   pollIntervalMs?: number,
 *   maxConcurrent?: number,
 *   cycleTimeoutMs?: number,
 *   maxBackoffMs?: number,
 *   staggerStepMs?: number,
 *   onTimeout?: (entry) => void,
 *   schedulePoll?: (cb: () => void, ms: number) => unknown,
 *   cancelPoll?: (handle: unknown) => void,
 *   now?: () => number,
 * }} opts
 */
function createRouterPollScheduler({
  runCycle,
  pollIntervalMs = 60_000,
  maxConcurrent  = DEFAULT_MAX_CONCURRENT,
  cycleTimeoutMs = DEFAULT_CYCLE_TIMEOUT,
  maxBackoffMs   = DEFAULT_MAX_BACKOFF,
  staggerStepMs,
  onTimeout      = () => {},
  schedulePoll   = setTimeout,
  cancelPoll     = clearTimeout,
  now            = Date.now,
} = {}) {
  if (typeof runCycle !== 'function') throw new TypeError('runCycle is required');

  // Spread initial polls across the interval. Sized for the 10-router design
  // cap: with the 60s default interval, starts land 6s apart.
  const stepMs = staggerStepMs ?? Math.max(1000, Math.floor(pollIntervalMs / 10));

  const states = new Map(); // id → state
  let startedCount = 0;     // total starts ever, drives the stagger offset

  // ── Concurrency semaphore ───────────────────────────────────────────────────
  let runningCount = 0;
  const waitQueue = [];

  function acquireSlot() {
    if (runningCount < maxConcurrent) {
      runningCount++;
      return Promise.resolve();
    }
    return new Promise(res => waitQueue.push(res));
  }
  function releaseSlot() {
    const next = waitQueue.shift();
    if (next) next();           // hand the slot straight to the next waiter
    else runningCount--;
  }

  // ── Per-router lifecycle ────────────────────────────────────────────────────

  function scheduleNext(st, delayMs) {
    st.nextRunAt = now() + delayMs;
    st.timer = schedulePoll(() => { st.timer = null; runOnce(st); }, delayMs);
  }

  function backoffDelay(failures) {
    return Math.min(pollIntervalMs * 2 ** failures, maxBackoffMs);
  }

  function withTimeout(promise, ms, st, controller) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = schedulePoll(() => {
        if (done) return;
        done = true;
        st.timedOut = true;
        const error = new Error(`poll cycle timeout after ${ms}ms`);
        controller.abort(error);
        reject(error);
      }, ms);
      promise.then(
        v => { if (!done) { done = true; cancelPoll(timer); resolve(v); } },
        e => { if (!done) { done = true; cancelPoll(timer); reject(e); } },
      );
    });
  }

  async function runOnce(st) {
    if (st.stopped || st.running) return;
    st.running = true;
    await acquireSlot();
    if (st.stopped) { st.running = false; releaseSlot(); return; }

    st.timedOut = false;
    let failed = false;
    const controller = new AbortController();
    st.controller = controller;
    const cyclePromise = Promise.resolve().then(() =>
      runtimeProfiler.measureAsync(`router.${st.entry.kind}.poll.total`, () =>
        runCycle(st.entry, { signal: controller.signal })));
    try {
      await withTimeout(cyclePromise, cycleTimeoutMs, st, controller);
      st.consecutiveFailures = 0;
      st.lastSuccessAt = now();
      st.lastError = null;
    } catch (e) {
      failed = true;
      st.consecutiveFailures++;
      st.lastError = String(e?.message || e);
      logger.error(`[poll:${st.entry.id}] cycle failed (${st.consecutiveFailures} in a row): ${st.lastError}`);
      if (st.timedOut) {
        try { onTimeout(st.entry); } catch {}
        // Reconnect/abort should settle the adapter operation promptly. Keep
        // the slot until it really settles so timed-out work cannot overlap a
        // later cycle or escape the global concurrency cap.
        await cyclePromise.catch(() => {});
      }
    } finally {
      st.controller = null;
      releaseSlot();
      st.running = false;
      if (!st.stopped) {
        scheduleNext(st, failed ? backoffDelay(st.consecutiveFailures) : pollIntervalMs);
      }
    }
  }

  return {
    /**
     * Begin polling a router. The first run is staggered by start order.
     * @param {{ id: string, adapter: object }} entry  a registry entry
     * @returns {boolean} false when the id is already scheduled
     */
    start(entry) {
      if (!entry || !entry.id) throw new TypeError('entry with id is required');
      if (states.has(entry.id)) return false;
      const st = {
        entry,
        stopped: false,
        running: false,
        timedOut: false,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastError: null,
        nextRunAt: null,
        timer: null,
        controller: null,
      };
      states.set(entry.id, st);
      scheduleNext(st, (startedCount++ * stepMs) % pollIntervalMs);
      return true;
    },

    /** Stop polling a router (pending timer cancelled, in-flight cycle finishes). */
    stop(id) {
      const st = states.get(id);
      if (!st) return false;
      st.stopped = true;
      st.controller?.abort(new Error('poll cycle stopped'));
      if (st.timer) { cancelPoll(st.timer); st.timer = null; }
      states.delete(id);
      return true;
    },

    stopAll() {
      for (const id of [...states.keys()]) this.stop(id);
    },

    isScheduled(id) { return states.has(id); },

    /** Snapshot for status displays and diagnostics. */
    status() {
      return [...states.values()].map(st => ({
        id: st.entry.id,
        kind: st.entry.kind,
        running: st.running,
        consecutiveFailures: st.consecutiveFailures,
        lastSuccessAt: st.lastSuccessAt,
        lastError: st.lastError,
        nextRunAt: st.nextRunAt,
      }));
    },

    _runningCount: () => runningCount,
  };
}

module.exports = {
  createRouterPollScheduler,
  DEFAULT_MAX_CONCURRENT,
};
