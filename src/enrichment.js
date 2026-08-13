// DNS reverse lookup, RDAP, GeoIP batch enrichment
'use strict';
const logger = require('./logger');

// Injected at startup; see src/offline-mode.js. RDAP and GeoIP always need the
// public internet. DNS PTR may be served by an internal resolver, so it is
// allowed only when the operator has opted in.
let _offline = null;
function applyOfflinePolicy(policy) { _offline = policy; }

const http = require('http');
const https = require('https');
const dns = require('node:dns').promises;
const Database = require('better-sqlite3');
const path = require('path');
const { isPrivateIpLiteral } = require('./offline-mode');
const { isBlockedOutboundIpLiteral } = require('./ssrf-guard');

const DB_PATH = path.join(__dirname, '..', '.egressview.db');

let db            = null;
let ptrResolver   = dns;
let _dbPath       = DB_PATH;
let stmtUpsertRdap = null;
let stmtUpsertGeo  = null;

const dnsCache    = new Map(); // ip → {host, expires}
const DNS_TTL_MS  = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of dnsCache) { if (now > entry.expires) dnsCache.delete(ip); }
}, 10 * 60_000).unref();

const rdapCache     = new Map(); // ip → {country, org, expires}
const inFlightRdap  = new Map(); // ip → Promise  (in-flight dedupe)
let rdapGeneration  = 0;         // incremented on each reopen() to invalidate stale in-flight Promise writes
const RDAP_TTL_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days
const RDAP_FAIL_TTL = 60 * 60 * 1000;       // 60min retry on failure

const geoCache    = new Map(); // ip → {lat, lon, city, countryCode, expires}
const GEO_TTL_MS       = 30 * 24 * 60 * 60 * 1000; // 30 days
const GEO_FAIL_TTL     = 60 * 60 * 1000;
const GEO_PERMANENT_TTL = 100 * 365 * 24 * 60 * 60 * 1000; // ~100 years, for private IPs

// Private, loopback, link-local, multicast and other non-routable addresses
// must never be sent to the public GeoIP service. Keep this aligned with the
// outbound endpoint guards instead of maintaining another partial IP regex.
function isNonPublicIp(ip) {
  return isPrivateIpLiteral(ip) || isBlockedOutboundIpLiteral(ip);
}

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

  // Load ALL cached entries (including stale) to avoid re-fetching on startup
  const now = Date.now();
  const rdapRows = db.prepare('SELECT * FROM rdap_cache').all();
  const staleRdapIps = [];
  for (const row of rdapRows) {
    rdapCache.set(row.ip, { country: row.country, org: row.org, expires: row.expires });
    if (row.expires <= now) staleRdapIps.push(row.ip);
  }
  const geoRows = db.prepare('SELECT * FROM geo_cache').all();
  const staleGeoIps = [];
  for (const row of geoRows) {
    geoCache.set(row.ip, { lat: row.lat, lon: row.lon, city: row.city, countryCode: row.countryCode, expires: row.expires });
    if (row.expires <= now) staleGeoIps.push(row.ip);
  }
  const staleIps = [...new Set([...staleRdapIps, ...staleGeoIps])];
  logger.info(`[enrichment] Cache loaded: ${rdapRows.length} RDAP, ${geoRows.length} geo entries (${staleIps.length} stale, will background-refresh)`);

  // Upgrade existing private-IP entries (stored as failed/null) to a permanent TTL
  const privUpgradeNow = Date.now();
  const nullGeoRows = db.prepare('SELECT ip FROM geo_cache WHERE lat IS NULL').all();
  let upgraded = 0;
  for (const row of nullGeoRows) {
    if (isNonPublicIp(row.ip)) {
      const entry = { lat: null, lon: null, city: null, countryCode: null, expires: privUpgradeNow + GEO_PERMANENT_TTL };
      geoCache.set(row.ip, entry);
      stmtUpsertGeo.run({ ip: row.ip, lat: null, lon: null, city: null, countryCode: null, expires: entry.expires });
      upgraded++;
    }
  }
  if (upgraded > 0) logger.info(`[enrichment] ${upgraded} private IP geo entries upgraded to permanent TTL`);
  return { staleIps };
}

function reopen() {
  rdapGeneration++;          // makes any in-flight _doLookupRdap() skip its write
  inFlightRdap.clear();      // release references to stale Promises
  if (db) { try { db.close(); } catch {} db = null; }
  rdapCache.clear();
  geoCache.clear();
  return initDb(_dbPath);
}

function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
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
const ENRICHMENT_HTTP_TIMEOUT_MS = 8_000;

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
    req.setTimeout(ENRICHMENT_HTTP_TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
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
      res.on('end', () => {
        // ip-api.com returns 429 with an empty body, so check the status code
        // before JSON.parse. The X-Ttl header is seconds remaining until the
        // rate-limit window resets.
        if (res.statusCode === 429) {
          const e = new Error('geo rate limited (HTTP 429)');
          e.statusCode = 429;
          e.retryAfterSec = parseInt(res.headers['x-ttl'], 10) || 60;
          return reject(e);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`geo HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(buf)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(ENRICHMENT_HTTP_TIMEOUT_MS, () => { req.destroy(); reject(new Error('geo timeout')); });
    req.write(data); req.end();
  });
}

// ─── Geo lookup ───────────────────────────────────────────────────────────────

// ip-api.com's /batch endpoint allows 15 requests/minute on the free tier. The
// INSPECT session handler issues a single-IP "batch" call per connection, which
// exhausts the quota almost immediately if sent as-is.
// Mitigation: buffer IPs from every caller for GEO_FLUSH_MS and coalesce them
// into one request, and back off sending entirely until the X-Ttl window
// resets after a 429.
let GEO_FLUSH_MS = 2000;
const geoPendingIps = new Set();
let geoFlushPromise = null;
let geoBackoffUntil = 0;

function lookupGeoBatch(ips) {
  // ip-api.com is internet-only; refuse before a request object is built.
  if (_offline?.allows && !_offline.allows('geoip')) return Promise.resolve();
  const now = Date.now();

  // Private/loopback/special-use IPs are cached with a permanent TTL (no API call needed)
  for (const ip of ips) {
    if (isNonPublicIp(ip)) {
      const entry = { lat: null, lon: null, city: null, countryCode: null, expires: now + GEO_PERMANENT_TTL };
      geoCache.set(ip, entry);
      _persistGeo(ip, entry);
    }
  }

  const toFetch = ips.filter(ip => { const c = geoCache.get(ip); return !c || now >= c.expires; });
  if (!toFetch.length) return Promise.resolve();
  toFetch.forEach(ip => geoPendingIps.add(ip));

  // Calls arriving while a buffer is pending share the same flush cycle
  if (!geoFlushPromise) {
    geoFlushPromise = new Promise(resolve => {
      setTimeout(() => {
        const batch = [...geoPendingIps];
        geoPendingIps.clear();
        geoFlushPromise = null; // subsequent calls start the next cycle
        _fetchGeoBatch(batch).then(resolve, resolve);
      }, GEO_FLUSH_MS);
    });
  }
  return geoFlushPromise;
}

async function _fetchGeoBatch(ipsAll) {
  const now = Date.now();

  // Currently backed off from rate limiting: skip the API call and cache with a
  // short TTL so it can be retried again soon after the window resets
  if (now < geoBackoffUntil) {
    const remainMs = geoBackoffUntil - now;
    const entryTtl = remainMs + 120_000;
    ipsAll.forEach(ip => {
      if (!geoCache.has(ip)) geoCache.set(ip, { lat: null, lon: null, expires: now + entryTtl });
    });
    logger.debug(`[geo] ${ipsAll.length} lookups skipped (rate-limit backoff, ${Math.ceil(remainMs / 1000)}s remaining)`);
    return;
  }

  for (let i = 0; i < ipsAll.length; i += 100) {
    const chunk = ipsAll.slice(i, i + 100);
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
      if (err.statusCode === 429) {
        // Back off for X-Ttl (seconds until the window resets) plus a 5s margin
        const backoffSec = (err.retryAfterSec || 60) + 5;
        geoBackoffUntil = Date.now() + backoffSec * 1000;
        logger.warn(`[geo] rate limited by ip-api.com — backing off ${backoffSec}s`);
      } else {
        logger.error('[geo] batch error:', err.message);
      }
      // On error, suppress retries for any not-yet-cached IPs in the chunk for 30 minutes
      const rateLimitTtl = 30 * 60 * 1000;
      chunk.forEach(ip => {
        if (!geoCache.has(ip)) {
          const entry = { lat: null, lon: null, expires: now + rateLimitTtl };
          geoCache.set(ip, entry);
          _persistGeo(ip, entry);
        }
      });
      // If we just entered backoff, don't send the remaining chunks either
      if (Date.now() < geoBackoffUntil) {
        for (let j = i + 100; j < ipsAll.length; j += 100) {
          ipsAll.slice(j, j + 100).forEach(ip => {
            if (!geoCache.has(ip)) geoCache.set(ip, { lat: null, lon: null, expires: now + rateLimitTtl });
          });
        }
        break;
      }
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

// Actual HTTP fetch and result caching (called from lookupRdap)
async function _doLookupRdap(ip, generation = rdapGeneration) {
  const now = Date.now();
  // Double-check: bail out early if a concurrent call already wrote the cache
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
    // Skip the cache/DB write if reopen() happened in the meantime
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
    // Only write the failure cache if the generation still matches
    if (generation === rdapGeneration) rdapCache.set(ip, result);
    return result;
  }
}

// Cache check → in-flight dedupe → _doLookupRdap
// Collapses concurrent fetches for the same IP into one, regardless of which
// caller (Yamaha poll / INSPECT / investigation) triggered it
async function lookupRdap(ip) {
  if (_offline?.allows && !_offline.allows('rdap')) return null;
  const now = Date.now();
  const cached = rdapCache.get(ip);
  if (cached && now < cached.expires) return cached;  // cache hit: return immediately, no Map write

  if (inFlightRdap.has(ip)) return inFlightRdap.get(ip);  // piggyback on the in-flight request

  const p = _doLookupRdap(ip, rdapGeneration).finally(() => {
    if (inFlightRdap.get(ip) === p) inFlightRdap.delete(ip); // only delete if it's still our own entry
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
  if (_offline?.allows && !_offline.allows('dns-ptr')) return null;
  const now = Date.now();
  const cached = dnsCache.get(ip);
  // dnsmasq forward-DNS entries take priority — never overwrite with PTR
  if (cached && cached.source === 'dnsmasq') return cached.host;
  if (cached && now < cached.expires) return cached.host;
  try {
    const [host] = await ptrResolver.reverse(ip);
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
  geoPendingIps.clear();
  geoFlushPromise = null;
  geoBackoffUntil = 0;
  _offline = null;
  ptrResolver = dns;
  initDb(':memory:');
}

// Test helpers: shorten the flush wait and manipulate backoff state
function _setGeoFlushMsForTest(ms) { GEO_FLUSH_MS = ms; }
function _setGeoBackoffUntilForTest(ts) { geoBackoffUntil = ts; }
function _getGeoBackoffUntilForTest() { return geoBackoffUntil; }

// ─── Exports ──────────────────────────────────────────────────────────────────

function getDnsCache() { return dnsCache; }
function getRdapCache() { return rdapCache; }
function getGeoCache() { return geoCache; }

function configurePtrResolver(server, Resolver = dns.Resolver) {
  if (!server) {
    ptrResolver = dns;
    return;
  }
  const resolver = new Resolver();
  resolver.setServers([server]);
  ptrResolver = resolver;
}

module.exports = {
  setOfflinePolicy(policy) {
    applyOfflinePolicy(policy);
    configurePtrResolver(policy?.offline ? policy.endpointFor('dns-ptr') : null);
  },
  initDb,
  reopen,
  closeDb,
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
  _setGeoFlushMsForTest,
  _setGeoBackoffUntilForTest,
  _getGeoBackoffUntilForTest,
  _configurePtrResolverForTest: configurePtrResolver,
};
