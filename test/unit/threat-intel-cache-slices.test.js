'use strict';

// The hourly feed refresh wrote about 33,000 cache rows in one transaction on
// the thread that answers requests, and the Hub stopped for 0.7-1.1 s every
// hour (P3-184, measured 2026-10-08..10). The cache is now written in slices
// with a turn of the event loop between them, and not at all when a feed has
// not changed.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function freshModule() {
  delete require.cache[require.resolve('../../src/threat-intel')];
  return require('../../src/threat-intel');
}

function temporaryDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-threat-slices-'));
  return path.join(dir, 'h.sqlite');
}

function rows(count, prefix = 'bad') {
  return Array.from({ length: count }, (_, i) => ({ kind: 'domain', value: `${prefix}${i}.example`, meta: { tag: 't' } }));
}

function cached(dbPath, source) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT value FROM threat_indicator_cache WHERE source = ? ORDER BY value').all(source).map(r => r.value);
  } finally { db.close(); }
}

describe('脅威情報キャッシュの小分け書き込み (P3-184)', () => {
  it('小分けでも全件を書き、間でイベントループに戻る', async () => {
    const dbPath = temporaryDb();
    const ti = freshModule();
    ti.initDb(dbPath);
    let turns = 0;
    const ticker = setInterval(() => { turns += 1; }, 0);
    await ti._persistFeeds([{ source: 'urlhaus', rows: rows(5000) }], { sliced: true });
    clearInterval(ticker);
    ti.closeDb();
    assert.equal(cached(dbPath, 'urlhaus').length, 5000);
    assert.ok(turns > 0, 'other work ran while the cache was being written');
  });

  it('新しい行を書いてから、そのフィードの古い行だけを消す', async () => {
    const dbPath = temporaryDb();
    const ti = freshModule();
    ti.initDb(dbPath);
    await ti._persistFeeds([{ source: 'urlhaus', rows: rows(3, 'old') }, { source: 'feodo', rows: [{ kind: 'ip', value: '198.51.100.9', meta: {} }] }], { sliced: true });
    await ti._persistFeeds([{ source: 'urlhaus', rows: rows(2, 'new') }], { sliced: true });
    ti.closeDb();
    assert.deepEqual(cached(dbPath, 'urlhaus'), ['new0.example', 'new1.example']);
    assert.deepEqual(cached(dbPath, 'feodo'), ['198.51.100.9'], "another feed's rows are untouched");
  });

  it('前回と同じフィードは書き直さない', async () => {
    const dbPath = temporaryDb();
    const ti = freshModule();
    ti.initDb(dbPath);
    const feed = rows(10);
    await ti._persistFeeds([{ source: 'urlhaus', rows: feed }], { sliced: true });
    const raw = new Database(dbPath);
    const before = raw.prepare('SELECT MAX(fetchedAt) AS t FROM threat_indicator_cache').get().t;
    raw.close();
    await ti._persistFeeds([{ source: 'urlhaus', rows: feed.map(r => ({ ...r })) }], { sliced: true });
    ti.closeDb();
    const after = new Database(dbPath, { readonly: true });
    assert.equal(after.prepare('SELECT MAX(fetchedAt) AS t FROM threat_indicator_cache').get().t, before);
    after.close();
  });

  it('定期取得は小分けの書き込みを使う', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'threat-intel.js'), 'utf8');
    const fetch = source.slice(source.indexOf('async function fetchThreatIntel()'));
    assert.match(fetch, /_applyFeedResults\(results, \{ deferCache: true \}\)/);
    assert.match(fetch, /await persistFeeds\(cacheJobs, \{ sliced: true \}\)/);
  });
});
