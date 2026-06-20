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
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-history-recovery-'));
    const dbPath    = path.join(tmpDir, 'test.db');
    const backupDir = path.join(tmpDir, 'backups');
    try {
      // A good backup exists…
      fs.mkdirSync(backupDir, { recursive: true });
      makeConnectionsDb(path.join(backupDir, 'egressview_2025-01-01_00-00-00.db'), '203.0.113.99');
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
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-history-recovery-'));
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

// ─── logNotification / queryNotificationLog ───────────────────────────────────

function makeNotifEntry(overrides = {}) {
  return {
    src:         '192.168.1.10',
    srcMac:      'aa:bb:cc:dd:ee:ff',
    srcVendor:   'Apple',
    srcMdnsName: 'MacBook-Pro',
    srcDnsName:  null,
    dst:         '185.220.101.45',
    dstHost:     'evil.example.com',
    dport:       443,
    proto:       'TCP',
    country:     'RU',
    city:        'Moscow',
    org:         'Evil Corp',
    threat:      { source: 'feodo', tag: 'Emotet C2', confidence: 'high' },
    ...overrides,
  };
}

describe('logNotification + queryNotificationLog', () => {

  it('returns empty array when no records exist', () => {
    const rows = history.queryNotificationLog(null, null);
    assert.deepEqual(rows, []);
  });

  it('stores a threat record and retrieves it', () => {
    const entry = makeNotifEntry();
    history.logNotification(entry, 'threat', false);

    const rows = history.queryNotificationLog(null, null);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.type,          'threat');
    assert.equal(row.slackSent,     0);
    assert.equal(row.src,           '192.168.1.10');
    assert.equal(row.srcVendor,     'Apple');
    assert.equal(row.srcMac,        'aa:bb:cc:dd:ee:ff');
    assert.equal(row.dst,           '185.220.101.45');
    assert.equal(row.dstHost,       'evil.example.com');
    assert.equal(row.dport,         443);
    assert.equal(row.proto,         'TCP');
    assert.equal(row.country,       'RU');
    assert.equal(row.threatTag,     'Emotet C2');
    assert.equal(row.threatSource,  'feodo');
    assert.ok(row.detectedAt > 0, 'detectedAt should be a positive timestamp');
  });

  it('stores slackSent=true correctly', () => {
    history.logNotification(makeNotifEntry(), 'threat', true);
    const rows = history.queryNotificationLog(null, null);
    assert.equal(rows[0].slackSent, 1);
  });

  it('stores a new_device record', () => {
    const entry = makeNotifEntry({ threat: null, dst: null, dstHost: null, dport: null, proto: null });
    history.logNotification(entry, 'new_device', false);

    const rows = history.queryNotificationLog(null, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type,    'new_device');
    assert.equal(rows[0].slackSent, 0);
    assert.equal(rows[0].src,     '192.168.1.10');
    assert.equal(rows[0].dst,     null);
    assert.equal(rows[0].threatTag, null);
  });

  it('returns multiple records in descending detectedAt order', () => {
    history.logNotification(makeNotifEntry(), 'threat',     false);
    history.logNotification(makeNotifEntry(), 'new_device', false);
    history.logNotification(makeNotifEntry(), 'threat',     true);

    const rows = history.queryNotificationLog(null, null);
    assert.equal(rows.length, 3);
    // verify descending order
    for (let i = 0; i < rows.length - 1; i++) {
      assert.ok(rows[i].detectedAt >= rows[i + 1].detectedAt,
        'rows should be in descending detectedAt order');
    }
  });

  it('filters by from (detectedAt >= from)', () => {
    const before = Date.now() - 5000;
    history.logNotification(makeNotifEntry(), 'threat', false);
    const after = Date.now() + 5000;

    const none = history.queryNotificationLog(after, null);
    assert.equal(none.length, 0, 'should return nothing when from is in the future');

    const all = history.queryNotificationLog(before, null);
    assert.equal(all.length, 1, 'should return the record when from is in the past');
  });

  it('filters by to (detectedAt <= to)', () => {
    history.logNotification(makeNotifEntry(), 'threat', false);

    const past = Date.now() - 5000;
    const none = history.queryNotificationLog(null, past);
    assert.equal(none.length, 0, 'should return nothing when to is in the past');

    const future = Date.now() + 5000;
    const all = history.queryNotificationLog(null, future);
    assert.equal(all.length, 1, 'should return the record when to is in the future');
  });

  it('filters by both from and to as a time range', () => {
    const t0 = Date.now();
    history.logNotification(makeNotifEntry(), 'threat',     false);
    history.logNotification(makeNotifEntry(), 'new_device', false);
    const t1 = Date.now();

    const rows = history.queryNotificationLog(t0 - 1000, t1 + 1000);
    assert.equal(rows.length, 2);

    const none = history.queryNotificationLog(t1 + 1, t1 + 9999);
    assert.equal(none.length, 0);
  });
});

// ─── queryByTimeRangePaged ────────────────────────────────────────────────────

describe('queryByTimeRangePaged', () => {
  it('returns at most limit rows', () => {
    const t = Date.now();
    for (let i = 0; i < 5; i++) insert({ lastSeen: t - i * 1000, firstSeen: t - i * 1000 });

    const results = history.queryByTimeRangePaged(null, null, 3, 0);
    assert.equal(results.length, 3);
  });

  it('skips offset rows', () => {
    const t = Date.now();
    for (let i = 0; i < 4; i++) insert({ lastSeen: t - i * 1000, firstSeen: t - i * 1000 });

    const page0 = history.queryByTimeRangePaged(null, null, 2, 0);
    const page1 = history.queryByTimeRangePaged(null, null, 2, 2);
    assert.equal(page0.length, 2);
    assert.equal(page1.length, 2);
    assert.notEqual(page0[0].dst, page1[0].dst, 'pages should return different rows');
  });

  it('returns empty array when offset exceeds total', () => {
    insert({});
    const results = history.queryByTimeRangePaged(null, null, 10, 9999);
    assert.deepEqual(results, []);
  });

  it('returns empty array when limit is 0', () => {
    insert({});
    const results = history.queryByTimeRangePaged(null, null, 0, 0);
    assert.deepEqual(results, []);
  });

  it('respects time range bounds', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: t - 5000, firstSeen: t - 5000 });
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });

    const results = history.queryByTimeRangePaged(t - 3000, null, 10, 0);
    assert.equal(results.length, 1);
    assert.equal(results[0].dst, '10.0.0.2');
  });

  it('returns rows in descending lastSeen order', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: t - 2000, firstSeen: t - 2000 });
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });

    const results = history.queryByTimeRangePaged(null, null, 10, 0);
    assert.ok(results[0].lastSeen >= results[1].lastSeen, 'should be newest first');
  });
});

// ─── countByTimeRange ─────────────────────────────────────────────────────────

describe('countByTimeRange', () => {
  it('returns 0 for empty DB', () => {
    assert.equal(history.countByTimeRange(null, null), 0);
  });

  it('counts all rows when no time bounds', () => {
    insert({}); insert({}); insert({});
    assert.equal(history.countByTimeRange(null, null), 3);
  });

  it('counts only rows within time bounds', () => {
    const t = Date.now();
    insert({ lastSeen: t - 5000, firstSeen: t - 5000 });
    insert({ lastSeen: t - 1000, firstSeen: t - 1000 });
    insert({ lastSeen: t - 500,  firstSeen: t - 500 });

    assert.equal(history.countByTimeRange(t - 3000, null), 2);
  });

  it('matches queryByTimeRange result count', () => {
    const t = Date.now();
    for (let i = 0; i < 5; i++) insert({ lastSeen: t - i * 1000, firstSeen: t - i * 1000 });

    const all = history.queryByTimeRange(null, null);
    const cnt = history.countByTimeRange(null, null);
    assert.equal(cnt, all.length);
  });
});

// ─── summarizeByTimeRange ─────────────────────────────────────────────────────

describe('summarizeByTimeRange', () => {
  it('returns { byDst, byDevice } structure', () => {
    const result = history.summarizeByTimeRange(null, null);
    assert.ok(Array.isArray(result.byDst),    'byDst should be an array');
    assert.ok(Array.isArray(result.byDevice), 'byDevice should be an array');
  });

  it('returns empty arrays for empty DB', () => {
    const result = history.summarizeByTimeRange(null, null);
    assert.equal(result.byDst.length, 0);
    assert.equal(result.byDevice.length, 0);
  });

  it('groups multiple flows to same dst into one byDst entry with correct count', () => {
    const t = Date.now();
    // Two different (src, dst, dport, proto) rows with same dst
    insert({ src: '192.168.1.1', dst: '10.0.0.1', dport: 80,  lastSeen: t - 1000, firstSeen: t - 1000 });
    insert({ src: '192.168.1.1', dst: '10.0.0.1', dport: 443, lastSeen: t - 500,  firstSeen: t - 500 });
    insert({ src: '192.168.1.1', dst: '10.0.0.2', dport: 80,  lastSeen: t - 2000, firstSeen: t - 2000 });

    const result = history.summarizeByTimeRange(null, null);
    const dst1 = result.byDst.find(r => r.dst === '10.0.0.1');
    const dst2 = result.byDst.find(r => r.dst === '10.0.0.2');
    assert.ok(dst1, '10.0.0.1 should appear in byDst');
    assert.equal(dst1.count, 2, 'two flows to 10.0.0.1 should count as 2');
    assert.ok(dst2, '10.0.0.2 should appear in byDst');
    assert.equal(dst2.count, 1);
  });

  it('groups flows by src into byDevice', () => {
    const t = Date.now();
    insert({ src: '192.168.1.10', dst: '10.0.0.1', dport: 80,  lastSeen: t - 1000, firstSeen: t - 1000 });
    insert({ src: '192.168.1.10', dst: '10.0.0.2', dport: 443, lastSeen: t - 500,  firstSeen: t - 500 });
    insert({ src: '192.168.1.20', dst: '10.0.0.3', dport: 53,  lastSeen: t - 2000, firstSeen: t - 2000 });

    const result = history.summarizeByTimeRange(null, null);
    const dev10 = result.byDevice.find(r => r.src === '192.168.1.10');
    const dev20 = result.byDevice.find(r => r.src === '192.168.1.20');
    assert.ok(dev10, '192.168.1.10 should appear in byDevice');
    assert.equal(dev10.count, 2);
    assert.ok(dev20, '192.168.1.20 should appear in byDevice');
    assert.equal(dev20.count, 1);
  });

  it('respects time range in summary', () => {
    const t = Date.now();
    insert({ src: '192.168.1.1', dst: '10.0.0.1', dport: 80,  lastSeen: t - 5000, firstSeen: t - 5000 });
    insert({ src: '192.168.1.1', dst: '10.0.0.2', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });

    const result = history.summarizeByTimeRange(t - 3000, null);
    assert.equal(result.byDst.length, 1, 'only the recent entry should be in summary');
    assert.equal(result.byDst[0].dst, '10.0.0.2');
  });

  it('byDst includes firstSeen and lastSeen aggregates', () => {
    const t = Date.now();
    insert({ src: '192.168.1.1', dst: '10.0.0.1', dport: 80,  firstSeen: t - 3000, lastSeen: t - 2000 });
    insert({ src: '192.168.1.1', dst: '10.0.0.1', dport: 443, firstSeen: t - 1500, lastSeen: t - 500 });

    const result = history.summarizeByTimeRange(null, null);
    const entry = result.byDst.find(r => r.dst === '10.0.0.1');
    assert.ok(entry.firstSeen <= t - 2000, 'firstSeen should be the earliest');
    assert.ok(entry.lastSeen  >= t - 1000, 'lastSeen should be the latest');
  });

  it('returns full stats aggregates for target, app, location, and timeline', () => {
    const t = Date.now();
    insert({
      src: '192.168.1.10', dst: '10.0.0.1', dstHost: 's3.amazonaws.com',
      org: 'Amazon.com, Inc.', dport: 443, proto: 'TCP',
      country: 'US', city: 'Seattle', lat: 47.6, lon: -122.3,
      firstSeen: t - 10_000, lastSeen: t - 10_000,
    });
    insert({
      src: '192.168.1.20', dst: '10.0.0.2', dstHost: 'www.google.com',
      org: 'Google LLC', dport: 443, proto: 'TCP',
      country: 'US', city: 'Mountain View', lat: 37.4, lon: -122.1,
      firstSeen: t - 5_000, lastSeen: t - 5_000,
    });

    const result = history.summarizeByTimeRange(t - 20_000, t, { buckets: 4 });

    assert.equal(result.total, 2);
    assert.equal(result.buckets, 4);
    assert.ok(result.byTarget.some(r => r.key === 'Amazon.com, Inc.' && r.count === 1));
    assert.ok(result.byEdge.some(r => r.src === '192.168.1.10' && r.key === 'Amazon.com, Inc.' && r.count === 1));
    assert.ok(result.byLocation.some(r => r.org === 'Google LLC' && r.totalSessions === 1));
    assert.equal(result.mapCoverage.totalGroups, 2);
    assert.equal(result.mapCoverage.shownGroups, 2);
    assert.equal(result.mapCoverage.totalSessions, 2);
    assert.equal(result.mapCoverage.shownSessions, 2);
    assert.equal(result.mapCoverage.capped, false);
    assert.equal(result.appGroups.reduce((sum, r) => sum + r.count, 0), result.total);
    assert.ok(result.appGroups.some(r => r.app === 'AWS' && r.count === 1));
    assert.ok(result.appGroups.some(r => r.app === 'Google' && r.count === 1));
    assert.equal(result.timeline.reduce((sum, r) => sum + r.count, 0), 2);
  });

  it('reports map coverage when location groups are capped', () => {
    const t = Date.now();
    for (let i = 0; i < 501; i++) {
      insert({
        src: '192.168.1.10',
        dst: `10.0.${Math.floor(i / 255)}.${i % 255}`,
        org: `Location ${i}`,
        country: 'US',
        city: `City ${i}`,
        lat: 20 + i / 1000,
        lon: -120 + i / 1000,
        firstSeen: t - 1000,
        lastSeen: t - 1000,
      });
    }

    const result = history.summarizeByTimeRange(t - 2000, t);

    assert.equal(result.byLocation.length, 500);
    assert.equal(result.mapCoverage.limit, 500);
    assert.equal(result.mapCoverage.totalGroups, 501);
    assert.equal(result.mapCoverage.shownGroups, 500);
    assert.equal(result.mapCoverage.totalSessions, 501);
    assert.equal(result.mapCoverage.shownSessions, 500);
    assert.equal(result.mapCoverage.capped, true);
    assert.ok(result.mapCoverage.percent > 99);
    assert.ok(result.mapCoverage.percent < 100);
  });

  it('summary can be filtered to one source IP', () => {
    const t = Date.now();
    insert({ src: '192.168.1.10', dst: '10.0.0.1', lastSeen: t - 1000, firstSeen: t - 1000 });
    insert({ src: '192.168.1.20', dst: '10.0.0.2', lastSeen: t - 1000, firstSeen: t - 1000 });

    const result = history.summarizeByTimeRange(t - 2000, t, { src: '192.168.1.10' });

    assert.equal(result.total, 1);
    assert.equal(result.byDevice.length, 1);
    assert.equal(result.byDevice[0].src, '192.168.1.10');
  });
});

// ─── queryByTimeRangePaged: sort options ──────────────────────────────────────

describe('queryByTimeRangePaged: sort options', () => {
  it('sorts by lastSeen DESC by default', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: t - 2000, firstSeen: t - 2000 });
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });

    const results = history.queryByTimeRangePaged(null, null, 10, 0);
    assert.ok(results[0].lastSeen >= results[1].lastSeen, 'default should be newest first');
  });

  it('sorts by lastSeen ASC when sortDir=asc', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: t - 2000, firstSeen: t - 2000 });
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, { sort: 'lastSeen', sortDir: 'asc' });
    assert.ok(results[0].lastSeen <= results[1].lastSeen, 'asc should be oldest first');
  });

  it('sorts by dport', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });
    insert({ dst: '10.0.0.2', dport: 80,  lastSeen: t - 2000, firstSeen: t - 2000 });
    insert({ dst: '10.0.0.3', dport: 53,  lastSeen: t - 3000, firstSeen: t - 3000 });

    const asc  = history.queryByTimeRangePaged(null, null, 10, 0, { sort: 'dport', sortDir: 'asc'  });
    const desc = history.queryByTimeRangePaged(null, null, 10, 0, { sort: 'dport', sortDir: 'desc' });
    assert.ok(asc[0].dport  <= asc[1].dport,  'asc dport should be lowest first');
    assert.ok(desc[0].dport >= desc[1].dport, 'desc dport should be highest first');
  });

  it('falls back to lastSeen for unknown sort column', () => {
    const t = Date.now();
    insert({ dst: '10.0.0.1', dport: 80,  lastSeen: t - 2000, firstSeen: t - 2000 });
    insert({ dst: '10.0.0.2', dport: 443, lastSeen: t - 1000, firstSeen: t - 1000 });

    // 'app' is not a DB column; should fall back to lastSeen DESC
    const results = history.queryByTimeRangePaged(null, null, 10, 0, { sort: 'app', sortDir: 'desc' });
    assert.ok(results[0].lastSeen >= results[1].lastSeen, 'unknown col should fall back to lastSeen DESC');
  });
});

// ─── queryByTimeRangePaged / countByTimeRange: filter options ─────────────────

describe('queryByTimeRangePaged / countByTimeRange: filter options', () => {
  function insertWithFields(overrides) {
    const t = Date.now();
    return insert({ lastSeen: t, firstSeen: t, ...overrides });
  }

  it('filters by dst (contains)', () => {
    insertWithFields({ dst: '8.8.8.8',    dstHost: 'dns.google',   dport: 53 });
    insertWithFields({ dst: '1.1.1.1',    dstHost: 'one.one.one.one', dport: 53 });
    insertWithFields({ dst: '93.184.216.34', dstHost: 'example.com', dport: 80 });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, {
      filters: { dst: { mode: 'contains', value: 'google' } },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].dst, '8.8.8.8');
  });

  it('filters by dst (startsWith)', () => {
    insertWithFields({ dst: '8.8.8.8', dstHost: 'dns.google', dport: 53 });
    insertWithFields({ dst: '1.1.1.1', dstHost: 'dns.cloudflare', dport: 53 });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, {
      filters: { dst: { mode: 'startsWith', value: 'dns.g' } },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].dstHost, 'dns.google');
  });

  it('filters by src (contains, matches srcDnsName)', () => {
    insertWithFields({ src: '192.168.1.10', srcDnsName: 'myphone.local', dst: '10.0.0.1', dport: 443 });
    insertWithFields({ src: '192.168.1.20', srcDnsName: 'laptop.local',  dst: '10.0.0.2', dport: 443 });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, {
      filters: { src: { mode: 'contains', value: 'phone' } },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].src, '192.168.1.10');
  });

  it('filters by proto', () => {
    insertWithFields({ dst: '10.0.0.1', dport: 443, proto: 'TCP' });
    insertWithFields({ dst: '10.0.0.2', dport: 53,  proto: 'UDP' });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, {
      filters: { proto: { mode: 'contains', value: 'UDP' } },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].proto, 'UDP');
  });

  it('filters by country', () => {
    insertWithFields({ dst: '10.0.0.1', dport: 80, country: 'US' });
    insertWithFields({ dst: '10.0.0.2', dport: 80, country: 'JP' });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, {
      filters: { country: { mode: 'contains', value: 'JP' } },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].country, 'JP');
  });

  it('filters by org', () => {
    insertWithFields({ dst: '10.0.0.1', dport: 80, org: 'Amazon Web Services' });
    insertWithFields({ dst: '10.0.0.2', dport: 80, org: 'Google LLC' });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, {
      filters: { org: { mode: 'contains', value: 'Amazon' } },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].org, 'Amazon Web Services');
  });

  it('countByTimeRange respects filters', () => {
    insertWithFields({ dst: '10.0.0.1', dport: 443, proto: 'TCP' });
    insertWithFields({ dst: '10.0.0.2', dport: 53,  proto: 'UDP' });
    insertWithFields({ dst: '10.0.0.3', dport: 443, proto: 'TCP' });

    const count = history.countByTimeRange(null, null, {
      filters: { proto: { mode: 'contains', value: 'TCP' } },
    });
    assert.equal(count, 2);
  });

  it('combines time range and filter', () => {
    const t = Date.now();
    insertWithFields({ dst: '10.0.0.1', dport: 80, org: 'Amazon', lastSeen: t - 5000, firstSeen: t - 5000 });
    insertWithFields({ dst: '10.0.0.2', dport: 80, org: 'Amazon', lastSeen: t - 500,  firstSeen: t - 500 });
    insertWithFields({ dst: '10.0.0.3', dport: 80, org: 'Google', lastSeen: t - 500,  firstSeen: t - 500 });

    const results = history.queryByTimeRangePaged(t - 2000, null, 10, 0, {
      filters: { org: { mode: 'contains', value: 'Amazon' } },
    });
    assert.equal(results.length, 1, 'only the recent Amazon entry should match both constraints');
    assert.equal(results[0].dst, '10.0.0.2');
  });

  it('empty filters object returns all rows', () => {
    insertWithFields({ dst: '10.0.0.1', dport: 80 });
    insertWithFields({ dst: '10.0.0.2', dport: 443 });

    const results = history.queryByTimeRangePaged(null, null, 10, 0, { filters: {} });
    assert.equal(results.length, 2);
  });
});
