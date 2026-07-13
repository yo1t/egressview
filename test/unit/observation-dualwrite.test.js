// Unit tests for the v4 dual-write path and consistency diagnostics (P2-30 PR 3a).
// history.js must write connection_observations in the same transaction as
// the legacy connections.source column, and both must stay in agreement.
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

describe('dual-write: source → junction expansion', () => {
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

describe('prune keeps source and junction in step', () => {
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
  it('reports zeros when source and junction agree', () => {
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

  it('detects an under-merged yamaha+cisco row', () => {
    history.appendHistoryLog({ ...ENTRY, source: 'yamaha+cisco' });
    const d = new Database(dbPath);
    d.prepare(`DELETE FROM connection_observations WHERE routerId = 'cisco1'`).run();
    d.close();
    const c = history.checkObservationConsistency();
    assert.equal(c.underMerged, 1);
    assert.equal(c.missingObservations, 1);
  });
});
