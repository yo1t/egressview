'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createDestinationLabels } = require('../../src/destination-labels');

// A database that answers the one query the cache makes, and counts how many
// destinations it was actually asked about. That count is the whole point:
// naming 15,712 destinations from `connections` was measured at 486-506 ms on
// the production Hub and led 32 of 43 stall stacks (P3-156).
function fakeDb(rowsByDst, log = []) {
  return {
    prepare(sql) {
      return {
        all(...params) {
          log.push(params.length);
          assert.match(sql, /FROM connections WHERE dst IN/);
          return params
            .filter(dst => rowsByDst.has(dst))
            .map(dst => ({ dst, ...rowsByDst.get(dst) }));
        },
      };
    },
  };
}

describe('destination labels', () => {
  it('asks the database only about destinations it does not know', () => {
    const rows = new Map([
      ['203.0.113.1', { org: 'Example Org', dstHost: 'a.example' }],
      ['203.0.113.2', { org: null, dstHost: 'b.example' }],
    ]);
    const asked = [];
    const cache = createDestinationLabels({ random: () => 0.5 });
    const db = fakeDb(rows, asked);

    const first = cache.resolve(db, ['203.0.113.1', '203.0.113.2']);
    assert.equal(first.get('203.0.113.1'), 'Example Org');
    assert.equal(first.get('203.0.113.2'), 'b.example');
    assert.deepEqual(asked, [2]);

    const second = cache.resolve(db, ['203.0.113.1', '203.0.113.2']);
    assert.deepEqual(second, first);
    assert.deepEqual(asked, [2], 'the second render asked again');
  });

  it('asks only for the destinations that are new', () => {
    const rows = new Map([
      ['203.0.113.1', { org: 'One', dstHost: null }],
      ['203.0.113.9', { org: 'Nine', dstHost: null }],
    ]);
    const asked = [];
    const cache = createDestinationLabels({ random: () => 0.5 });
    const db = fakeDb(rows, asked);

    cache.resolve(db, ['203.0.113.1']);
    const labels = cache.resolve(db, ['203.0.113.1', '203.0.113.9']);
    assert.equal(labels.get('203.0.113.9'), 'Nine');
    assert.deepEqual(asked, [1, 1]);
  });

  // An address enrichment has not reached yet is answered with itself. Keeping
  // that answer for six hours would freeze the bare address onto the chart
  // long after the name arrived.
  it('does not remember a destination that has no name yet', () => {
    const rows = new Map([['203.0.113.7', { org: null, dstHost: null }]]);
    const asked = [];
    const cache = createDestinationLabels({ random: () => 0.5 });
    const db = fakeDb(rows, asked);

    assert.equal(cache.resolve(db, ['203.0.113.7']).get('203.0.113.7'), '203.0.113.7');
    rows.set('203.0.113.7', { org: 'Named Later', dstHost: null });
    assert.equal(cache.resolve(db, ['203.0.113.7']).get('203.0.113.7'), 'Named Later');
    assert.deepEqual(asked, [1, 1]);
  });

  it('asks again once a name has aged out', () => {
    const rows = new Map([['203.0.113.1', { org: 'Before', dstHost: null }]]);
    const asked = [];
    let clock = 1_000;
    const cache = createDestinationLabels({
      ttlMs: 1_000, random: () => 0.5, now: () => clock,
    });
    const db = fakeDb(rows, asked);

    assert.equal(cache.resolve(db, ['203.0.113.1']).get('203.0.113.1'), 'Before');
    clock += 900;
    cache.resolve(db, ['203.0.113.1']);
    assert.deepEqual(asked, [1], 'expired early');

    clock += 200;
    rows.set('203.0.113.1', { org: 'After', dstHost: null });
    assert.equal(cache.resolve(db, ['203.0.113.1']).get('203.0.113.1'), 'After');
    assert.deepEqual(asked, [1, 1]);
  });

  // Without the spread, every name learned during one render expires during
  // one later render, and that render pays the full 486 ms this exists to
  // remove.
  it('spreads expiry so that names learned together do not age out together', () => {
    const rows = new Map();
    for (let i = 0; i < 200; i += 1) rows.set(`203.0.113.${i}`, { org: `Org ${i}`, dstHost: null });
    let clock = 0;
    let n = 0;
    const cache = createDestinationLabels({
      ttlMs: 1_000, now: () => clock, random: () => ((n += 1) % 100) / 100,
    });
    const asked = [];
    const db = fakeDb(rows, asked);
    const all = [...rows.keys()];

    cache.resolve(db, all);
    clock += 1_000;
    cache.resolve(db, all);
    const refreshed = asked[1];
    assert.ok(refreshed > 0 && refreshed < all.length,
      `expected a fraction to age out, got ${refreshed} of ${all.length}`);
  });

  it('stays bounded', () => {
    const rows = new Map();
    for (let i = 0; i < 50; i += 1) rows.set(`198.51.100.${i}`, { org: `Org ${i}`, dstHost: null });
    const cache = createDestinationLabels({ maxEntries: 10, random: () => 0.5 });
    cache.resolve(fakeDb(rows), [...rows.keys()]);
    assert.equal(cache.size, 10);
  });
});
