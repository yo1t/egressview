'use strict';

// The write-on-change check asks for one row -- the latest observation of this
// device from this source -- and a poll asks it once per device it saw.
//
// Measured on one Hub 2026-09-19, with 3,666,245 observations across 432
// devices: SQLite chose idx_obs_source and walked that source's observations
// newest-first looking for the device, at 148-183 ms a lookup. Forcing the
// deviceId index answered in 0-2 ms. The poll therefore spent ~3 s of
// synchronous CPU in there, and everything queued behind it -- a static file
// took 5.7 s in the same window.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const devices = require('../../src/devices');

let dir;
let dbPath;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-devices-'));
  dbPath = path.join(dir, 'devices.db');
  devices.initDb(dbPath);
});

after(() => {
  try { devices.closeDb?.(); } catch { /* not every build exposes it */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('端末の最終観測の引き方', () => {
  it('deviceIdとsourceの両方で引ける索引がある', () => {
    const db = new Database(dbPath, { readonly: true });
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='device_observations'"
    ).all().map(row => row.name);
    db.close();
    assert.ok(
      names.includes('idx_obs_device_source'),
      `索引が無い: ${names.join(', ')}`
    );
  });

  it('その索引が実際に選ばれる', () => {
    // The point is not that an index exists but that the planner uses it: the
    // deviceId-only index existed all along and was passed over.
    const db = new Database(dbPath, { readonly: true });
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT ip, mac, ipv6, hostname, mdnsName, netbiosName, asusName, vendor
      FROM   device_observations
      WHERE  deviceId = ? AND source = ?
      ORDER  BY observedAt DESC
      LIMIT  1
    `).all('device-1', 'nat').map(row => row.detail).join(' ');
    db.close();
    assert.match(plan, /idx_obs_device_source/, `選ばれた計画: ${plan}`);
    assert.doesNotMatch(plan, /SCAN device_observations/, '全表走査になっている');
  });

  it('並べ替えを索引が満たす（一時Bツリーを作らない）', () => {
    // Without the ordering in the index, "latest" would sort the whole match.
    const db = new Database(dbPath, { readonly: true });
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT ip FROM device_observations
      WHERE deviceId = ? AND source = ? ORDER BY observedAt DESC LIMIT 1
    `).all('device-1', 'nat').map(row => row.detail).join(' ');
    db.close();
    assert.doesNotMatch(plan, /TEMP B-TREE/i, `並べ替えが索引で解けていない: ${plan}`);
  });
});
