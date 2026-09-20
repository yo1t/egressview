'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeProfiler } = require('../../src/runtime-profiler');

function createHarness() {
  let currentTime = 0;
  let totalCpu = { user: 0, system: 0 };
  const intervalCallbacks = [];
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
      intervalCallbacks.push(callback);
      return { unref: () => {} };
    },
    clearScheduledInterval: () => {},
  });
  profiler.start({
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    observeGc: false,
  });
  return {
    profiler,
    logs,
    advance: ({ wallMs, userUs = 0, systemUs = 0 }) => {
      currentTime += wallMs;
      totalCpu.user += userUs;
      totalCpu.system += systemUs;
    },
    // start() schedules the window summary first and the stall watchdog second.
    emit: () => intervalCallbacks[0](),
    watchdogTick: () => intervalCallbacks[1](),
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

// ─── P3-139: stall watchdog ───────────────────────────────────────────────────
//
// The window summary can say the loop stopped for two seconds; it cannot say
// when, or what was running. These pin the two things it adds.

describe('停止の見張り', () => {
  function stallLogs(logs) {
    return logs.filter(([tag]) => tag === '[runtime-stall]').map(([, body]) => body);
  }

  it('時間どおりに動いている間は何も言わない', () => {
    const h = createHarness();
    h.advance({ wallMs: 100 });
    h.watchdogTick();
    h.advance({ wallMs: 100 });
    h.watchdogTick();
    assert.deepEqual(stallLogs(h.logs), [], '正常時に警告を出している');
  });

  it('閾値を超えて遅れたときだけ報告する', () => {
    const h = createHarness();
    h.advance({ wallMs: 400 });   // 100ms のはずが 400ms
    h.watchdogTick();
    assert.deepEqual(stallLogs(h.logs), [], '閾値未満は報告しない');

    h.advance({ wallMs: 2000 });
    h.watchdogTick();
    const stalls = stallLogs(h.logs);
    assert.equal(stalls.length, 1);
    assert.ok(stalls[0].atMs >= 1900, `遅れの大きさが出ていない: ${stalls[0].atMs}`);
  });

  it('止まっていた時間と重なっていた処理を名指しする', () => {
    const h = createHarness();
    // A long synchronous operation, then the watchdog notices it was blocked.
    h.profiler.measureSync('slow.thing', () => h.advance({ wallMs: 1800 }));
    h.advance({ wallMs: 100 });
    h.watchdogTick();

    const [stall] = stallLogs(h.logs);
    assert.ok(stall, '停止が報告されていない');
    assert.equal(stall.overlapping[0].name, 'slow.thing');
    assert.ok(stall.overlapping[0].coversMs > 1000,
      `重なりが小さすぎる: ${stall.overlapping[0].coversMs}`);
  });

  it('計測していない処理が犯人なら、重なりは空で返る', () => {
    // An empty list is the finding: whatever stopped the loop is not measured.
    const h = createHarness();
    h.advance({ wallMs: 2000 });
    h.watchdogTick();
    const [stall] = stallLogs(h.logs);
    assert.deepEqual(stall.overlapping, [], '身に覚えのない処理を挙げている');
    assert.equal(stall.gc.count, 0);
  });

  it('短い処理は覚えておかない', () => {
    // A poll records hundreds of sub-millisecond operations and none of them
    // stopped anything; keeping them would cost more than it explains.
    const h = createHarness();
    h.profiler.measureSync('tiny.thing', () => h.advance({ wallMs: 1 }));
    h.advance({ wallMs: 2000 });
    h.watchdogTick();
    const [stall] = stallLogs(h.logs);
    assert.deepEqual(stall.overlapping.map(o => o.name), []);
  });

  it('まだ終わっていない処理も名指しする', () => {
    // The ring only learns about an operation when it returns, so a long one
    // still running when the watchdog fires -- a router poll, say -- could
    // never appear. Four minutes of production reports came back empty on a
    // Hub where that poll was the obvious suspect.
    const h = createHarness();
    let seen = null;
    h.profiler.measureSync('outer.long', () => {
      h.advance({ wallMs: 2000 });
      h.watchdogTick();                       // fires while outer.long is open
      seen = h.logs.filter(([tag]) => tag === '[runtime-stall]').map(([, body]) => body);
    });
    assert.equal(seen.length, 1, '停止が報告されていない');
    const [entry] = seen[0].overlapping;
    assert.equal(entry.name, 'outer.long');
    assert.equal(entry.stillRunning, true, '実行中であることが分からない');
    assert.ok(entry.coversMs > 1000, `重なりが小さすぎる: ${entry.coversMs}`);
  });

  it('終わった処理と実行中の処理を、重なりの大きい順に並べる', () => {
    const h = createHarness();
    h.profiler.measureSync('finished.short', () => h.advance({ wallMs: 300 }));
    h.profiler.measureSync('outer.long', () => {
      h.advance({ wallMs: 2000 });
      h.watchdogTick();
    });
    const [stall] = h.logs.filter(([tag]) => tag === '[runtime-stall]').map(([, b]) => b);
    assert.equal(stall.overlapping[0].name, 'outer.long', '大きい方が先に来ていない');
  });

  it('終わった処理は実行中として報告しない', () => {
    const h = createHarness();
    h.profiler.measureSync('done.thing', () => h.advance({ wallMs: 1800 }));
    h.advance({ wallMs: 100 });
    h.watchdogTick();
    const [stall] = h.logs.filter(([tag]) => tag === '[runtime-stall]').map(([, b]) => b);
    assert.equal(stall.overlapping[0].name, 'done.thing');
    assert.equal(stall.overlapping[0].stillRunning, undefined);
  });

  it('計測されていない停止でも、走っていたスタックを名指しする', async () => {
    const cuts = [];
    const logs = [];
    let currentTime = 0;
    const intervalCallbacks = [];
    const profiler = createRuntimeProfiler({
      now: () => currentTime,
      cpuUsage: () => ({ user: 0, system: 0 }),
      memoryUsage: () => ({ rss: 0, heapUsed: 0 }),
      createHistogram: () => ({
        max: 0, enable: () => {}, disable: () => {}, reset: () => {}, percentile: () => 0,
      }),
      scheduleInterval: callback => { intervalCallbacks.push(callback); return { unref: () => {} }; },
      clearScheduledInterval: () => {},
      createStallSampler: () => ({
        start: async () => true,
        cut: async span => {
          cuts.push(span);
          return { samples: 20, totalMs: 1980, frames: [{ selfMs: 1900, stack: ['matchThreats threats.js:12'] }] };
        },
        stop: () => {},
        isRunning: () => true,
      }),
    });
    profiler.start({
      stallProfile: true,
      observeGc: false,
      logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    });
    await Promise.resolve();

    currentTime += 2000;
    intervalCallbacks[1]();
    await new Promise(resolve => setImmediate(resolve));

    const [stall] = logs.filter(([tag]) => tag === '[runtime-stall]').map(([, body]) => body);
    const [stack] = logs.filter(([tag]) => tag === '[runtime-stall-stack]').map(([, body]) => body);
    // The blind spot this exists for: nothing instrumented was running.
    assert.deepEqual(stall.overlapping, []);
    assert.equal(stack.frames[0].stack[0], 'matchThreats threats.js:12');
    // The two lines carry the same stall length, so they can be matched up.
    assert.equal(stack.atMs, stall.atMs);
    // The span asked about is the gap the loop spent away, not the whole
    // profile: one watchdog interval before it should have fired, until now.
    assert.equal(cuts[0].fromMs, 0);
    assert.equal(cuts[0].toMs, 2000);
  });

  it('窓の要約に、その窓で何回止まったかを載せる', () => {
    const h = createHarness();
    h.advance({ wallMs: 2000 });
    h.watchdogTick();
    h.emit();
    const [, snapshot] = h.logs.find(([tag]) => tag === '[runtime-profile]');
    assert.equal(snapshot.stalls, 1);
  });
});
