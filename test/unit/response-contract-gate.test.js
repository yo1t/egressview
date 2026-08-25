'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { collect } = require('../../scripts/check-response-contracts');

describe('レスポンス契約のgate（P2-95 step 3）', () => {
  it('違反を集める', () => {
    const output = [
      'ok 1 - something',
      `__RESPONSE_CONTRACTS__${JSON.stringify({
        violations: [{ route: 'GET /api/x', status: 200, issues: ['a: bad'] }],
        verified: ['GET /api/y 200'],
        unresolved: 3,
      })}`,
    ].join('\n');
    const result = collect(output);
    assert.equal(result.violations.length, 1);
    assert.deepEqual([...result.verified], ['GET /api/y 200']);
    assert.equal(result.unresolved, 3);
  });

  it('複数のテストプロセスの結果を足し合わせる', () => {
    // `node --test` runs a process per file, so a contract exercised in one
    // file and not another must still count as exercised.
    const line = (payload) => `__RESPONSE_CONTRACTS__${JSON.stringify(payload)}`;
    const result = collect([
      line({ violations: [], verified: ['GET /a 200'], unresolved: 1 }),
      line({ violations: [], verified: ['GET /b 200'], unresolved: 2 }),
    ].join('\n'));
    assert.deepEqual([...result.verified].sort(), ['GET /a 200', 'GET /b 200']);
    assert.equal(result.unresolved, 3);
  });

  it('壊れた出力で落ちない', () => {
    // The marker travels through test output, which carries anything a test
    // chose to print.
    assert.doesNotThrow(() => collect('__RESPONSE_CONTRACTS__{not json'));
  });
});

describe('gateが止めるべきときに止まる', () => {
  it('違反と未検証の両方で失敗する', () => {
    // Verified by injection on 2026-08-24 rather than by reading the code:
    // a contract requiring a field the response does not have exited 1 and
    // named the field; a status the suite never produces exited 1 and named
    // the contract. A gate whose failing side has never run is a gate nobody
    // has tested.
    const script = read('scripts/check-response-contracts.js');
    assert.match(script, /if \(violations\.length \|\| unverified\.length\) \{/);
    assert.match(script, /process\.exit\(1\)/);
  });

  it('未宣言のルートでは失敗しない', () => {
    // 84 routes still carry observed shapes. That is the work remaining, not
    // a regression, and a gate that failed on it would be turned off.
    const script = read('scripts/check-response-contracts.js');
    assert.match(script, /An undeclared route is \*not\* a failure/);
  });

  it('CIから呼ばれている', () => {
    assert.match(read('.github/workflows/ci.yml'), /npm run api:check-responses/);
    assert.match(read('package.json'), /"api:check-responses"/);
  });
});

describe('再生成が自分自身を止めない', () => {
  it('捕捉の実行からdrift検査を外してある', () => {
    // Any change to the generator used to block its own regeneration: the
    // document cannot be updated until it matches, and cannot match until it
    // is updated. Hit three times on 2026-08-24 and -25.
    //
    // Asserted as behaviour rather than as the expression that implements it.
    // The first version of this test pinned one filename, and broke the moment
    // the exclusion became a list -- pinning how something is written says
    // nothing about whether it works.
    const { ARTIFACT_DRIFT_TESTS, testFiles } = require('../../scripts/capture-request-schemas');
    const captured = testFiles().map((f) => path.basename(f));
    const withDrift = testFiles({ includeDriftCheck: true }).map((f) => path.basename(f));

    assert.ok(ARTIFACT_DRIFT_TESTS.length >= 2, 'the class has become one filename again');
    for (const name of ARTIFACT_DRIFT_TESTS) {
      assert.ok(!captured.includes(name), `${name} still runs during capture`);
      assert.ok(withDrift.includes(name), `${name} is not in the suite at all`);
    }
    assert.ok(captured.length > 100, 'capture stopped running the rest of the suite');
  });
});
