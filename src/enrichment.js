// DNS reverse lookup, RDAP, GeoIP batch enrichment
'use strict';
const logger = require('./logger');

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.egressview.db');

let db            = null;
let _dbPath       = DB_PATH;
let stmtUpsertRdap = null;
let stmtUpsertGeo  = null;

const dnsCache    = new Map(); // ip → {host, expires}
const DNS_TTL_MS  = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of dnsCache) { if (now > entry.expires) dnsCache.delete(ip); }
}, 10 * 60_000).unref();

const rdapCache     = new Map(); // ip → {country, org, expires}
const inFlightRdap  = new Map(); // ip → Promise  (in-flight dedupe)
let rdapGeneration  = 0;         // reopen() のたびにインクリメント: 旧 Promise の書き込みを無効化
const RDAP_TTL_MS   = 24 * 60 * 60 * 1000; // 24h
const RDAP_FAIL_TTL = 60 * 60 * 1000;       // 60min retry on failure

const geoCache    = new Map(); // ip → {lat, lon, city, countryCode, expires}
const GEO_TTL_MS       = 24 * 60 * 60 * 1000;
const GEO_FAIL_TTL     = 60 * 60 * 1000;
const GEO_PERMANENT_TTL = 100 * 365 * 24 * 60 * 60 * 1000; // ~100年: プライベートIP用

// プライベート / ループバック / 特殊 IP は geo 解決不能なので永続キャッシュ対象
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1([01]\d|2[0-7]))\.|0\.0\.0\.0$|::1$|[Ff][CcDd])/;
function isPrivateIp(ip) { return PRIVATE_IP_RE.test(ip); }

// ─── External API observability ───────────────────────────────────────────────
const apiStats = {
  rdap: { ok: 0, fail: 0, lastOkAt: null, lastFailAt: null, lastError: null },
  geo:  { ok: 0, fail: 0, lastOkAt: null, lastFailAt: null, lastError: null },
  ptr:  { ok: 0, fail: 0, lastOkAt: null, lastFailAt: null, lastError: null },
};

function recordApiOk(name)  { const s = apiStats[name]; s.ok++;   s.lastOkAt   = Date.now(); }
function recordApiFail(name, err) {
  const s = apiStats[name]; s.fail++; s.lastFailAt = Date.now(); s.lastError  = err?.message || String(err);
}
function getApiStats() { return apiStats; }

// ─── SQLite cache persistence ─────────────────────────────────────────────────

function initDb(dbPath) {
  _dbPath = dbPath || DB_PATH;
  db = new Database(_dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS rdap_cache (
      ip      TEXT PRIMARY KEY,
      country TEXT,
      org     TEXT,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS geo_cache (
      ip          TEXT PRIMARY KEY,
      lat         REAL,
      lon         REAL,
      city        TEXT,
      countryCode TEXT,
      expires     INTEGER NOT NULL
    );
  `);

  stmtUpsertRdap = db.prepare(`
    INSERT INTO rdap_cache (ip, country, org, expires)
    VALUES (@ip, @country, @org, @expires)
    ON CONFLICT(ip) DO UPDATE SET country=@country, org=@org, expires=@expires
  `);

  stmtUpsertGeo = db.prepare(`
    INSERT INTO geo_cache (ip, lat, lon, city, countryCode, expires)
    VALUES (@ip, @lat, @lon, @city, @countryCode, @expires)
    ON CONFLICT(ip) DO UPDATE SET lat=@lat, lon=@lon, city=@city, countryCode=@countryCode, expires=@expires
  `);

  // Load non-expired entries into memory Maps
  const now = Date.now();
  const rdapRows = db.prepare('SELECT * FROM rdap_cache WHERE expires > ?').all(now);
  for (const row of rdapRows) {
    rdapCache.set(row.ip, { country: row.country, org: row.org, expires: row.expires });
  }
  const geoRows = db.prepare('SELECT * FROM geo_cache WHERE expires > ?').all(now);
  for (const row of geoRows) {
    geoCache.set(row.ip, { lat: row.lat, lon: row.lon, city: row.city, countryCode: row.countryCode, expires: row.expires });
  }
  logger.info(`[enrichment] Cache loaded: ${rdapRows.length} RDAP, ${geoRows.length} geo entries`);

  // 既存のプライベート IP エントリ（失敗 null）を永続 TTL にアップグレード
  const privUpgradeNow = Date.now();
  const nullGeoRows = db.prepare('SELECT ip FROM geo_cache WHERE lat IS NULL').all();
  let upgraded = 0;
  for (const row of nullGeoRows) {
    if (isPrivateIp(row.ip)) {
      const entry = { lat: null, lon: null, city: null, countryCode: null, expires: privUpgradeNow + GEO_PERMANENT_TTL };
      geoCache.set(row.ip, entry);
      stmtUpsertGeo.run({ ip: row.ip, lat: null, lon: null, city: null, countryCode: null, expires: entry.expires });
      upgraded++;
    }
  }
  if (upgraded > 0) logger.info(`[enrichment] ${upgraded} private IP geo entries upgraded to permanent TTL`);
}

function reopen() {
  rdapGeneration++;          // 進行中の _doLookupRdap が書き込みをスキップするようにする
  inFlightRdap.clear();      // 古い Promise への参照を解放
  if (db) { try { db.close(); } catch {} db = null; }
  rdapCache.clear();
  geoCache.clear();
  initDb(_dbPath);
}

function _persistRdap(ip, entry) {
  if (!stmtUpsertRdap) return;
  try { stmtUpsertRdap.run({ ip, country: entry.country, org: entry.org, expires: entry.expires }); } catch {}
}

function _persistGeo(ip, entry) {
  if (!stmtUpsertGeo) return;
  try { stmtUpsertGeo.run({ ip, lat: entry.lat ?? null, lon: entry.lon ?? null, city: entry.city ?? null, countryCode: entry.countryCode ?? null, expires: entry.expires }); } catch {}
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const RDAP_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

function httpsGetJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return reject(new Error('invalid redirect URL')); }
    if (parsedUrl.protocol !== 'https:') return reject(new Error('redirect must use https'));
    const req = https.get(url, { headers: { Accept: 'application/rdap+json' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpsGetJson(res.headers.location, redirects + 1));
      }
      let body = '';
      let size = 0;
      res.on('data', d => {
        size += d.length;
        if (size > RDAP_MAX_BYTES) { req.destroy(); return reject(new Error('RDAP response too large')); }
        body += d;
      });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const GEO_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

// ip-api.com batch API (HTTP) — server-side only
function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: Number(u.port) || 80,
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    };
    const req = http.request(opts, res => {
      let buf = '';
      let size = 0;
      res.on('data', d => {
        size += d.length;
        if (size > GEO_MAX_BYTES) { req.destroy(); return reject(new Error('geo response too large')); }
        buf += d;
      });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('geo timeout')); });
    req.write(data); req.end();
  });
}

// ─── Geo lookup ───────────────────────────────────────────────────────────────

async function lookupGeoBatch(ips) {
  const now = Date.now();

  // プライベート/ループバック/特殊 IP は永続 TTL でキャッシュ（API 呼び出し不要）
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      const entry = { lat: null, lon: null, city: null, countryCode: null, expires: now + GEO_PERMANENT_TTL };
      geoCache.set(ip, entry);
      _persistGeo(ip, entry);
    }
  }

  const toFetch = ips.filter(ip => { const c = geoCache.get(ip); return !c || now >= c.expires; });
  if (!toFetch.length) return;
  for (let i = 0; i < toFetch.length; i += 100) {
    const chunk = toFetch.slice(i, i + 100);
    try {
      const results = await httpPostJson(
        'http://ip-api.com/batch?fields=status,lat,lon,country,city,countryCode,query',
        chunk.map(ip => ({ query: ip }))
      );
      let ok = 0;
      results.forEach(r => {
        if (r.status === 'success') {
          const entry = { lat: r.lat, lon: r.lon, city: r.city, countryCode: r.countryCode, expires: now + GEO_TTL_MS };
          geoCache.set(r.query, entry);
          _persistGeo(r.query, entry);
          ok++;
        } else {
          const entry = { lat: null, lon: null, expires: now + GEO_FAIL_TTL };
          geoCache.set(r.query, entry);
          _persistGeo(r.query, entry);
        }
      });
      logger.info(`[geo] ${ok}/${chunk.length} IPs geo-resolved`);
      recordApiOk('geo');
    } catch (err) {
      recordApiFail('geo', err);
      logger.error('[geo] batch error:', err.message);
      // Rate-limit 対策: エラー時はチャンク内の未キャッシュ IP を 30 分間リトライ抑制
      const rateLimitTtl = 30 * 60 * 1000;
      chunk.forEach(ip => {
        if (!geoCache.has(ip)) {
          const entry = { lat: null, lon: null, expires: now + rateLimitTtl };
          geoCache.set(ip, entry);
          _persistGeo(ip, entry);
        }
      });
    }
  }
}

// ─── RDAP lookup ──────────────────────────────────────────────────────────────

// NIC handle check: no spaces + only alphanumeric/hyphen/underscore → treat as identifier
function isNicHandle(s) {
  if (!s) return true;
  if (/\s/.test(s)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s);
}

// 実際の HTTP フェッチと結果キャッシュ（lookupRdap から呼ばれる）
async function _doLookupRdap(ip, generation = rdapGeneration) {
  const now = Date.now();
  // 二重チェック: 並行呼び出しが先にキャッシュへ書いていた場合の早期リターン
  const cached = rdapCache.get(ip);
  if (cached && now < cached.expires) return cached;
  try {
    const data = await httpsGetJson(`https://rdap.arin.net/registry/ip/${ip}`);
    const country = data.country || null;

    let org = null;
    if (data.entities) {
      const fns = data.entities
        .filter(e => e.roles?.includes('registrant') && e.vcardArray?.[1])
        .map(e => e.vcardArray[1].find(v => v[0] === 'fn')?.[3])
        .filter(Boolean);
      org = fns.find(s => !isNicHandle(s)) || fns[0] || null;
    }
    if (!org) org = isNicHandle(data.name) ? null : data.name;
    if (!org && data.name) org = data.name;

    const result = { country, org, expires: now + RDAP_TTL_MS };
    // reopen() が挟まった場合はキャッシュ/DB への書き込みをスキップ
    if (generation === rdapGeneration) {
      rdapCache.set(ip, result);
      _persistRdap(ip, result);
      logger.info(`[rdap] ${ip} → ${country} / ${org}`);
    }
    recordApiOk('rdap');
    return result;
  } catch (err) {
    recordApiFail('rdap', err);
    const result = { country: null, org: null, expires: now + RDAP_FAIL_TTL };
    // 失敗キャッシュも世代が合う場合のみ書き込む
    if (generation === rdapGeneration) rdapCache.set(ip, result);
    return result;
  }
}

// キャッシュチェック → in-flight dedupe → _doLookupRdap
// どの呼び出し元（Yamaha poll / INSPECT / 調査）からでも同一 IP の並行 fetch を1本に絞る
async function lookupRdap(ip) {
  const now = Date.now();
  const cached = rdapCache.get(ip);
  if (cached && now < cached.expires) return cached;  // キャッシュヒット: Map を触らず即返す

  if (inFlightRdap.has(ip)) return inFlightRdap.get(ip);  // 進行中のリクエストに相乗り

  const p = _doLookupRdap(ip, rdapGeneration).finally(() => {
    if (inFlightRdap.get(ip) === p) inFlightRdap.delete(ip); // 自分自身のときだけ削除
  });
  inFlightRdap.set(ip, p);
  return p;
}

// ─── Throttled RDAP batch ─────────────────────────────────────────────────────

/**
 * RDAP lookups with concurrency limit to avoid hammering rdap.arin.net.
 * Processes IPs in groups of `concurrency` (default 5), awaiting each group
 * before starting the next. Cache hits are free; only uncached IPs hit the API.
 */
async function lookupRdapBatch(ips, concurrency = 5) {
  for (let i = 0; i < ips.length; i += concurrency) {
    await Promise.allSettled(ips.slice(i, i + concurrency).map(ip => lookupRdap(ip)));
  }
}

// ─── PTR lookup ───────────────────────────────────────────────────────────────

const PTR_JUNK_RE = /ec2-[\d-]+\.compute(?:-1)?\.amazonaws\.com$|\.compute\.internal$|\.static\.\S+\.fttx\.|ip-\d+-\d+-\d+-\d+\.|ptr\d|\.in-addr\.arpa$/i;

function isPtrJunk(host) {
  if (!host) return true;
  if (PTR_JUNK_RE.test(host)) return true;
  if (/^\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\./.test(host)) return true;
  return false;
}

async function reverseDns(ip) {
  const now = Date.now();
  const cached = dnsCache.get(ip);
  // dnsmasq forward-DNS entries take priority — never overwrite with PTR
  if (cached && cached.source === 'dnsmasq') return cached.host;
  if (cached && now < cached.expires) return cached.host;
  try {
    const [host] = await dns.reverse(ip);
    dnsCache.set(ip, { host, expires: now + DNS_TTL_MS, source: 'ptr' });
    recordApiOk('ptr');
    return host;
  } catch (err) {
    recordApiFail('ptr', err);
    dnsCache.set(ip, { host: ip, expires: now + 60_000, source: 'ptr' });
    return ip;
  }
}

// ─── Test helper ──────────────────────────────────────────────────────────────

function _initForTest() {
  if (db) { try { db.close(); } catch {} db = null; }
  rdapCache.clear();
  geoCache.clear();
  dnsCache.clear();
  inFlightRdap.clear();
  rdapGeneration = 0;
  initDb(':memory:');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function getDnsCache() { return dnsCache; }
function getRdapCache() { return rdapCache; }
function getGeoCache() { return geoCache; }

module.exports = {
  initDb,
  reopen,
  reverseDns,
  isPtrJunk,
  lookupRdap,
  lookupRdapBatch,
  lookupGeoBatch,
  getDnsCache,
  getRdapCache,
  getGeoCache,
  getApiStats,
  _initForTest,
};
