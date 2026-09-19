'use strict';

const { monitorEventLoopDelay, performance, PerformanceObserver } = require('node:perf_hooks');

const DEFAULT_INTERVAL_MS = 60_000;
const NS_PER_MS = 1e6;

// The window summary can say the loop stopped for two seconds; it cannot say
// when, or what was running. Chasing a stall with it means guessing, and a
// whole afternoon of guessing on one Hub produced three wrong answers before
// the profiler was extended instead. This watchdog answers the two questions
// the summary cannot.
const DEFAULT_WATCHDOG_INTERVAL_MS = 100;
const DEFAULT_STALL_THRESHOLD_MS = 500;
// Only operations worth naming go in the ring: a poll records hundreds of
// sub-millisecond ones, and none of them stopped anything.
const RECENT_OPERATION_MIN_MS = 5;
const RECENT_OPERATION_LIMIT = 200;
// Node emits a scavenge every few milliseconds, and 200 of them at 0.02 ms each
// would push the one collection that mattered out of the ring before anything
// read it. Only pauses long enough to be part of a stall are worth keeping.
const GC_PAUSE_MIN_MS = 1;

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function createRuntimeProfiler(deps = {}) {
  const now = deps.now || (() => performance.now());
  const cpuUsage = deps.cpuUsage || process.cpuUsage.bind(process);
  const memoryUsage = deps.memoryUsage || process.memoryUsage.bind(process);
  const createHistogram = deps.createHistogram || (() => monitorEventLoopDelay({ resolution: 20 }));
  const scheduleInterval = deps.scheduleInterval || setInterval;
  const clearScheduledInterval = deps.clearScheduledInterval || clearInterval;

  let logger = console;
  let enabled = false;
  let histogram = null;
  let timer = null;
  let windowStartedAt = 0;
  let windowCpuStart = null;
  let operations = new Map();
  const gauges = new Map();
  // Completed operations worth attributing a stall to, newest last.
  let recentOperations = [];
  // Operations that have started and not returned. The ring below only learns
  // about an operation when it finishes, so without this a long one that was
  // still running when the watchdog fired -- a router poll, say -- could never
  // appear in a stall report. That blind spot made four minutes of production
  // reports come back empty on a Hub where the poll was the obvious suspect.
  const inFlight = new Map();
  let inFlightSeq = 0;
  let gcPauses = [];
  let gcObserver = null;
  let watchdogTimer = null;
  let watchdogExpectedAt = 0;
  let watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS;
  let stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS;
  let stallCount = 0;

  function remember(list, entry, limit) {
    list.push(entry);
    if (list.length > limit) list.splice(0, list.length - limit);
  }

  function noteOperation(name, startedAt, endedAt) {
    if (endedAt - startedAt < RECENT_OPERATION_MIN_MS) return;
    remember(recentOperations, { name, startedAt, endedAt }, RECENT_OPERATION_LIMIT);
  }

  /**
   * What overlapped the gap the loop spent not running.
   *
   * A blocking call cannot be caught in the act -- the watchdog is exactly what
   * it was blocking -- so the question is which operations were in flight
   * across that span. An empty answer is a finding in itself: whatever stopped
   * the loop is not instrumented.
   */
  function whatOverlapped(gapStart, gapEnd) {
    const finished = recentOperations
      .filter(entry => entry.endedAt > gapStart && entry.startedAt < gapEnd)
      .map(entry => ({
        name: entry.name,
        ms: round(entry.endedAt - entry.startedAt),
        coversMs: round(Math.min(entry.endedAt, gapEnd) - Math.max(entry.startedAt, gapStart)),
      }));
    const running = [...inFlight.values()]
      .filter(entry => entry.startedAt < gapEnd)
      .map(entry => ({
        name: entry.name,
        ms: round(gapEnd - entry.startedAt),
        coversMs: round(gapEnd - Math.max(entry.startedAt, gapStart)),
        stillRunning: true,
      }));
    return [...finished, ...running]
      .sort((a, b) => b.coversMs - a.coversMs)
      .slice(0, 5);
  }

  function gcInWindow(gapStart, gapEnd) {
    const inside = gcPauses.filter(pause => pause.endedAt > gapStart && pause.startedAt < gapEnd);
    return {
      count: inside.length,
      totalMs: round(inside.reduce((total, pause) => total + (pause.endedAt - pause.startedAt), 0)),
      maxMs: round(inside.reduce((max, pause) => Math.max(max, pause.endedAt - pause.startedAt), 0)),
    };
  }

  function watchdogTick() {
    const firedAt = now();
    const lateBy = firedAt - watchdogExpectedAt;
    watchdogExpectedAt = firedAt + watchdogIntervalMs;
    if (lateBy < stallThresholdMs) return;
    stallCount += 1;
    // The loop was unavailable from roughly one interval before it should have
    // fired until now.
    const gapStart = firedAt - lateBy - watchdogIntervalMs;
    // A diagnostic must never be the thing that breaks the server, so it does
    // not assume the logger has every level.
    const warn = typeof logger.warn === 'function' ? logger.warn : logger.info;
    warn.call(logger, '[runtime-stall]', {
      atMs: round(lateBy),
      at: new Date().toISOString(),
      gc: gcInWindow(gapStart, firedAt),
      overlapping: whatOverlapped(gapStart, firedAt),
      rssMb: round(memoryUsage().rss / 1024 / 1024),
    });
  }

  function record(name, wallMs, cpuMs = null) {
    if (!enabled) return;
    const current = operations.get(name) || { calls: 0, wallMs: 0, cpuMs: 0, maxWallMs: 0, hasCpu: false };
    current.calls += 1;
    current.wallMs += wallMs;
    current.maxWallMs = Math.max(current.maxWallMs, wallMs);
    if (cpuMs != null) {
      current.cpuMs += cpuMs;
      current.hasCpu = true;
    }
    operations.set(name, current);
  }

  function measureSync(name, fn) {
    if (!enabled) return fn();
    const startedAt = now();
    const cpuStart = cpuUsage();
    const token = ++inFlightSeq;
    inFlight.set(token, { name, startedAt });
    try {
      return fn();
    } finally {
      inFlight.delete(token);
      const cpu = cpuUsage(cpuStart);
      const endedAt = now();
      record(name, endedAt - startedAt, (cpu.user + cpu.system) / 1000);
      noteOperation(name, startedAt, endedAt);
    }
  }

  async function measureAsync(name, fn) {
    if (!enabled) return fn();
    const startedAt = now();
    const token = ++inFlightSeq;
    inFlight.set(token, { name, startedAt });
    try {
      return await fn();
    } finally {
      inFlight.delete(token);
      const endedAt = now();
      record(name, endedAt - startedAt);
      noteOperation(name, startedAt, endedAt);
    }
  }

  function recordWall(name, wallMs) {
    record(name, wallMs);
  }

  function setGauge(name, value) {
    if (!Number.isFinite(value)) return;
    gauges.set(name, value);
  }

  function operationSummary() {
    const result = {};
    for (const [name, value] of [...operations].sort(([a], [b]) => a.localeCompare(b))) {
      result[name] = {
        calls: value.calls,
        wallMs: round(value.wallMs),
        maxWallMs: round(value.maxWallMs),
      };
      if (value.hasCpu) result[name].cpuMs = round(value.cpuMs);
    }
    return result;
  }

  function emit() {
    if (!enabled) return null;
    const endedAt = now();
    const windowMs = Math.max(1, endedAt - windowStartedAt);
    const cpu = cpuUsage(windowCpuStart);
    const memory = memoryUsage();
    const snapshot = {
      windowMs: round(windowMs),
      cpuPct: round(((cpu.user + cpu.system) / 1000) / windowMs * 100),
      eventLoopP95Ms: round(histogram.percentile(95) / NS_PER_MS, 2),
      eventLoopMaxMs: round(histogram.max / NS_PER_MS, 2),
      rssMb: round(memory.rss / 1024 / 1024),
      heapUsedMb: round(memory.heapUsed / 1024 / 1024),
      gauges: Object.fromEntries([...gauges].sort(([a], [b]) => a.localeCompare(b))),
      stalls: stallCount,
      operations: operationSummary(),
    };
    logger.info('[runtime-profile]', snapshot);
    operations = new Map();
    stallCount = 0;
    // Kept across windows on purpose: a stall detected just after a boundary
    // has to be explained by what ran just before it.
    gcPauses = gcPauses.slice(-RECENT_OPERATION_LIMIT);
    histogram.reset();
    windowStartedAt = endedAt;
    windowCpuStart = cpuUsage();
    return snapshot;
  }

  function start(options = {}) {
    if (timer || enabled) return;
    enabled = options.enabled ?? process.env.EGRESSVIEW_RUNTIME_PROFILE !== 'false';
    if (!enabled) return;
    logger = options.logger || console;
    histogram = createHistogram();
    histogram.enable();
    windowStartedAt = now();
    windowCpuStart = cpuUsage();
    const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    timer = scheduleInterval(emit, intervalMs);
    timer?.unref?.();

    watchdogIntervalMs = options.watchdogIntervalMs || DEFAULT_WATCHDOG_INTERVAL_MS;
    stallThresholdMs = options.stallThresholdMs || DEFAULT_STALL_THRESHOLD_MS;
    stallCount = 0;
    recentOperations = [];
    gcPauses = [];
    // Rules garbage collection in or out without another deploy. A major
    // collection is one of the few things that can stop the loop for seconds
    // while using almost no CPU of its own in the profile.
    if (options.observeGc !== false && typeof PerformanceObserver === 'function') {
      try {
        gcObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.duration < GC_PAUSE_MIN_MS) continue;
            remember(gcPauses,
              { startedAt: entry.startTime, endedAt: entry.startTime + entry.duration },
              RECENT_OPERATION_LIMIT);
          }
        });
        gcObserver.observe({ entryTypes: ['gc'] });
      } catch { gcObserver = null; }
    }
    watchdogExpectedAt = now() + watchdogIntervalMs;
    watchdogTimer = scheduleInterval(watchdogTick, watchdogIntervalMs);
    watchdogTimer?.unref?.();
  }

  function stop() {
    if (timer) clearScheduledInterval(timer);
    timer = null;
    if (watchdogTimer) clearScheduledInterval(watchdogTimer);
    watchdogTimer = null;
    try { gcObserver?.disconnect(); } catch { /* already gone */ }
    gcObserver = null;
    recentOperations = [];
    gcPauses = [];
    inFlight.clear();
    stallCount = 0;
    histogram?.disable?.();
    histogram = null;
    enabled = false;
    operations = new Map();
    gauges.clear();
  }

  function isEnabled() {
    return enabled;
  }

  return {
    start, stop, emit, isEnabled, measureSync, measureAsync, recordWall, setGauge,
    _watchdogTick: watchdogTick, _noteOperation: noteOperation,
  };
}

const profiler = createRuntimeProfiler();

module.exports = {
  ...profiler,
  createRuntimeProfiler,
};
