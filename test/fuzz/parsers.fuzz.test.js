// Fuzz tests for parsers that read untrusted external input (P2-71)
//
// Run (short, PR gate):  node --test test/fuzz/parsers.fuzz.test.js
// Run (long, on demand): FUZZ_ITERATIONS=20000 npm run test:fuzz
// Reproduce a failure:   FUZZ_SEED=123456 npm run test:fuzz
//
// Scope is deliberately narrow: functions that turn a string from a router,
// a syslog file or a conntrack table into structured data. Those strings come
// from devices EgressView does not control, and a parser that throws takes a
// poller down while one that never returns hangs it.
//
// Three properties are asserted for every generated input:
//   1. it does not throw
//   2. it returns within a time budget (catches catastrophic backtracking)
//   3. the return value has the declared shape
//
// No network I/O, and no real credentials or captured production logs: every
// sample below is synthetic and uses documentation address ranges.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { forEachInput, describeFailure } = require('./fuzz-lib');

const { TARGETS } = require('./targets');

// A short run keeps the PR gate fast; the nightly/manual run raises it.
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 300;
const SEED = Number(process.env.FUZZ_SEED) || Math.floor(Math.random() * 2 ** 31);

describe(`外部入力パーサのfuzz (seed=${SEED}, iterations=${ITERATIONS})`, () => {
  for (const [name, call, shapeOk, samples] of TARGETS) {
    it(`${name}: 例外を投げず、時間内に、定義済みshapeを返す`, () => {
      const failures = forEachInput({ samples, iterations: ITERATIONS, seed: SEED }, (input) => {
        const result = call(input);
        if (!shapeOk(result)) {
          throw new Error(`unexpected shape: ${Object.prototype.toString.call(result)}`);
        }
      });
      assert.deepEqual(
        failures.map(describeFailure),
        [],
        `${name} failed. Reproduce with FUZZ_SEED=${SEED}`
      );
    });
  }

  it('プロトタイプ汚染を持ち込まない', () => {
    // Several of these build objects keyed by parsed field names.
    const polluting = [
      '{"__proto__":{"polluted":true}}',
      '__proto__=polluted',
      'src=__proto__ dst=constructor',
      'Internet  __proto__  12  aabb.ccdd.eeff  ARPA  Gi0/1',
    ];
    for (const [name, call] of TARGETS) {
      for (const input of polluting) {
        try { call(input); } catch { /* covered by the case above */ }
        assert.equal({}.polluted, undefined, `${name} polluted Object.prototype`);
      }
    }
  });
});
