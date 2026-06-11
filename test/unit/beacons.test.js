// Unit tests for src/beacons.js (SQLite CRUD)
// Run: node --test test/unit/beacons.test.js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const b = require('../../src/beacons');

const T0 = 1_700_000_000_000;

function makeEvent(overrides = {}) {
  return {
    src: '192.168.1.5', dst: '8.8.8.8', dstHost: 'dns.google',
    dport: 443, proto: 'tcp',
    seenAt: T0, source: 'inspect',
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    src: '192.168.1.5', dst: '8.8.8.8', dstHost: 'dns.google',
    dport: 443, proto: 'tcp',
    intervalMs: 300_000, intervalCov: 0.02,
    obsCount: 8, firstSeen: T0, lastSeen: T0 + 7 * 300_000,
    ...overrides,
  };
}

// ── setup / teardown ──────────────────────────────────────────────────────────

before(() => b._resetForTest());
after (() => b._closeForTest());

// ── connection_events ─────────────────────────────────────────────────────────

describe('appendEvent / getEvents', () => {
  before(() => b._resetForTest());

  it('stores an inspect event and retrieves it', () => {
    b.appendEvent(makeEvent({ seenAt: T0, source: 'inspect' }));
    const rows = b.getEvents(T0 - 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].src, '192.168.1.5');
    assert.equal(rows[0].source, 'inspect');
  });

  it('stores a poll event', () => {
    b.appendEvent(makeEvent({ seenAt: T0 + 1000, source: 'poll' }));
    const rows = b.getEvents(T0 - 1);
    assert.equal(rows.length, 2);
  });

  it('getEvents excludes events before the cutoff', () => {
    const rows = b.getEvents(T0 + 500); // only seenAt > T0+500 → the poll event
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'poll');
  });

  it('getEvents uses 7-day default cutoff when called with no argument', () => {
    b._resetForTest();
    const recent = Date.now();
    b.appendEvent(makeEvent({ seenAt: recent }));
    b.appendEvent(makeEvent({ seenAt: recent - 8 * 24 * 3600_000 })); // 8 days ago
    const rows = b.getEvents(); // default: last 7 days
    assert.equal(rows.length, 1);
    assert.ok(rows[0].seenAt >= recent - 100);
  });
});

describe('pruneEvents', () => {
  before(() => b._resetForTest());

  it('deletes events older than the cutoff and returns count', () => {
    b.appendEvent(makeEvent({ seenAt: T0 }));
    b.appendEvent(makeEvent({ seenAt: T0 + 1000 }));
    b.appendEvent(makeEvent({ seenAt: T0 + 2000 }));

    const deleted = b.pruneEvents(T0 + 1500); // delete seenAt < T0+1500
    assert.equal(deleted, 2);                 // T0 and T0+1000 gone
    assert.equal(b.getEvents(T0 - 1).length, 1);
  });
});

// ── beacons ───────────────────────────────────────────────────────────────────

describe('upsertBeacon / getBeacons', () => {
  before(() => b._resetForTest());

  it('inserts a new beacon candidate', () => {
    b.upsertBeacon(makeCandidate());
    const rows = b.getBeacons();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'candidate');
    assert.equal(rows[0].intervalMs, 300_000);
  });

  it('updates an existing candidate (same src/dst/dport/proto)', () => {
    b.upsertBeacon(makeCandidate({ obsCount: 12, intervalCov: 0.01 }));
    const rows = b.getBeacons();
    assert.equal(rows.length, 1, 'should still be 1 row (upserted)');
    assert.equal(rows[0].obsCount, 12);
    assert.equal(rows[0].intervalCov, 0.01);
  });

  it('inserts a separate candidate for a different dst', () => {
    b.upsertBeacon(makeCandidate({ dst: '1.1.1.1', dstHost: 'one.one.one.one' }));
    assert.equal(b.getBeacons().length, 2);
  });

  it('sorts getBeacons by intervalCov ASC', () => {
    b._resetForTest();
    b.upsertBeacon(makeCandidate({ dst: '1.1.1.1', intervalCov: 0.3 }));
    b.upsertBeacon(makeCandidate({ dst: '2.2.2.2', intervalCov: 0.1 }));
    b.upsertBeacon(makeCandidate({ dst: '3.3.3.3', intervalCov: 0.2 }));
    const rows = b.getBeacons();
    assert.equal(rows[0].dst, '2.2.2.2');
    assert.equal(rows[1].dst, '3.3.3.3');
    assert.equal(rows[2].dst, '1.1.1.1');
  });
});

// ── reopen() ──────────────────────────────────────────────────────────────────

describe('reopen', () => {
  it('reopens the same on-disk DB file without losing data', () => {
    // Use a real temp file so we can verify data survives a close+reopen cycle.
    const tmp = path.join(os.tmpdir(), `beacons-reopen-test-${Date.now()}.db`);
    try {
      b._resetForTest(tmp);                           // initDb(tmp) → _lastDbPath = tmp
      b.upsertBeacon(makeCandidate({ dst: '9.9.9.9' }));
      assert.equal(b.getBeacons().length, 1);

      b.reopen();                                     // no argument → must use _lastDbPath (tmp)
      assert.equal(b.getBeacons().length, 1, 'data should survive reopen() with no argument');
      assert.equal(b.getBeacons()[0].dst, '9.9.9.9');
    } finally {
      b._closeForTest();
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(tmp + '-wal'); } catch {}
      try { fs.unlinkSync(tmp + '-shm'); } catch {}
      b._resetForTest();                              // back to :memory: for subsequent tests
    }
  });
});

describe('dismissBeacon', () => {
  before(() => b._resetForTest());

  it('returns true and sets status=dismissed for existing id', () => {
    b.upsertBeacon(makeCandidate());
    const [{ id }] = b.getBeacons();
    const ok = b.dismissBeacon(id);
    assert.equal(ok, true);
    const [row] = b.getBeacons(); // getBeacons returns all statuses
    assert.equal(row.status, 'dismissed');
  });

  it('returns false for a non-existent id', () => {
    assert.equal(b.dismissBeacon(99999), false);
  });

  it('dismissed beacon is excluded from default getBeacons filter in route', () => {
    // Route filters status !== 'dismissed'; the module returns everything.
    // Verify that dismissed rows are still returned by getBeacons() itself
    // (filtering happens in the route layer).
    b._resetForTest();
    b.upsertBeacon(makeCandidate({ dst: '1.1.1.1' }));
    b.upsertBeacon(makeCandidate({ dst: '2.2.2.2' }));
    const [row] = b.getBeacons();
    b.dismissBeacon(row.id);
    assert.equal(b.getBeacons().length, 2); // module returns all
  });
});

// ─── Sticky dismiss + stale-candidate pruning (P2-20) ─────────────────────────

describe('sticky dismiss', () => {
  before(() => b._resetForTest());

  it('upsertBeacon does NOT resurrect a dismissed key', () => {
    b.upsertBeacon(makeCandidate({ dst: '9.8.7.6' }));
    const [{ id }] = b.getBeacons();
    b.dismissBeacon(id);

    // Next scan re-detects the same pattern → must stay dismissed-only
    b.upsertBeacon(makeCandidate({ dst: '9.8.7.6' }));
    const rows = b.getBeacons();
    assert.equal(rows.length, 1, 'no new candidate row created');
    assert.equal(rows[0].status, 'dismissed');
  });

  it('a different key is still inserted normally', () => {
    b.upsertBeacon(makeCandidate({ dst: '6.7.8.9' }));
    const cands = b.getBeacons().filter(r => r.status === 'candidate');
    assert.equal(cands.length, 1);
    assert.equal(cands[0].dst, '6.7.8.9');
  });
});

describe('pruneCandidatesNotIn', () => {
  before(() => b._resetForTest());

  it('removes candidates absent from the detected set, keeps detected ones', () => {
    b.upsertBeacon(makeCandidate({ dst: '1.1.1.1' }));
    b.upsertBeacon(makeCandidate({ dst: '2.2.2.2' }));
    b.upsertBeacon(makeCandidate({ dst: '3.3.3.3' }));

    const keep = [`192.168.1.5|2.2.2.2|443|tcp`];
    const removed = b.pruneCandidatesNotIn(keep);

    assert.equal(removed, 2);
    const rows = b.getBeacons();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dst, '2.2.2.2');
  });

  it('keeps dismissed rows even when not re-detected', () => {
    b._resetForTest();
    b.upsertBeacon(makeCandidate({ dst: '5.5.5.5' }));
    const [{ id }] = b.getBeacons();
    b.dismissBeacon(id);

    const removed = b.pruneCandidatesNotIn([]);  // nothing re-detected
    assert.equal(removed, 0, 'dismissed rows are not pruned');
    assert.equal(b.getBeacons()[0].status, 'dismissed');
  });

  it('empty detected set removes all candidates', () => {
    b._resetForTest();
    b.upsertBeacon(makeCandidate({ dst: '7.7.7.7' }));
    b.upsertBeacon(makeCandidate({ dst: '8.8.8.8' }));
    assert.equal(b.pruneCandidatesNotIn([]), 2);
    assert.equal(b.getBeacons().length, 0);
  });
});
