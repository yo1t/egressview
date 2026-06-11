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

// ─── Initial-payload filter ────────────────────────────────────────────────────
// P2-4: server emits only the last 1h on initial WS connect (initialLoad: true).
// Client then background-fetches the remaining 24h and merges with existing data.
// Tests below cover:
//   1. 1h initial emit window (server behaviour)
//   2. 24h background-fetch window (queryByTimeRange helper)
//   3. in-memory Map mirrors queryByTimeRange

describe('initial connection filter (P2-4: 1h initial emit + 24h background fetch)', () => {

  it('1h initial emit: excludes entries older than 1h', () => {
    const now    = Date.now();
    const cutoff = now - 3_600_000; // 1h — matches server.js P2-4

    // Use _appendAndLoad so entries appear in the in-memory Map (same as server.js path)
    history._appendAndLoad({ src: '192.168.1.1', dst: '10.0.0.9', dport: 80,  proto: 'TCP', firstSeen: now - 7_200_000, lastSeen: now - 7_200_000 }); // 2h ago
    history._appendAndLoad({ src: '192.168.1.1', dst: '10.0.0.8', dport: 443, proto: 'TCP', firstSeen: now - 1_000,     lastSeen: now - 1_000     }); // recent

    const wsPayload = [...history.getConnectionHistory().values()]
      .filter(c => c.lastSeen >= cutoff);

    assert.equal(wsPayload.length, 1, 'only entry within 1h should appear in initial emit');
    assert.equal(wsPayload[0].dst, '10.0.0.8');
  });

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

  it('in-memory Map filter mirrors queryByTimeRange for background 24h fetch', () => {
    const now    = Date.now();
    const cutoff = now - 86400_000; // 24h — used by client background fetch

    // _appendAndLoad populates both DB and in-memory Map
    history._appendAndLoad({ src: '192.168.1.1', dst: '10.0.0.1', dport: 80,  proto: 'TCP', firstSeen: now - 90_000_000, lastSeen: now - 90_000_000 });
    history._appendAndLoad({ src: '192.168.1.1', dst: '10.0.0.2', dport: 443, proto: 'TCP', firstSeen: now - 1000,       lastSeen: now - 1000       });

    // Simulate what the client background-fetches via GET /api/connections?from=<24h>
    const bgPayload = [...history.getConnectionHistory().values()]
      .filter(c => c.lastSeen >= cutoff);

    assert.equal(bgPayload.length, 1, 'only 1 recent entry should appear in background 24h fetch');
    assert.equal(bgPayload[0].dst, '10.0.0.2');
  });

});

// ─── Corrupt DB recovery (integrity check → backup restore) ───────────────────

describe('corrupt DB recovery', () => {
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const Database = require('better-sqlite3');
  const backup   = require('../../src/backup');

  function makeConnectionsDb(p, dst) {
    const d = new Database(p);
    d.pragma('journal_mode = WAL');
    d.exec(`CREATE TABLE IF NOT EXISTS connections (
      src TEXT NOT NULL, dst TEXT NOT NULL, dport INTEGER NOT NULL, proto TEXT NOT NULL,
      sport INTEGER, ttl INTEGER, srcMac TEXT, srcVendor TEXT, srcDnsName TEXT, srcMdnsName TEXT,
      dstHost TEXT, country TEXT, org TEXT, lat REAL, lon REAL, city TEXT,
      firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto)
    )`);
    d.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
               VALUES ('192.168.1.1', ?, 443, 'TCP', ?, ?)`).run(dst, Date.now(), Date.now());
    d.close();
  }

  it('restores from the latest backup when the DB file is corrupt', () => {
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'widemap-history-recovery-'));
    const dbPath    = path.join(tmpDir, 'test.db');
    const backupDir = path.join(tmpDir, 'backups');
    try {
      // A good backup exists…
      fs.mkdirSync(backupDir, { recursive: true });
      makeConnectionsDb(path.join(backupDir, 'widemap_2025-01-01_00-00-00.db'), '203.0.113.99');
      backup._setPathsForTest(dbPath, backupDir);

      // …and the live DB file is garbage
      fs.writeFileSync(dbPath, 'this is not a sqlite database');

      history._initForTest(dbPath);   // integrity fails → restore from backup

      const rows = history.queryByTimeRange(null, null);
      assert.equal(rows.length, 1, 'row from the backup should be present');
      assert.equal(rows[0].dst, '203.0.113.99');
    } finally {
      history._initForTest();         // back to :memory: for subsequent tests
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to an empty DB when no backup exists', () => {
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'widemap-history-recovery-'));
    const dbPath    = path.join(tmpDir, 'test.db');
    const emptyDir  = path.join(tmpDir, 'backups-empty');
    try {
      backup._setPathsForTest(dbPath, emptyDir);
      fs.writeFileSync(dbPath, 'garbage');

      history._initForTest(dbPath);   // integrity fails → no backup → empty DB

      assert.equal(history.queryByTimeRange(null, null).length, 0);
    } finally {
      history._initForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
