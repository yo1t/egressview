'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeProfiler } = require('../../src/runtime-profiler');

function createHarness() {
  let currentTime = 0;
  let totalCpu = { user: 0, system: 0 };
  let intervalCallback = null;
  const logs = [];
  const histogram = {
    max: 8_000_000,
    enable: () => {},
    disable: () => {},
    reset: () => {},
    percentile: () => 4_000_000,
  };
  const profiler = createRuntimeProfiler({
    now: () => currentTime,
    cpuUsage: previous => previous
      ? { user: totalCpu.user - previous.user, system: totalCpu.system - previous.system }
      : { ...totalCpu },
    memoryUsage: () => ({ rss: 128 * 1024 * 1024, heapUsed: 32 * 1024 * 1024 }),
    createHistogram: () => histogram,
    scheduleInterval: callback => {
      intervalCallback = callback;
      return { unref: () => {} };
    },
    clearScheduledInterval: () => {},
  });
  profiler.start({ logger: { info: (...args) => logs.push(args) } });
  return {
    profiler,
    logs,
    advance: ({ wallMs, userUs = 0, systemUs = 0 }) => {
      currentTime += wallMs;
      totalCpu.user += userUs;
      totalCpu.system += systemUs;
    },
    emit: () => intervalCallback(),
  };
}

describe('runtime profiler', () => {
  it('reports process CPU, event-loop delay, memory, and gauges', () => {
    const harness = createHarness();
    harness.profiler.setGauge('enrichment.staleQueued', 123);
    harness.advance({ wallMs: 1000, userUs: 200_000, systemUs: 50_000 });

    const snapshot = harness.emit();

    assert.equal(snapshot.cpuPct, 25);
    assert.equal(snapshot.eventLoopP95Ms, 4);
    assert.equal(snapshot.eventLoopMaxMs, 8);
    assert.equal(snapshot.rssMb, 128);
    assert.equal(snapshot.heapUsedMb, 32);
    assert.equal(snapshot.gauges['enrichment.staleQueued'], 123);
    assert.equal(harness.logs[0][0], '[runtime-profile]');
  });

  it('separates synchronous CPU timing from asynchronous wall timing', async () => {
    const harness = createHarness();

    const value = harness.profiler.measureSync('history.snapshot', () => {
      harness.advance({ wallMs: 20, userUs: 12_000, systemUs: 3_000 });
      return 42;
    });
    await harness.profiler.measureAsync('poll.yamaha.total', async () => {
      harness.advance({ wallMs: 80, userUs: 5_000 });
    });
    harness.advance({ wallMs: 900, userUs: 80_000 });

    const snapshot = harness.profiler.emit();

    assert.equal(value, 42);
    assert.deepEqual(snapshot.operations['history.snapshot'], {
      calls: 1, wallMs: 20, maxWallMs: 20, cpuMs: 15,
    });
    assert.deepEqual(snapshot.operations['poll.yamaha.total'], {
      calls: 1, wallMs: 80, maxWallMs: 80,
    });
  });

  it('can be disabled without scheduling or measuring', () => {
    let scheduled = false;
    const profiler = createRuntimeProfiler({
      scheduleInterval: () => { scheduled = true; },
    });
    profiler.start({ enabled: false });

    assert.equal(profiler.measureSync('unused', () => 'ok'), 'ok');
    assert.equal(profiler.isEnabled(), false);
    assert.equal(scheduled, false);
  });
});
