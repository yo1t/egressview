'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runInSlices, MIN_SLICE, MAX_SLICE, DEFAULT_TARGET_MS } = require('../../src/slice-runner');

/// A clock and a yield that the test drives, so the behaviour can be asserted
/// rather than timed.
function harness({ costPerItem = 1, items = 1000 } = {}) {
  let clock = 0;
  const seen = [];
  const sliceSizes = [];
  const yields = [];
  return {
    items: Array.from({ length: items }, (_, i) => i),
    seen, sliceSizes, yields,
    options: {
      processSlice: (slice) => {
        sliceSizes.push(slice.length);
        for (const item of slice) seen.push(item);
        clock += slice.length * costPerItem;
      },
      now: () => clock,
      yieldToLoop: async () => { yields.push(clock); },
    },
  };
}

describe('長い同期処理を切って、間でイベントループに返す', () => {
  it('全部を、順番どおり、一度ずつ処理する', async () => {
    // The point of slicing is to change when the work happens, not what it is.
    const h = harness({ items: 777 });
    await runInSlices(h.items, h.options);
    assert.deepEqual(h.seen, h.items);
  });

  it('切れ目ごとに制御を返す。最後だけは返さない', async () => {
    const h = harness({ items: 777 });
    const result = await runInSlices(h.items, h.options);
    assert.equal(h.yields.length, result.slices - 1, '切れ目の数と譲る回数が合わない');
    assert.ok(result.slices > 1, '1回で終わってしまい、分割されていない');
  });

  it('1回の同期区間が目標時間の近くに収まる', async () => {
    // The defect, stated as a test: one slice for everything is 1.9 seconds of
    // a blocked event loop on the Hub this was measured on.
    const h = harness({ items: 5000, costPerItem: 0.5 });  // 2,500ms if done at once
    const result = await runInSlices(h.items, { ...h.options, targetMs: 50 });
    assert.ok(result.longestMs <= 50 * 3,
      `最長の区間が ${result.longestMs}ms。目標50msから離れすぎている`);
    assert.ok(result.slices >= 10, `区間が ${result.slices} 個しかない`);
  });

  it('遅い仕事ほど細かく切る', async () => {
    const slow = harness({ items: 4000, costPerItem: 2 });
    const fast = harness({ items: 4000, costPerItem: 0.05 });
    const slowResult = await runInSlices(slow.items, slow.options);
    const fastResult = await runInSlices(fast.items, fast.options);
    assert.ok(slowResult.slices > fastResult.slices,
      '1件あたりが重いのに、区間の数が増えていない');
  });

  it('極端な1回に引きずられない', async () => {
    // A slice that costs nothing would otherwise ask for a slice of everything
    // next, which is the state this exists to prevent.
    const h = harness({ items: 10_000, costPerItem: 0 });
    await runInSlices(h.items, h.options);
    assert.ok(Math.max(...h.sliceSizes) <= MAX_SLICE, '上限を越えた区間がある');
    assert.ok(Math.min(...h.sliceSizes) >= Math.min(MIN_SLICE, 10_000),
      '下限を下回った区間がある');
  });

  it('空なら何もしない', async () => {
    const h = harness();
    const result = await runInSlices([], h.options);
    assert.deepEqual(result, { slices: 0, longestMs: 0 });
    assert.equal(h.sliceSizes.length, 0);
  });

  it('目標時間は指定でき、既定は測って決めた値', async () => {
    assert.equal(DEFAULT_TARGET_MS, 50);
    await assert.rejects(
      async () => runInSlices([1], { processSlice: () => {}, targetMs: 0 }),
      TypeError
    );
  });
});
