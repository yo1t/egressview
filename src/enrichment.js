// DNS reverse lookup, RDAP, GeoIP batch enrichment
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns').promises;

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
          geoCache.set(r.query, { lat: r.lat, lon: r.lon, city: r.city, countryCode: r.countryCode, expires: now + GEO_TTL_MS });
          ok++;
        } else {
          geoCache.set(r.query, { lat: null, lon: null, expires: now + GEO_FAIL_TTL });
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
        if (!geoCache.has(ip)) geoCache.set(ip, { lat: null, lon: null, expires: now + rateLimitTtl });
      });
    }
  }
}

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
    console.log(`[rdap] ${ip} → ${country} / ${org}`);
    recordApiOk('rdap');
    return result;
  } catch (err) {
    recordApiFail('rdap', err);
    const result = { country: null, org: null, expires: now + RDAP_FAIL_TTL };
    rdapCache.set(ip, result);
    return result;
  }
}

// PTR reverse-lookup results that are not useful as display names.
// These are machine-generated hostnames that convey less info than the raw IP.
const PTR_JUNK_RE = /ec2-[\d-]+\.compute(?:-1)?\.amazonaws\.com$|\.compute\.internal$|\.static\.\S+\.fttx\.|ip-\d+-\d+-\d+-\d+\.|ptr\d|\.in-addr\.arpa$/i;

function isPtrJunk(host) {
  if (!host) return true;
  if (PTR_JUNK_RE.test(host)) return true;
  // Heuristic: hostname that starts with the IP octets reversed (e.g. "192-168-1-1.example.com")
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

function getDnsCache() { return dnsCache; }
function getRdapCache() { return rdapCache; }
function getGeoCache() { return geoCache; }

module.exports = {
  reverseDns,
  isPtrJunk,
  lookupRdap,
  lookupGeoBatch,
  getDnsCache,
  getRdapCache,
  getGeoCache,
  getApiStats,
};
