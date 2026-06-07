// Unit tests for connection history (queryByTimeRange + WebSocket filter logic)
// Run: node --test test/unit/history.test.js
// Uses an in-memory SQLite DB — no production data touched.

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const history = require('../../src/history');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _dstCounter = 0;

/** Insert a unique entry. overrides.dst defaults to a unique IP so PK never collides. */
function insert(overrides = {}) {
  const now = Date.now();
  const entry = {
    src:       '192.168.1.1',
    dst:       `10.0.0.${++_dstCounter % 254 + 1}`,
    dport:     443,
    proto:     'TCP',
    firstSeen: now,
    lastSeen:  now,
    ...overrides,
  };
  history.appendHistoryLog(entry);
  return entry;
}

/** Insert + sync to in-memory Map (for partial:true filter tests). */
function insertLoaded(overrides = {}) {
  const entry = { ...insert(overrides) };
  // re-call with _appendAndLoad so Map is populated too
  _dstCounter--; // undo counter increment from insert()
  const entry2 = {
    src:       '192.168.1.1',
    dst:       `10.0.0.${++_dstCounter % 254 + 1}`,
    dport:     443,
    proto:     'TCP',
    firstSeen: Date.now(),
    lastSeen:  Date.now(),
    ...overrides,
  };
  history._appendAndLoad(entry2);
  return entry2;
}

// Fresh in-memory DB before each test
beforeEach(() => {
  history._initForTest();
  _dstCounter = 0;
});

// ─── queryByTimeRange ─────────────────────────────────────────────────────────

describe('queryByTimeRange', () => {

  it('returns only entries whose lastSeen falls within from–to', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: t - 5000, firstSeen: t - 5000 });  // outside (too old)
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: t - 3000, firstSeen: t - 3000 });  // inside
    insert({ dst: '10.0.0.3', dport: 53,  lastSeen: t - 1000, firstSeen: t - 1000 });  // outside (too new)

    const results = history.queryByTimeRange(t - 4000, t - 2000);

    assert.equal(results.length, 1, `expected 1 result, got ${results.length}`);
    assert.equal(results[0].dst, '10.0.0.2');
  });

  it('excludes entries that are too old (before from)', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80, lastSeen: t - 10000, firstSeen: t - 10000 });

    const results = history.queryByTimeRange(t - 5000, t);
    assert.equal(results.length, 0);
  });

  it('excludes entries that are too new (after to)', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80, lastSeen: t + 10000, firstSeen: t + 10000 });

    const results = history.queryByTimeRange(t - 1000, t);
    assert.equal(results.length, 0);
  });

  it('returns all entries when both from and to are null', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: t - 2000, firstSeen: t - 2000 });
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });

    const results = history.queryByTimeRange(null, null);
    assert.equal(results.length, 2);
  });

  it('returns empty array when DB has no matching entries', () => {
    const t = Date.now();
    const results = history.queryByTimeRange(t - 1000, t);
    assert.deepEqual(results, []);
  });

  it('returns empty array when DB has no entries at all', () => {
    // _initForTest() already gave us a fresh empty DB
    const results = history.queryByTimeRange(null, null);
    assert.deepEqual(results, []);
  });

  it('includes entries exactly on the from boundary (>=)', () => {
    const t = Date.now() - 1000;
    insert({ dst: '10.0.0.1', dport: 80, lastSeen: t, firstSeen: t });

    const results = history.queryByTimeRange(t, t + 5000);
    assert.equal(results.length, 1);
  });

  it('includes entries exactly on the to boundary (<=)', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80, lastSeen: t, firstSeen: t });

    const results = history.queryByTimeRange(t - 5000, t);
    assert.equal(results.length, 1);
  });

});

// ─── 24h initial-payload filter (partial: true logic) ─────────────────────────
// server.js: connections = [...getConnectionHistory().values()].filter(c => c.lastSeen >= cutoff)
// These tests verify the same 86400s window via queryByTimeRange and the in-memory Map.

describe('24h initial connection filter (partial: true)', () => {

  it('queryByTimeRange with 24h cutoff excludes entries older than 24h', () => {
    const now  = Date.now();
    const cutoff = now - 86400_000;

    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: now - 90_000_000, firstSeen: now - 90_000_000 }); // > 25h
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: now - 1000,       firstSeen: now - 1000       }); // recent

    const results = history.queryByTimeRange(cutoff, null);
    assert.equal(results.length, 1, 'only the recent entry should appear');
    assert.equal(results[0].dst, '10.0.0.2');
  });

  it('queryByTimeRange with 24h cutoff includes entries within 24h', () => {
    const now    = Date.now();
    const cutoff = now - 86400_000;

    // Insert several entries all within 24h
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: now - 3600_000,  firstSeen: now - 3600_000 });  // 1h ago
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: now - 43200_000, firstSeen: now - 43200_000 }); // 12h ago

    const results = history.queryByTimeRange(cutoff, null);
    assert.equal(results.length, 2);
    assert(results.every(r => r.lastSeen >= cutoff), 'all results must be within 24h');
  });

  it('in-memory Map filter mirrors queryByTimeRange for WebSocket emit', () => {
    const now    = Date.now();
    const cutoff = now - 86400_000;

    // _appendAndLoad populates both DB and in-memory Map
    history._appendAndLoad({ src: '192.168.1.1', dst: '10.0.0.1', dport: 80,  proto: 'TCP', firstSeen: now - 90_000_000, lastSeen: now - 90_000_000 });
    history._appendAndLoad({ src: '192.168.1.1', dst: '10.0.0.2', dport: 443, proto: 'TCP', firstSeen: now - 1000,       lastSeen: now - 1000       });

    // Simulate what server.js does for the initial WebSocket send
    const wsPayload = [...history.getConnectionHistory().values()]
      .filter(c => c.lastSeen >= cutoff);

    assert.equal(wsPayload.length, 1, 'only 1 recent entry should appear in initial WS payload');
    assert.equal(wsPayload[0].dst, '10.0.0.2');
  });

});
