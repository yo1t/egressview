'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRegistry } = require('../../src/response-contracts');
const { isNeverEnforced } = require('../../src/response-contract');

const document = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8')
);
const coverage = document['x-response-contract-coverage'];

function schemaFor(pathName, method, status) {
  return document.paths?.[pathName]?.[method]?.responses?.[status]
    ?.content?.['application/json']?.schema;
}

describe('宣言は観測を置き換える（P2-95 step 2）', () => {
  it('宣言したレスポンスから x-observed が外れる', () => {
    // The two are not the same claim. One says what the server promises; the
    // other says what it happened to do while the tests were watching.
    const declared = schemaFor('/api/status', 'get', '200');
    assert.ok(declared, 'GET /api/status 200 has no schema');
    assert.equal(declared['x-observed'], undefined);
    assert.equal(document.paths['/api/status'].get.responses['200'].description,
      'Declared by the server.');
  });

  it('宣言していないレスポンスには x-observed が残る', () => {
    // Removing it everywhere would be the easy way to a tidy document and a
    // false one.
    const observedOnly = coverage.observedOnly[0];
    assert.ok(observedOnly, 'nothing is observed-only, which cannot be right yet');
    const [method, route] = observedOnly.split(' ');
    const responses = document.paths[route][method.toLowerCase()].responses;
    const withSchema = Object.values(responses).find(
      (r) => r.content?.['application/json']?.schema
    );
    assert.equal(withSchema.content['application/json'].schema['x-observed'], true);
  });

  it('観測から作れない事実を、宣言は含められる', () => {
    // `GET /api/status` spreads `offlinePolicy.describe()` into its body, and
    // no test runs in offline mode -- so the observed schema had never seen a
    // single one of those fields. A declaration written from the handler
    // allows them; an observation cannot know they exist.
    const declared = schemaFor('/api/status', 'get', '200');
    assert.notEqual(declared.additionalProperties, false,
      'a response that grows a field must not start failing');
  });
});

describe('分かっていない範囲を数える', () => {
  it('111 operationの内訳が出ている', () => {
    // A coverage report that only counted successes would be the same mistake
    // as counting an unmatched route as a pass.
    for (const key of ['declared', 'observedOnly', 'neverEnforced', 'undescribed']) {
      assert.ok(Array.isArray(coverage[key]), `${key} missing from the coverage report`);
    }
    const total = Object.values(coverage).reduce((sum, list) => sum + list.length, 0);
    assert.ok(total > 100, `expected every operation to be accounted for, got ${total}`);
  });

  it('宣言済みの一覧が登録簿と一致する', () => {
    // Otherwise the document could claim a contract the server does not hold.
    assert.deepEqual(coverage.declared, createRegistry().declaredRoutes());
  });

  it('恒久的な除外は、未宣言ではなく除外として数える', () => {
    // "Not done yet" and "never" must not share a bucket.
    for (const route of coverage.neverEnforced) {
      assert.ok(isNeverEnforced(route), `${route} is reported excluded but is not on the list`);
      assert.ok(!coverage.observedOnly.includes(route));
      assert.ok(!coverage.undescribed.includes(route));
    }
    assert.ok(coverage.neverEnforced.includes('GET /readyz'));
  });

  it('レスポンスの二種類を、文書の冒頭が説明している', () => {
    // A reader who takes an observation for a promise has been misled by this
    // document rather than helped by it.
    const description = document.info.description;
    assert.match(description, /\*\*seen to return under test\*\*/);
    assert.match(description, /declared by the server/i);
    assert.match(description, /x-array-elements-observed/);
  });
});
