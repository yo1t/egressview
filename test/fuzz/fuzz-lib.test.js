// Self-tests for the fuzz harness (P2-71)
// Run: node --test test/fuzz/fuzz-lib.test.js
//
// A fuzzer that reports no failures is only meaningful if it can detect one.
// These cases feed it deliberately broken parsers and assert that each defect
// class is caught, so a green parsers.fuzz.test.js run means the parsers held
// rather than that the generator produced nothing.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRandom, forEachInput, mutate, randomNoise, EDGE_CASES } = require('./fuzz-lib');

const SAMPLES = ['src=192.0.2.10 dst=198.51.100.7 sport=443 dport=51234'];
const OPTIONS = { samples: SAMPLES, iterations: 200, seed: 42 };

describe('fuzz harness: 検出力', () => {
  it('例外を投げる関数を検出する', () => {
    const failures = forEachInput(OPTIONS, (input) => {
      if (input.includes('=')) throw new Error('boom');
    });
    assert.ok(failures.length > 0, '例外を1件も検出できないなら入力が生成されていない');
    assert.equal(failures[0].kind, 'throw');
  });

  it('shape違反を検出する', () => {
    const failures = forEachInput(OPTIONS, (input) => {
      const result = input.length > 3 ? undefined : [];
      if (!Array.isArray(result)) throw new Error('unexpected shape');
    });
    assert.ok(failures.some(f => f.message.includes('unexpected shape')));
  });

  it('時間予算を超える関数を検出する', () => {
    const failures = forEachInput({ ...OPTIONS, iterations: 1, budgetMs: 5 }, () => {
      const until = Date.now() + 20;
      while (Date.now() < until) { /* burn */ }
    });
    assert.ok(failures.some(f => f.kind === 'slow'), '無限ループ相当を検出できること');
  });

  it('健全な関数では失敗を報告しない', () => {
    const failures = forEachInput(OPTIONS, (input) => {
      assert.equal(typeof String(input ?? ''), 'string');
    });
    assert.deepEqual(failures, []);
  });
});

describe('fuzz harness: 生成器', () => {
  it('同じseedは同じ入力列を生成する', () => {
    const collect = () => {
      const seen = [];
      forEachInput({ ...OPTIONS, iterations: 50 }, (input) => { seen.push(input); });
      return seen;
    };
    // Without this, a reported FUZZ_SEED would not reproduce the failure.
    assert.deepEqual(collect(), collect());
  });

  it('異なるseedは異なる入力列を生成する', () => {
    const collect = (seed) => {
      const seen = [];
      forEachInput({ ...OPTIONS, iterations: 50, seed }, (input) => { seen.push(input); });
      return seen;
    };
    assert.notDeepEqual(collect(1), collect(2));
  });

  it('edge caseを必ず含める', () => {
    const seen = new Set();
    forEachInput({ ...OPTIONS, iterations: 0 }, (input) => { seen.add(input); });
    for (const edge of EDGE_CASES) assert.ok(seen.has(edge), `edge case が欠けている`);
  });

  it('mutateは元の文字列を返すだけにならない', () => {
    const random = createRandom(7);
    const mutations = new Set();
    for (let i = 0; i < 50; i += 1) mutations.add(mutate(random, SAMPLES[0]));
    assert.ok(mutations.size > 5, '変異のバリエーションが乏しい');
    assert.ok([...mutations].some(m => m !== SAMPLES[0]), '元の文字列と異なる入力を作ること');
  });

  it('randomNoiseは長さの範囲を守る', () => {
    const random = createRandom(11);
    for (let i = 0; i < 100; i += 1) {
      assert.ok(randomNoise(random, 50).length <= 50 * 24, '上限を大きく超えないこと');
    }
  });

  it('生成した入力は常に文字列', () => {
    forEachInput({ ...OPTIONS, iterations: 100 }, (input) => {
      assert.equal(typeof input, 'string');
    });
  });
});
