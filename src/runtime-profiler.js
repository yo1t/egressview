'use strict';

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const DEFAULT_INTERVAL_MS = 60_000;
const NS_PER_MS = 1e6;

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
    try {
      return fn();
    } finally {
      const cpu = cpuUsage(cpuStart);
      record(name, now() - startedAt, (cpu.user + cpu.system) / 1000);
    }
  }

  async function measureAsync(name, fn) {
    if (!enabled) return fn();
    const startedAt = now();
    try {
      return await fn();
    } finally {
      record(name, now() - startedAt);
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
      operations: operationSummary(),
    };
    logger.info('[runtime-profile]', snapshot);
    operations = new Map();
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
  }

  function stop() {
    if (timer) clearScheduledInterval(timer);
    timer = null;
    histogram?.disable?.();
    histogram = null;
    enabled = false;
    operations = new Map();
    gauges.clear();
  }

  function isEnabled() {
    return enabled;
  }

  return { start, stop, emit, isEnabled, measureSync, measureAsync, recordWall, setGauge };
}

const profiler = createRuntimeProfiler();

module.exports = {
  ...profiler,
  createRuntimeProfiler,
};
