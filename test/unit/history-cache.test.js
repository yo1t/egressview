'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createHistoryCache,
  parseHotMaxEntries,
  DEFAULT_HOT_MAX_ENTRIES,
} = require('../../src/history-cache');

describe('history hot cache', () => {
  it('normalizes invalid limits to the production default', () => {
    for (const value of [undefined, null, 0, -1, 1.5, 'bad']) {
      assert.equal(parseHotMaxEntries(value), DEFAULT_HOT_MAX_ENTRIES);
    }
    assert.equal(parseHotMaxEntries('25'), 25);
  });

  it('keeps a stable Map while replacing its contents', () => {
    const cache = createHistoryCache(10);
    const reference = cache.map;
    cache.set('old', { lastSeen: 1 });
    cache.replace([{ key: 'new', lastSeen: 2 }], value => value.key);
    assert.equal(cache.map, reference);
    assert.deepEqual([...reference.keys()], ['new']);
  });

  it('evicts the oldest entries when the limit is exceeded', () => {
    const cache = createHistoryCache(2);
    cache.set('one', { lastSeen: 1 });
    cache.set('two', { lastSeen: 2 });
    assert.equal(cache.set('three', { lastSeen: 3 }), 1);
    assert.deepEqual([...cache.map.keys()].sort(), ['three', 'two']);
  });

  it('prunes expired entries before applying the size limit', () => {
    const cache = createHistoryCache(3);
    cache.map.set('old', { lastSeen: 1 });
    cache.map.set('new-a', { lastSeen: 10 });
    cache.map.set('new-b', { lastSeen: 20 });
    assert.deepEqual(cache.prune(5), { expired: 1, evicted: 0 });
    assert.deepEqual([...cache.map.keys()], ['new-a', 'new-b']);
  });

  it('applies reserve eviction for large caches', () => {
    const cache = createHistoryCache(1000);
    for (let i = 0; i <= 1000; i++) cache.map.set(String(i), { lastSeen: i });
    const result = cache.setLimit(1000);
    assert.equal(result.evicted, 101);
    assert.equal(cache.map.size, 900);
  });
});
