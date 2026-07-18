// Unit tests for junction-backed observation writes and diagnostics (P2-30).
// history.js writes connections and connection_observations atomically.
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const history = require('../../src/history');

const ENTRY = {
  src: '192.168.1.100', dst: '8.8.8.8', dport: 443, proto: 'TCP',
  firstSeen: 1_000_000, lastSeen: 1_000_000,
};

// Reach into the same DB via a fresh temp file so we can inspect junction rows.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

let dbPath;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-obs-'));
  dbPath = path.join(dir, 'test.db');
  history._initForTest(dbPath, { sourceRouterMap: { yamaha: 'yamaha1', cisco: 'cisco1' } });
});

function readObs() {
  const d = new Database(dbPath, { readonly: true });
  const rows = d.prepare('SELECT * FROM connection_observations ORDER BY routerId').all();
  const routers = d.prepare('SELECT * FROM routers ORDER BY id').all();
  d.close();
  return { rows, routers };
}

describe('observation write: source → junction expansion', () => {
  it('a yamaha write produces one yamaha1 observation', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha' });
    const { rows, routers } = readObs();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].routerId, 'yamaha1');
    assert.equal(rows[0].firstObservedAt, ENTRY.firstSeen);
    assert.equal(rows[0].lastObservedAt, ENTRY.lastSeen);
    assert.ok(routers.find(r => r.id === 'yamaha1' && r.kind === 'yamaha' && r.deletedAt === null));
  });

  it('observing the same connection from both routers yields two rows', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha' });
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha+cisco', lastSeen: 1_000_060 });
    const { rows } = readObs();
    assert.deepEqual(rows.map(r => r.routerId), ['cisco1', 'yamaha1']);
  });

  it('inspect maps deterministically to the yamaha router', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'inspect' });
    const { rows } = readObs();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].routerId, 'yamaha1');
  });

  it('an unknown source becomes a legacy placeholder marked deleted', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'mystery' });
    const { rows, routers } = readObs();
    assert.equal(rows[0].routerId, 'legacy-mystery');
    const placeholder = routers.find(r => r.id === 'legacy-mystery');
    assert.equal(placeholder.kind, 'unknown');
    assert.ok(placeholder.deletedAt, 'placeholder must be tombstoned');
  });

  it('repeat observations extend lastObservedAt and keep firstObservedAt', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha' });
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha', firstSeen: 2_000_000, lastSeen: 2_000_000 });
    const { rows } = readObs();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].firstObservedAt, 1_000_000);
    assert.equal(rows[0].lastObservedAt, 2_000_000);
  });

  it('a deleted-config source maps to its legacy placeholder', () => {
    history._initForTest(dbPath + '.2', { sourceRouterMap: { yamaha: 'legacy-yamaha', cisco: 'cisco1' } });
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha' });
    const d = new Database(dbPath + '.2', { readonly: true });
    const rows = d.prepare('SELECT * FROM connection_observations').all();
    d.close();
    assert.equal(rows[0].routerId, 'legacy-yamaha');
  });
});

describe('prune keeps connections and junction in step', () => {
  it('compactHistoryLog deletes the junction rows of pruned connections', () => {
    history.setRetentionDays(1);
    const old = Date.now() - 10 * 24 * 3600_000;
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha+cisco', firstSeen: old, lastSeen: old });
    history.appendHistoryLog({ ...ENTRY, dst: '9.9.9.9', source: 'yamaha', firstSeen: Date.now(), lastSeen: Date.now() });
    history.compactHistoryLog();
    const { rows } = readObs();
    assert.equal(rows.length, 1, 'only the fresh connection observation remains');
    assert.equal(rows[0].dst, '9.9.9.9');
    history.setRetentionDays(730);
  });
});

describe('checkObservationConsistency', () => {
  it('reports zeros when the junction is structurally consistent', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha' });
    history.appendHistoryLog({ ...ENTRY, dst: '9.9.9.9', source: 'yamaha+cisco' });
    const c = history.checkObservationConsistency();
    assert.equal(c.missingObservations, 0);
    assert.equal(c.orphanObservations, 0);
    assert.equal(c.underMerged, 0);
    assert.ok(c.checkedAt > 0);
  });

  it('detects a missing observation', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha' });
    const d = new Database(dbPath);
    d.prepare('DELETE FROM connection_observations').run();
    d.close();
    const c = history.checkObservationConsistency();
    assert.equal(c.missingObservations, 1);
  });

  it('detects an orphan observation', () => {
    const d = new Database(dbPath);
    d.prepare(`INSERT INTO connection_observations VALUES ('10.0.0.1','1.1.1.1',53,'UDP','yamaha1',1,1)`).run();
    d.close();
    const c = history.checkObservationConsistency();
    assert.equal(c.orphanObservations, 1);
  });

  it('reports a missing observation after one router observation is removed', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha+cisco' });
    const d = new Database(dbPath);
    d.prepare(`DELETE FROM connection_observations WHERE routerId = 'cisco1'`).run();
    d.close();
    const c = history.checkObservationConsistency();
    assert.equal(c.underMerged, 0, 'v5 no longer infers cardinality from a source column');
    assert.equal(c.missingObservations, 0, 'the connection still has one observation');
  });
});

describe('junction-backed reads', () => {
  it('returns observedBy and derives compatibility source without a connections.source column', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha+cisco' });
    const d = new Database(dbPath);
    const columns = d.prepare('PRAGMA table_info(connections)').all().map(row => row.name);
    d.close();
    assert.ok(!columns.includes('source'));

    const [row] = history.queryByTimeRange(null, null);
    assert.deepEqual(row.observedBy, ['cisco1', 'yamaha1']);
    assert.equal(row.source, 'yamaha+cisco');
  });

  it('uses junction observations in paged results and device summaries', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha' });
    history.appendHistoryLog({ ...ENTRY, dst: '9.9.9.9', source: 'cisco' });

    const rows = history.queryByTimeRangePaged(null, null, 10, 0);
    assert.deepEqual(rows.find(row => row.dst === ENTRY.dst).observedBy, ['yamaha1']);
    assert.deepEqual(rows.find(row => row.dst === '9.9.9.9').observedBy, ['cisco1']);

    const [device] = history.summarizeByTimeRange(null, null).byDevice;
    assert.deepEqual(device.observedBy, ['cisco1', 'yamaha1']);
    assert.equal(device.sources, 'yamaha+cisco');
  });

  it('restores the in-memory WebSocket view from junction observations', () => {
    const now = Date.now();
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha+cisco', firstSeen: now, lastSeen: now });
    history.closeDb();
    history.loadConnectionHistory(dbPath, { sourceRouterMap: { yamaha: 'yamaha1', cisco: 'cisco1' } });

    const [row] = history.getConnectionHistory().values();
    assert.deepEqual(row.observedBy, ['cisco1', 'yamaha1']);
    assert.equal(row.source, 'yamaha+cisco');
  });

  it('preserves exact router ids when a junction-backed entry is snapshotted', () => {
    history._appendAndLoad({ ...ENTRY, source: 'cisco', observedBy: ['cisco-deadbeef'] });
    history.snapshotHistory();

    const { rows } = readObs();
    assert.deepEqual(rows.map(row => row.routerId), ['cisco-deadbeef']);
  });
});
