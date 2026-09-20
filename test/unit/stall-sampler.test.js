'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createStallSampler, summariseStallSamples } = require('../../src/stall-sampler');

// A profile shaped the way V8 hands one back: a node tree, a stream of sample
// ids, and the microseconds that elapsed before each sample.
function buildProfile() {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2, 4] },
      { id: 2, callFrame: { functionName: 'pollRouters', url: 'file:///app/src/poll.js', lineNumber: 40 }, children: [3] },
      { id: 3, callFrame: { functionName: 'matchThreats', url: 'file:///app/src/threats.js', lineNumber: 11 } },
      { id: 4, callFrame: { functionName: '(idle)', url: '' } },
    ],
    // 100 ms apart: idle before the stall, the stall itself, idle after.
    samples:    [4,      3,      3,      3,      4],
    timeDeltas: [100000, 100000, 100000, 100000, 100000],
  };
}

describe('停止サンプラ', () => {
  it('停止した区間のスタックだけを取り出す', () => {
    // The profile started at loop time 1000, so its samples land at 1100..1500.
    const summary = summariseStallSamples(buildProfile(), {
      startedAtMs: 1000, fromMs: 1180, toMs: 1420,
    });
    assert.equal(summary.frames[0].stack[0], 'matchThreats threats.js:12');
    assert.equal(summary.frames[0].stack[1], 'pollRouters poll.js:41');
    // Only the three samples inside the window, not the idle ones outside it.
    assert.equal(summary.frames.length, 1);
    assert.equal(summary.samples, 3);
    assert.equal(summary.totalMs, 300);
  });

  it('区間の外で起きたことは報告しない', () => {
    const summary = summariseStallSamples(buildProfile(), {
      startedAtMs: 1000, fromMs: 5000, toMs: 6000,
    });
    assert.equal(summary.samples, 0);
    assert.deepEqual(summary.frames, []);
  });

  it('サンプルが無いプロファイルでも落ちない', () => {
    const summary = summariseStallSamples({ nodes: [], samples: [], timeDeltas: [] }, {
      startedAtMs: 0, fromMs: 0, toMs: 100,
    });
    assert.deepEqual(summary, { samples: 0, totalMs: 0, frames: [] });
  });

  it('切り出すたびに次のプロファイルを始め直す', async () => {
    const calls = [];
    const sampler = createStallSampler({
      now: () => 1000,
      createSession: () => ({
        connect: () => calls.push('connect'),
        disconnect: () => calls.push('disconnect'),
        post: (method, params, callback) => {
          calls.push(method);
          const cb = typeof params === 'function' ? params : callback;
          cb(null, method === 'Profiler.stop' ? { profile: buildProfile() } : {});
        },
      }),
    });
    assert.equal(await sampler.start(), true);
    assert.equal(sampler.isRunning(), true);
    const summary = await sampler.cut({ fromMs: 1180, toMs: 1420 });
    assert.equal(sampler.isRunning(), true);
    // What the cut cost the loop is reported, not hidden: on the production
    // Hub it was 671 ms and showed up as a stall of its own.
    assert.equal(typeof summary.cutMs, 'number');
    assert.equal(summary.frames[0].stack[0], 'matchThreats threats.js:12');
    assert.deepEqual(calls, [
      'connect', 'Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start',
      'Profiler.stop', 'Profiler.start',
    ]);
  });

  it('要約しない切り出しでも、かかった時間だけは返す', async () => {
    let clock = 0;
    const sampler = createStallSampler({
      now: () => (clock += 7),
      createSession: () => ({
        connect: () => {},
        disconnect: () => {},
        post: (method, params, callback) => {
          const cb = typeof params === 'function' ? params : callback;
          cb(null, method === 'Profiler.stop' ? { profile: buildProfile() } : {});
        },
      }),
    });
    await sampler.start();
    const result = await sampler.cut({ summarise: false });
    assert.equal(result.frames, undefined);
    assert.ok(result.cutMs > 0);
  });

  it('インスペクタが使えなければ黙って諦める', async () => {
    const sampler = createStallSampler({
      createSession: () => { throw new Error('no inspector in this build'); },
    });
    assert.equal(await sampler.start(), false);
    assert.equal(sampler.isRunning(), false);
    assert.equal(await sampler.cut({ fromMs: 0, toMs: 1 }), null);
  });
});
