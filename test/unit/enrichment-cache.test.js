// Unit tests for enrichment.js SQLite cache persistence
'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const enrichment = require('../../src/enrichment');

// ─── tmp DB ヘルパー ──────────────────────────────────────────────────────────

let tmpDbPath = null;

function makeTmpDb() {
  tmpDbPath = path.join(os.tmpdir(), `egressview-test-${process.pid}-${Date.now()}.db`);
  return tmpDbPath;
}

function cleanupTmpDb() {
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(tmpDbPath + ext); } catch {}
  }
  tmpDbPath = null;
}

// ─── 各テスト前にリセット ────────────────────────────────────────────────────

beforeEach(() => enrichment._initForTest());

after(() => {
  enrichment._initForTest(); // 最後にクリーンアップ
});

// ─── RDAP キャッシュ永続化 ───────────────────────────────────────────────────

describe('enrichment: RDAP cache persistence', () => {
  it('initDb 後に rdapCache は空', () => {
    assert.equal(enrichment.getRdapCache().size, 0);
  });

  it('RDAP エントリを DB に書き込み → reopen() 後に復元される', () => {
    const dbPath = makeTmpDb();
    try {
      enrichment.initDb(dbPath);

      // 内部 DB に直接テストデータを INSERT
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const expires = Date.now() + 24 * 60 * 60 * 1000; // 24h 後
      db.prepare(`INSERT INTO rdap_cache (ip, country, org, expires)
                  VALUES (?, ?, ?, ?)`).run('1.2.3.4', 'US', 'Test Org', expires);
      db.close();

      // reopen() でメモリキャッシュをリフレッシュ
      enrichment.reopen();

      const cache = enrichment.getRdapCache();
      assert.equal(cache.size, 1, 'エントリが1件復元されること');
      const entry = cache.get('1.2.3.4');
      assert.ok(entry, '1.2.3.4 が復元されること');
      assert.equal(entry.country, 'US');
      assert.equal(entry.org, 'Test Org');
    } finally {
      enrichment._initForTest(); // in-memory に戻す
      cleanupTmpDb();
    }
  });

  it('期限切れの RDAP エントリは復元されない', () => {
    const dbPath = makeTmpDb();
    try {
      enrichment.initDb(dbPath);

      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const expiredAt = Date.now() - 1000; // 過去（期限切れ）
      db.prepare(`INSERT INTO rdap_cache (ip, country, org, expires)
                  VALUES (?, ?, ?, ?)`).run('9.9.9.9', 'JP', 'Old Org', expiredAt);
      db.close();

      enrichment.reopen();

      assert.equal(enrichment.getRdapCache().size, 0, '期限切れエントリは復元されないこと');
    } finally {
      enrichment._initForTest();
      cleanupTmpDb();
    }
  });
});

// ─── Geo キャッシュ永続化 ────────────────────────────────────────────────────

describe('enrichment: Geo cache persistence', () => {
  it('initDb 後に geoCache は空', () => {
    assert.equal(enrichment.getGeoCache().size, 0);
  });

  it('Geo エントリを DB に書き込み → reopen() 後に復元される', () => {
    const dbPath = makeTmpDb();
    try {
      enrichment.initDb(dbPath);

      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const expires = Date.now() + 24 * 60 * 60 * 1000;
      db.prepare(`INSERT INTO geo_cache (ip, lat, lon, city, countryCode, expires)
                  VALUES (?, ?, ?, ?, ?, ?)`).run('5.6.7.8', 35.68, 139.69, 'Tokyo', 'JP', expires);
      db.close();

      enrichment.reopen();

      const cache = enrichment.getGeoCache();
      assert.equal(cache.size, 1);
      const entry = cache.get('5.6.7.8');
      assert.ok(entry);
      assert.equal(entry.city, 'Tokyo');
      assert.equal(entry.countryCode, 'JP');
      assert.equal(entry.lat, 35.68);
    } finally {
      enrichment._initForTest();
      cleanupTmpDb();
    }
  });

  it('期限切れの Geo エントリは復元されない', () => {
    const dbPath = makeTmpDb();
    try {
      enrichment.initDb(dbPath);

      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      const expiredAt = Date.now() - 1000;
      db.prepare(`INSERT INTO geo_cache (ip, lat, lon, city, countryCode, expires)
                  VALUES (?, ?, ?, ?, ?, ?)`).run('1.1.1.1', null, null, null, null, expiredAt);
      db.close();

      enrichment.reopen();

      assert.equal(enrichment.getGeoCache().size, 0, '期限切れエントリは復元されないこと');
    } finally {
      enrichment._initForTest();
      cleanupTmpDb();
    }
  });
});

// ─── DNS キャッシュ ──────────────────────────────────────────────────────────

describe('enrichment: DNS cache', () => {
  it('initDb 後に dnsCache は空', () => {
    assert.equal(enrichment.getDnsCache().size, 0);
  });
});

// ─── API 統計 ────────────────────────────────────────────────────────────────

describe('enrichment: getApiStats', () => {
  it('初期値はすべてゼロ', () => {
    const stats = enrichment.getApiStats();
    assert.equal(stats.rdap.ok,   0);
    assert.equal(stats.rdap.fail, 0);
    assert.equal(stats.geo.ok,    0);
    assert.equal(stats.geo.fail,  0);
    assert.equal(stats.ptr.ok,    0);
    assert.equal(stats.ptr.fail,  0);
  });
});

// ─── inFlightRdap クリア ─────────────────────────────────────────────────────

describe('enrichment: _initForTest clears inFlightRdap', () => {
  it('_initForTest() 後に rdapCache・geoCache・dnsCache がすべて空', () => {
    enrichment._initForTest();
    assert.equal(enrichment.getRdapCache().size, 0);
    assert.equal(enrichment.getGeoCache().size, 0);
    assert.equal(enrichment.getDnsCache().size, 0);
  });
});
