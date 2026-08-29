// Threat Intelligence: fetch external feeds and match against NAT sessions
'use strict';
const logger = require('./logger');

// Injected at startup; see src/offline-mode.js.
let _offline = null;
function setOfflinePolicy(policy) { _offline = policy; }

const axios = require('axios');

// IP set: exact match
const threatIps = new Map(); // ip → { source, tag, port? }

/**
 * What each feed is currently contributing, and when it last managed to (P3-54).
 *
 * The counts alone cannot answer "is anything missing". On 2026-08-29
 * abuse.ch's Feodo Tracker returned 503 -- an expired certificate at their
 * CDN -- and the startup line still read `Ready: 6995 IPs`, because the other
 * three feeds are large. Feodo's C2 list was absent and nothing said so.
 *
 * Retaining a failed source's previous entries is already handled below, and
 * is right. What it cannot survive is a restart: these maps live in memory
 * only, so a process that starts while a feed is down starts without it
 * entirely. That is P3-54's part B; this is part A -- being able to say which
 * feed is contributing what, and when it last succeeded.
 */
const feedState = new Map();

function recordFeed(name, { count = null, error = null } = {}) {
  const previous = feedState.get(name) || { lastSuccessAt: null, count: 0 };
  feedState.set(name, {
    lastAttemptAt: Date.now(),
    lastSuccessAt: error ? previous.lastSuccessAt : Date.now(),
    // On failure the previous entries are kept, so the previous count is still
    // what this feed is contributing. Zeroing it here would under-report.
    count: error ? previous.count : count,
    lastError: error,
  });
}

// CIDR ranges: Spamhaus DROP
const threatCidrs = []; // [{ network, mask, source, tag }]

// Domain set: URLhaus
const threatDomains = new Map(); // domain → { source, tag }

let lastFetch = 0;
let fetching = false;
const FETCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ─── Feed parsers ─────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseFeodoTracker(text) {
  // CSV: skip comments (#), fields: first_seen_utc,dst_ip,dst_port,last_online,c2_status
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 2) continue;
    const ip = parts[1]?.trim();
    if (!ip || !ip.match(/^\d+\.\d+\.\d+\.\d+$/)) continue;
    const port = parseInt(parts[2], 10) || null;
    entries.push({ ip, port, source: 'feodo', tag: 'Feodo C2 (Emotet/Dridex/TrickBot)' });
  }
  return entries;
}

function parseThreatFox(text) {
  // CSV: skip comments (#), fields: first_seen_utc,ioc_id,ioc_value,ioc_type,...,malware,tags
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('"first_seen')) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 7) continue;
    // ioc_value is quoted: "ip:port"
    const iocRaw = (parts[2] || '').trim();
    const [ip, portStr] = iocRaw.split(':');
    if (!ip || !ip.match(/^\d+\.\d+\.\d+\.\d+$/)) continue;
    const port = parseInt(portStr, 10) || null;
    const malware = (parts[6] || '').trim();
    entries.push({ ip, port, source: 'threatfox', tag: `ThreatFox: ${malware || 'malware IOC'}` });
  }
  return entries;
}

// Domains that host user-generated content — domain-level match has low confidence
// (malware can be hosted there, but the domain itself is legitimate)
const LOW_CONFIDENCE_DOMAINS = new Set([
  'github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com',
  'gitlab.com', 'bitbucket.org',
  'drive.google.com', 'docs.google.com', 'storage.googleapis.com',
  'dropbox.com', 'dl.dropboxusercontent.com',
  'onedrive.live.com', '1drv.ms',
  'cdn.discordapp.com', 'media.discordapp.net',
  'pastebin.com', 'paste.ee',
  'transfer.sh', 'anonfiles.com',
  'amazonaws.com', 's3.amazonaws.com',
  'cloudfront.net', 'azureedge.net', 'blob.core.windows.net',
  'archive.org',
]);

function parseUrlhaus(text) {
  // CSV: skip comments (#), fields: id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('"id"')) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 3) continue;
    const url = (parts[2] || '').trim();
    try {
      const u = new URL(url);
      const host = u.hostname;
      const parentDomain = host.split('.').slice(-2).join('.');
      const isLowConf = LOW_CONFIDENCE_DOMAINS.has(host) || LOW_CONFIDENCE_DOMAINS.has(parentDomain);
      const confidence = isLowConf ? 'low' : 'high';
      const tag = isLowConf
        ? `URLhaus: malware hosted on ${host} (正規サービス — 要パス確認)`
        : 'URLhaus: malware distribution';
      if (host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        entries.push({ type: 'ip', value: host, source: 'urlhaus', tag, url, confidence });
      } else {
        entries.push({ type: 'domain', value: host, source: 'urlhaus', tag, url, confidence });
      }
    } catch {}
  }
  return entries;
}

function parseSpamhausDrop(text) {
  // Lines: CIDR ; SBnnnn  (or comments starting with ;)
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    const parts = trimmed.split(';');
    const cidr = parts[0].trim();
    const m = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (!m) continue;
    const ip = m[1];
    const prefix = parseInt(m[2], 10);
    const ipNum = ipToNum(ip);
    const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
    entries.push({ network: ipNum & mask, mask, prefix, source: 'spamhaus', tag: 'Spamhaus DROP (hijacked network)' });
  }
  return entries;
}

function ipToNum(ip) {
  if (ip.includes(':')) return null; // IPv6 — CIDR feeds are IPv4-only
  const parts = ip.split('.');
  return ((parseInt(parts[0], 10) << 24) | (parseInt(parts[1], 10) << 16) | (parseInt(parts[2], 10) << 8) | parseInt(parts[3], 10)) >>> 0;
}

// ─── Fetch all feeds ──────────────────────────────────────────────────────────

/**
 * Apply Promise.allSettled-style results to the staging maps and atomically swap
 * into the live structures. Extracted so tests can inject synthetic results without
 * making real HTTP calls.
 *
 * results: [feodoResult, threatfoxResult, urlhausResult, spamhausResult]
 * Each element is { status: 'fulfilled', value: { data: string } }
 *                or { status: 'rejected', reason: Error }
 */
function _applyFeedResults(results) {
  const newIps     = new Map(threatIps);
  const newDomains = new Map(threatDomains);
  const newCidrs   = [...threatCidrs];

  // Feodo Tracker
  if (results[0].status === 'fulfilled') {
    const entries = parseFeodoTracker(results[0].value.data);
    for (const [ip, v] of newIps) { if (v.source === 'feodo') newIps.delete(ip); }
    for (const e of entries) { newIps.set(e.ip, { source: e.source, tag: e.tag, port: e.port }); }
    logger.info(`[threat-intel] Feodo: ${entries.length} IPs`);
    recordFeed('feodo', { count: entries.length });
  } else {
    logger.error('[threat-intel] Feodo fetch failed:', results[0].reason?.message);
    recordFeed('feodo', { error: results[0].reason?.message || 'unknown error' });
  }

  // ThreatFox
  if (results[1].status === 'fulfilled') {
    const entries = parseThreatFox(results[1].value.data);
    for (const [ip, v] of newIps) { if (v.source === 'threatfox') newIps.delete(ip); }
    for (const e of entries) { newIps.set(e.ip, { source: e.source, tag: e.tag, port: e.port }); }
    logger.info(`[threat-intel] ThreatFox: ${entries.length} IOCs`);
    recordFeed('threatfox', { count: entries.length });
  } else {
    logger.error('[threat-intel] ThreatFox fetch failed:', results[1].reason?.message);
    recordFeed('threatfox', { error: results[1].reason?.message || 'unknown error' });
  }

  // URLhaus — owns both IPs and domains with 'urlhaus' source
  if (results[2].status === 'fulfilled') {
    const entries = parseUrlhaus(results[2].value.data);
    for (const [ip,  v] of newIps)     { if (v.source === 'urlhaus') newIps.delete(ip); }
    for (const [dom, v] of newDomains) { if (v.source === 'urlhaus') newDomains.delete(dom); }
    for (const e of entries) {
      if (e.type === 'ip') { newIps.set(e.value,     { source: e.source, tag: e.tag, url: e.url, confidence: e.confidence }); }
      else                  { newDomains.set(e.value, { source: e.source, tag: e.tag, url: e.url, confidence: e.confidence }); }
    }
    logger.info(`[threat-intel] URLhaus: ${entries.length} entries (IPs + domains)`);
    recordFeed('urlhaus', { count: entries.length });
  } else {
    // Keep existing URLhaus data rather than wiping it on transient failure
    logger.error('[threat-intel] URLhaus fetch failed (keeping previous data):', results[2].reason?.message);
    recordFeed('urlhaus', { error: results[2].reason?.message || 'unknown error' });
  }

  // Spamhaus DROP — owns CIDRs
  if (results[3].status === 'fulfilled') {
    const entries = parseSpamhausDrop(results[3].value.data);
    newCidrs.length = 0;
    newCidrs.push(...entries);
    logger.info(`[threat-intel] Spamhaus DROP: ${entries.length} CIDRs`);
    recordFeed('spamhaus', { count: entries.length });
  } else {
    logger.error('[threat-intel] Spamhaus DROP fetch failed (keeping previous data):', results[3].reason?.message);
    recordFeed('spamhaus', { error: results[3].reason?.message || 'unknown error' });
  }

  // Atomic swap
  threatIps.clear();     for (const [k, v] of newIps)     threatIps.set(k, v);
  threatDomains.clear(); for (const [k, v] of newDomains) threatDomains.set(k, v);
  threatCidrs.length = 0; threatCidrs.push(...newCidrs);

  lastFetch = Date.now();
  // Totals, then what is missing from them.
  //
  // `Ready: 6995 IPs` read as healthy on 2026-08-29 while Feodo's C2 list was
  // absent, because the other feeds are large enough to hide one. A count is
  // not an inventory (P3-54).
  const unavailable = [...feedState].filter(([, state]) => state.lastError);
  logger.info(
    `[threat-intel] Ready: ${threatIps.size} IPs, ${threatDomains.size} domains, `
    + `${threatCidrs.length} CIDRs`
  );
  if (unavailable.length) {
    logger.error(
      `[threat-intel] ${unavailable.length} of ${feedState.size} feeds did not answer, so `
      + 'matching is running without them: '
      + unavailable.map(([name, state]) => (
        state.lastSuccessAt
          ? `${name} (last succeeded ${new Date(state.lastSuccessAt).toISOString()}, `
            + `${state.count} entries retained)`
          : `${name} (never succeeded since start, contributing nothing)`
      )).join(', ')
    );
  }
}

async function fetchThreatIntel() {
  if (_offline?.allows && !_offline.allows('threat-intel')) {
    // Decided before any feed URL is touched, so nothing leaves the host.
    logger.info('[threat-intel] Offline mode: feeds are disabled');
    return;
  }
  if (fetching) return;
  fetching = true;
  logger.info('[threat-intel] Fetching feeds...');

  try {
    const results = await Promise.allSettled([
      axios.get('https://feodotracker.abuse.ch/downloads/ipblocklist.csv', { timeout: 30000, responseType: 'text' }),
      axios.get('https://threatfox.abuse.ch/export/csv/ip-port/recent/', { timeout: 30000, responseType: 'text' }),
      axios.get('https://urlhaus.abuse.ch/downloads/csv_recent/', { timeout: 30000, responseType: 'text' }),
      axios.get('https://www.spamhaus.org/drop/drop.txt', { timeout: 30000, responseType: 'text' }),
    ]);
    _applyFeedResults(results);
  } catch (err) {
    logger.error('[threat-intel] Unexpected error during fetch/parse (existing data preserved):', err.message);
  } finally {
    fetching = false;
  }
}

// ─── Match a connection against threat intel ──────────────────────────────────

function matchThreatIntel(dstIp, dstHost) {
  // 1. Exact IP match
  const ipHit = threatIps.get(dstIp);
  if (ipHit) return { ...ipHit, matchType: 'ip', matchValue: dstIp };

  // 2. Domain match (if dstHost is resolved)
  if (dstHost && dstHost !== dstIp) {
    const domainHit = threatDomains.get(dstHost);
    if (domainHit) return { ...domainHit, matchType: 'domain', matchValue: dstHost };
    // Check subdomains: "evil.bad.com" should match "bad.com"
    const parts = dstHost.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      const hit = threatDomains.get(parent);
      if (hit) return { ...hit, matchType: 'domain', matchValue: parent };
    }
  }

  // 3. CIDR match (Spamhaus DROP — IPv4 only; IPv6 skipped)
  if (threatCidrs.length > 0) {
    const num = ipToNum(dstIp);
    for (const cidr of threatCidrs) {
      if (num !== null && (num & cidr.mask) === cidr.network) {
        return { source: cidr.source, tag: cidr.tag, matchType: 'cidr', matchValue: `${numToIp(cidr.network)}/${cidr.prefix}` };
      }
    }
  }

  return null;
}

function numToIp(num) {
  return `${(num >>> 24) & 0xFF}.${(num >>> 16) & 0xFF}.${(num >>> 8) & 0xFF}.${num & 0xFF}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function needsRefresh() {
  return Date.now() - lastFetch > FETCH_INTERVAL_MS;
}

// Every indicator, for agents to match against locally.
//
// Handed over whole, the same way the location cache is: an agent that asks
// "is this destination on a list?" by sending the destination has told a third
// party -- or its own Hub -- exactly what it was worried about. The set is
// about ten thousand entries, six times smaller than the location cache
// already being distributed, so there is no reason to be cleverer than this.
function listIndicators() {
  // Confidence is the fourth element, appended rather than keyed.
  //
  // Without it an Agent judging on its own -- away from home, or with delivery
  // switched off -- had no way to tell a C2 address from a file someone put on
  // Google Drive, and warned about both equally (P3-19). The Hub has drawn
  // that line since P2-71 and simply dropped it here.
  //
  // **The schema version does not change.** Agents accept version 1 only, so
  // raising it would make every deployed Agent reject the whole payload and
  // stop matching threats, silently. Positional rows are read by index, so an
  // older Agent ignores a fourth element it does not know about.
  const confidenceOf = (meta) => (meta.confidence === 'low' ? 'low' : 'high');
  return {
    ips: Array.from(threatIps, ([ip, meta]) => [
      ip, meta.source || null, meta.tag || null, confidenceOf(meta),
    ]),
    domains: Array.from(threatDomains, ([domain, meta]) => [
      domain, meta.source || null, meta.tag || null, confidenceOf(meta),
    ]),
    // Sent as text so the agent parses one thing, not the network/mask pair
    // this side happens to keep for speed.
    cidrs: threatCidrs.map((entry) => [
      `${numToIp(entry.network)}/${entry.prefix}`,
      entry.source || null,
      entry.tag || null,
      confidenceOf(entry),
    ]),
    lastFetch,
  };
}

function getStats() {
  return {
    ips: threatIps.size,
    domains: threatDomains.size,
    cidrs: threatCidrs.length,
    lastFetch,
    // Per feed, so "6,995 indicators" cannot stand in for "every feed
    // answered". A feed that never succeeded since this process started is
    // contributing nothing, and that is a different state from one whose
    // entries are simply old (P3-54).
    feeds: [...feedState].map(([name, state]) => ({
      name,
      entries: state.count,
      lastSuccessAt: state.lastSuccessAt,
      lastAttemptAt: state.lastAttemptAt,
      lastError: state.lastError,
      // True only when this process has never had this feed. The retained
      // entries of a feed that failed later are still being matched against.
      contributingNothing: !state.lastSuccessAt,
    })),
  };
}

module.exports = {
  setOfflinePolicy,
  fetchThreatIntel,
  matchThreatIntel,
  needsRefresh,
  getStats,
  listIndicators,
  // Exposed for testing
  parseCsvLine,
  parseFeodoTracker,
  parseThreatFox,
  parseUrlhaus,
  parseSpamhausDrop,
  ipToNum,
  _applyFeedResults,
  _isFetching: () => fetching,
  _resetForTest: () => { threatIps.clear(); threatDomains.clear(); threatCidrs.length = 0; fetching = false; lastFetch = 0; },
};
