// DNS reverse lookup, RDAP, GeoIP batch enrichment
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.widemap.db');

let db            = null;
let _dbPath       = DB_PATH;
let stmtUpsertRdap = null;
let stmtUpsertGeo  = null;

const dnsCache    = new Map(); // ip → {host, expires}
const DNS_TTL_MS  = 5 * 60 * 1000;

const rdapCache   = new Map(); // ip → {country, org, expires}
const RDAP_TTL_MS   = 24 * 60 * 60 * 1000; // 24h
const RDAP_FAIL_TTL =  5 * 60 * 1000;       // 5min retry on failure

const geoCache    = new Map(); // ip → {lat, lon, city, countryCode, expires}
const GEO_TTL_MS  = 24 * 60 * 60 * 1000;
const GEO_FAIL_TTL =  5 * 60 * 1000;

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
  console.log(`[enrichment] Cache loaded: ${rdapRows.length} RDAP, ${geoRows.length} geo entries`);
}

function reopen() {
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

function httpsGetJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { Accept: 'application/rdap+json' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpsGetJson(res.headers.location, redirects + 1));
      }
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

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
      res.on('data', d => { buf += d; });
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
      console.log(`[geo] ${ok}/${chunk.length} IPs geo-resolved`);
      recordApiOk('geo');
    } catch (err) {
      recordApiFail('geo', err);
      console.error('[geo] batch error:', err.message);
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

async function lookupRdap(ip) {
  const now = Date.now();
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
    rdapCache.set(ip, result);
    _persistRdap(ip, result);
    console.log(`[rdap] ${ip} → ${country} / ${org}`);
    recordApiOk('rdap');
    return result;
  } catch (err) {
    recordApiFail('rdap', err);
    const result = { country: null, org: null, expires: now + RDAP_FAIL_TTL };
    rdapCache.set(ip, result);
    // RDAP の一時エラーは短い TTL のままにする（長期キャッシュしない）
    return result;
  }
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
