'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  buildFilterConditions,
  buildWhereAndParams,
  escapeLikeValue,
  makeLikePat,
} = require('../../src/history-queries');

describe('history query helpers', () => {
  it('escapes LIKE wildcard characters and backslashes', () => {
    assert.equal(escapeLikeValue('a%b_c\\d'), 'a\\%b\\_c\\\\d');
  });

  it('creates LIKE patterns for every supported match mode', () => {
    assert.equal(makeLikePat('startsWith', 'host'), 'host%');
    assert.equal(makeLikePat('endsWith', 'host'), '%host');
    assert.equal(makeLikePat('contains', 'host'), '%host%');
  });

  it('uses exact matching for source addresses when requested', () => {
    assert.deepEqual(buildFilterConditions({ src: { mode: 'exact', value: '192.0.2.10' } }), {
      conditions: ['src = ?'],
      params: ['192.0.2.10'],
    });
  });

  it('builds destination and source-name filters with matching parameters', () => {
    const result = buildFilterConditions({
      src: { mode: 'contains', value: 'laptop' },
      dst: { mode: 'startsWith', value: 'example' },
      srcMac: { mode: 'exact', value: '02:00:00:00:00:01' },
    });
    assert.deepEqual(result.params, [
      '%laptop%', '%laptop%', '%laptop%',
      'example%', 'example%',
      '02:00:00:00:00:01',
    ]);
    assert.equal(result.conditions.length, 3);
  });

  it('prepends time bounds to filter conditions', () => {
    assert.deepEqual(
      buildWhereAndParams(100, 200, { conditions: ['proto = ?'], params: ['TCP'] }),
      {
        where: ' WHERE lastSeen >= ? AND lastSeen <= ? AND proto = ?',
        params: [100, 200, 'TCP'],
      }
    );
  });
});
