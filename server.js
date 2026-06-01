require('dotenv').config();
// Prefer IPv4 (prevents external HTTPS from stalling on IPv6, e.g. on EC2)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;
const { Client: SshClient } = require('ssh2');
const https = require('https');
// bonjour-service is a heavyweight optional dep. Wrapped in try/catch so the server still starts if install failed.
let Bonjour = null;
try { Bonjour = require('bonjour-service').default || require('bonjour-service').Bonjour; }
catch { console.warn('[bonjour] bonjour-service not installed (Phase2 mDNS skipped)'); }

const app = express();
const server = http.createServer(app);
// Socket.IO: allow same-origin only (block cross-origin WS connections)
const io = new Server(server, {
  cors: { origin: false },
  allowRequest: (req, cb) => {
    // Allow when Origin is absent (same-origin or non-browser) or matches Host
    const origin = req.headers.origin;
    const host   = req.headers.host;
    if (!origin) return cb(null, true);
    try {
      const o = new URL(origin);
      cb(null, o.host === host);
    } catch { cb(null, false); }
  },
});

// Sub-path for reverse proxy. e.g. SUBPATH=/widemap
const SUBPATH = (process.env.SUBPATH || '').replace(/\/$/, '');

const DEFAULT_ROUTER_IP = process.env.ROUTER_IP || '192.168.1.1';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000');
const PORT = parseInt(process.env.PORT || '3000');

// ── SSRF protection: allow only private IP ranges ─────────────────────
function isAllowedRouterIp(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1]), parseInt(m[2])];
  if (a > 255 || b > 255 || parseInt(m[3]) > 255 || parseInt(m[4]) > 255) return false;
  // Explicitly reject 169.254.0.0/16 (link-local, AWS metadata, etc.)
  if (a === 169 && b === 254) return false;
  // Reject 127.0.0.0/8 (loopback) to prevent attacks on this server
  if (a === 127) return false;
  // Allow only 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ── HTML escape (used for template replacement; values are trusted but escaped for safety) ──
function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Return index.html with __BASE__ substituted (registered before the static handler)
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html').send(html.replace(/__BASE__/g, htmlEscape(SUBPATH)));
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '64kb' })); // payload size limit

// ─── OUI vendor database ──────────────────────────────────────────────────────
const OUI_URL   = 'https://www.wireshark.org/download/automated/data/manuf';
const OUI_CACHE = path.join(__dirname, '.oui_cache.txt');
const OUI_TTL   = 7 * 24 * 60 * 60 * 1000; // 1 week

let ouiDb = new Map(); // "CC28AA" → "ASUSTeK COMPUTER INC."

function parseOuiManuf(text) {
  const db = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const prefix = parts[0].trim();
    const fullName = (parts[2] || parts[1]).trim();
    if (!prefix || !fullName) continue;
    // 24-bit OUI only ("XX:XX:XX" → 6 hex chars)
    const hex = prefix.replace(/[:\-\.]/g, '');
    if (hex.length !== 6) continue;
    db.set(hex.toUpperCase(), fullName);
  }
  return db;
}

async function loadOuiDb() {
  let text = null;
  try {
    const stat = fs.statSync(OUI_CACHE);
    if (Date.now() - stat.mtimeMs < OUI_TTL) {
      text = fs.readFileSync(OUI_CACHE, 'utf8');
      console.log(`[oui] Cache loaded (${ouiDb.size || '…'} entries)`);
    }
  } catch {}

  if (!text) {
    console.log('[oui] Downloading Wireshark OUI database…');
    try {
      const res = await axios.get(OUI_URL, { timeout: 30000, responseType: 'text' });
      text = res.data;
      fs.writeFileSync(OUI_CACHE, text);
    } catch (err) {
      console.error('[oui] Download failed:', err.message);
      return;
    }
  }

  ouiDb = parseOuiManuf(text);
  console.log(`[oui] ${ouiDb.size.toLocaleString()} OUI entries ready`);
}

function lookupVendor(mac) {
  const oui = mac.replace(/[:\-\.]/g, '').slice(0, 6).toUpperCase();
  return ouiDb.get(oui) || '';
}

// ─── Yamaha RTX SSH ───────────────────────────────────────────────────────────
// Initial values come from env vars or .widemap.json; never hard-code in source
let yamahaIp   = process.env.YAMAHA_IP   || '';
let yamahaUser = process.env.YAMAHA_USER || '';
let yamahaPass = process.env.YAMAHA_PASS || '';
const YAMAHA_NAT  = process.env.YAMAHA_NAT  || '100';

let yamahaShell   = null;
let yamahaConn    = null;
let yamahaReady   = false;
let shellBuf      = '';
let yamahaReconnectTimer = null;
let yamahaConnecting = false;
let shellResolve  = null;

const dnsCache    = new Map(); // ip → {host, expires}
const DNS_TTL_MS  = 5 * 60 * 1000;

const rdapCache   = new Map(); // ip → {country, org, expires}
const RDAP_TTL_MS   = 24 * 60 * 60 * 1000; // 24h
const RDAP_FAIL_TTL =  5 * 60 * 1000;       // 5min retry on failure

const geoCache    = new Map(); // ip → {lat, lon, city, countryCode, expires}
const GEO_TTL_MS  = 24 * 60 * 60 * 1000;
const GEO_FAIL_TTL =  5 * 60 * 1000;

let latestConnections = []; // {src, sport, dst, dport, proto, dstHost, country, org, lat, lon, city, srcMac}

// Yamaha ARP table cache (IP -> MAC)
const yamahaArpCache = new Map();
let yamahaArpLastRefresh = 0;
const YAMAHA_ARP_REFRESH_MS = 60 * 1000; // every 60 seconds

async function refreshYamahaArp() {
  if (!yamahaEnabled || !yamahaReady) return;
  try {
    const raw = await yamahaExec('show arp');
    const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/g;
    const newMap = new Map();
    let m;
    while ((m = re.exec(raw)) !== null) {
      newMap.set(m[1], m[2].toLowerCase());
    }
    yamahaArpCache.clear();
    for (const [k, v] of newMap) yamahaArpCache.set(k, v);
    yamahaArpLastRefresh = Date.now();
    console.log(`[yamaha-arp] cache refreshed: ${newMap.size} entries`);
  } catch (e) {
    console.error('[yamaha-arp] refresh failed:', e.message);
  }
}
// Connection history: key = `${src}|${dst}|${dport}|${proto}`, value = { ...session, firstSeen, lastSeen }
const connectionHistory = new Map();
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // delete after 7 days
const HISTORY_LOG = path.join(__dirname, '.widemap.connections.jsonl');
let historySnapshotTimer = null;

// Load history log on startup (JSON Lines, latest line wins)
function loadConnectionHistory() {
  try {
    const data = fs.readFileSync(HISTORY_LOG, 'utf8');
    const cutoff = Date.now() - HISTORY_TTL_MS;
    let total = 0, kept = 0;
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      total++;
      try {
        const e = JSON.parse(line);
        if (!e.src || !e.dst || (e.lastSeen || 0) < cutoff) continue;
        const key = `${e.src}|${e.dst}|${e.dport}|${e.proto}`;
        const existing = connectionHistory.get(key);
        // For duplicate keys: keep newest lastSeen and oldest firstSeen
        if (!existing) {
          connectionHistory.set(key, e);
        } else {
          existing.lastSeen  = Math.max(existing.lastSeen  || 0, e.lastSeen  || 0);
          existing.firstSeen = Math.min(existing.firstSeen || Infinity, e.firstSeen || Infinity);
          // Use the latest enrichment info (org/country/lat/lon/etc.)
          Object.assign(existing, {
            dstHost: e.dstHost || existing.dstHost,
            country: e.country || existing.country,
            org:     e.org     || existing.org,
            lat:     e.lat     ?? existing.lat,
            lon:     e.lon     ?? existing.lon,
            city:    e.city    || existing.city,
            ttl:     e.ttl     ?? existing.ttl,
          });
        }
        kept++;
      } catch {}
    }
    console.log(`[history] Loaded ${kept}/${total} entries → ${connectionHistory.size} unique sessions`);
  } catch {
    console.log('[history] No history log');
  }
}

// Append a single entry to the log (call on new discovery only)
function appendHistoryLog(entry) {
  fs.appendFile(HISTORY_LOG, JSON.stringify(entry) + '\n', err => {
    if (err) console.error('[history] append error:', err.message);
  });
}

// Periodic snapshot: write the latest lastSeen of existing entries to the log
// (so the latest state can be restored when loaded on startup)
function snapshotHistory() {
  if (connectionHistory.size === 0) return;
  const lines = [];
  for (const e of connectionHistory.values()) {
    lines.push(JSON.stringify(e));
  }
  // Append mode (log rotation/compaction is handled separately)
  fs.appendFile(HISTORY_LOG, lines.join('\n') + '\n', err => {
    if (err) console.error('[history] snapshot error:', err.message);
    else console.log(`[history] Snapshot ${lines.length} entries`);
  });
}

// Rewrite the entire old log (deduplicate lines + drop entries past TTL)
function compactHistoryLog() {
  if (connectionHistory.size === 0) return;
  try {
    const cutoff = Date.now() - HISTORY_TTL_MS;
    const lines = [];
    for (const e of connectionHistory.values()) {
      if ((e.lastSeen || 0) >= cutoff) lines.push(JSON.stringify(e));
    }
    fs.writeFileSync(HISTORY_LOG, lines.join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(HISTORY_LOG, 0o600); } catch {}
    console.log(`[history] Compacted to ${lines.length} entries`);
  } catch (e) {
    console.error('[history] compact error:', e.message);
  }
}

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
    } catch (err) {
      console.error('[geo] batch error:', err.message);
    }
  }
}

// NIC handle check: no spaces + only alphanumeric/hyphen/underscore → treat as identifier
// Real organisation names contain spaces ("Google LLC", "Yahoo Japan", etc.)
function isNicHandle(s) {
  if (!s) return true;
  if (/\s/.test(s)) return false;           // contains space → organisation name
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s); // no spaces, only alphanumeric/symbols → NIC handle
}

async function lookupRdap(ip) {
  const now = Date.now();
  const cached = rdapCache.get(ip);
  if (cached && now < cached.expires) return cached;
  try {
    const data = await httpsGetJson(`https://rdap.arin.net/registry/ip/${ip}`);
    const country = data.country || null;

    // Collect fn from all registrant entities; prefer names that are NOT NIC handles
    let org = null;
    if (data.entities) {
      const fns = data.entities
        .filter(e => e.roles?.includes('registrant') && e.vcardArray?.[1])
        .map(e => e.vcardArray[1].find(v => v[0] === 'fn')?.[3])
        .filter(Boolean);
      org = fns.find(s => !isNicHandle(s)) || fns[0] || null;
    }
    // Fallback: network block name (when it is not a NIC handle)
    if (!org) org = isNicHandle(data.name) ? null : data.name;
    if (!org && data.name) org = data.name;

    const result = { country, org, expires: now + RDAP_TTL_MS };
    rdapCache.set(ip, result);
    console.log(`[rdap] ${ip} → ${country} / ${org}`);
    return result;
  } catch (err) {
    const result = { country: null, org: null, expires: now + RDAP_FAIL_TTL };
    rdapCache.set(ip, result);
    return result;
  }
}

async function reverseDns(ip) {
  const now = Date.now();
  const cached = dnsCache.get(ip);
  if (cached && now < cached.expires) return cached.host;
  try {
    const [host] = await dns.reverse(ip);
    dnsCache.set(ip, { host, expires: now + DNS_TTL_MS });
    return host;
  } catch {
    dnsCache.set(ip, { host: ip, expires: now + 60_000 });
    return ip;
  }
}

function parseNatDetail(text) {
  const sessions = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(TCP|UDP|ICMP|GRE)\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)/);
    if (!m) continue;
    const [, proto, srcRaw, dstRaw, ttl] = m;
    if (dstRaw.includes('*')) continue;
    const splitAddr = s => { const p = s.lastIndexOf('.'); return [s.slice(0, p), parseInt(s.slice(p + 1))]; };
    const [src, sport] = splitAddr(srcRaw);
    const [dst, dport] = splitAddr(dstRaw);
    if (!src.startsWith('192.168.') && !src.startsWith('10.')) continue;
    sessions.push({ proto, src, sport, dst, dport, ttl: parseInt(ttl) });
  }
  return sessions;
}

function waitForPrompt(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (shellBuf.endsWith('> ')) { resolve(shellBuf); return; }
    shellResolve = resolve;
    setTimeout(() => { shellResolve = null; reject(new Error('SSH timeout')); }, timeoutMs);
  });
}

async function yamahaExec(cmd) {
  if (!yamahaReady || !yamahaShell) throw new Error('Yamaha not connected');
  shellBuf = '';
  yamahaShell.write(cmd + '\n');
  await waitForPrompt();
  return shellBuf;
}

function scheduleYamahaReconnect(ms) {
  if (yamahaReconnectTimer) { clearTimeout(yamahaReconnectTimer); }
  if (!yamahaEnabled) return;
  yamahaReconnectTimer = setTimeout(() => {
    yamahaReconnectTimer = null;
    connectYamaha();
  }, ms);
}

function connectYamaha() {
  if (!yamahaEnabled) return;
  // Skip connect if credentials are not configured yet (before first setup)
  if (!yamahaIp || !yamahaUser || !yamahaPass) {
    console.log('[yamaha] credentials not configured yet — skip connect');
    return;
  }
  if (yamahaConnecting) {
    console.log('[yamaha] Connect already in progress, skip');
    return;
  }
  // Fully close any existing connection
  if (yamahaReconnectTimer) { clearTimeout(yamahaReconnectTimer); yamahaReconnectTimer = null; }
  if (yamahaConn) { try { yamahaConn.removeAllListeners(); yamahaConn.end(); } catch {} yamahaConn = null; }
  yamahaReady = false;
  yamahaShell = null;
  yamahaConnecting = true;

  const conn = new SshClient();
  yamahaConn = conn;

  conn.on('ready', () => {
    conn.shell({ term: 'vt100', cols: 220, rows: 500 }, (err, stream) => {
      if (err) {
        console.error('[yamaha] shell error:', err.message);
        yamahaConnecting = false;
        io.emit('yamaha-status', { ready: false, message: 'シェル要求失敗: ' + err.message });
        scheduleYamahaReconnect(5000);
        return;
      }
      yamahaShell = stream;

      stream.on('data', chunk => {
        const text = chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        shellBuf += text;
        // Detect Yamaha pagination prompt (Japanese "tsuzuku" = "continued") and send space
        if (text.includes('---')) stream.write(' ');
        if (shellBuf.endsWith('> ') && shellResolve) {
          const r = shellResolve;
          shellResolve = null;
          r(shellBuf);
        }
      });

      stream.on('close', () => {
        yamahaReady = false;
        yamahaConnecting = false;
        console.log('[yamaha] Shell closed, reconnecting in 3s…');
        scheduleYamahaReconnect(3000);
      });

      // Initialise
      setTimeout(async () => {
        try {
          await waitForPrompt(8000);
          shellBuf = '';
          stream.write('console lines 0\n');
          await waitForPrompt(5000);
          yamahaReady = true;
          yamahaConnecting = false;
          console.log('[yamaha] Connected to RTX — ready');
          io.emit('yamaha-status', { ready: true, message: '接続済み' });
          // Right after connect, fetch ARP table (for MAC resolution) → start polling once done
          await refreshYamahaArp();
          pollYamahaConnections();
        } catch (e) {
          yamahaConnecting = false;
          console.error('[yamaha] init error:', e.message);
          io.emit('yamaha-status', { ready: false, message: '初期化失敗: ' + e.message });
          scheduleYamahaReconnect(5000);
        }
      }, 500);
    });
  });

  conn.on('error', err => {
    console.error('[yamaha] SSH error:', err.message);
    yamahaReady = false;
    yamahaConnecting = false;
    io.emit('yamaha-status', { ready: false, message: 'SSH接続失敗: ' + err.message });
    scheduleYamahaReconnect(5000);
  });

  // SSH host key verification (TOFU: Trust On First Use)
  // Save fingerprint on first connect; error out if it changes afterwards
  const hostVerifier = (hashedKey) => {
    const fp = Buffer.isBuffer(hashedKey)
      ? hashedKey.toString('hex')
      : crypto.createHash('sha256').update(hashedKey).digest('hex');
    if (!yamahaHostFp) {
      yamahaHostFp = fp;
      saveConfig();
      console.log('[yamaha] Host key recorded (TOFU):', fp.substring(0, 16) + '...');
      return true;
    }
    if (fp !== yamahaHostFp) {
      console.error('[yamaha] ⚠️ HOST KEY MISMATCH! Possible MITM attack.');
      console.error(`  Expected: ${yamahaHostFp.substring(0, 16)}...`);
      console.error(`  Got:      ${fp.substring(0, 16)}...`);
      console.error('  鍵を更新する場合は .widemap.json の yamaha.hostFp を削除してください');
      return false;
    }
    return true;
  };

  conn.connect({
    host: yamahaIp, port: 22,
    username: yamahaUser, password: yamahaPass,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    hostHash: 'sha256',
    hostVerifier,
    algorithms: { kex: ['curve25519-sha256@libssh.org','ecdh-sha2-nistp256',
                         'diffie-hellman-group14-sha256','diffie-hellman-group14-sha1'] },
  });
}

async function pollYamahaConnections() {
  if (!yamahaEnabled || !yamahaReady) return;
  try {
    const raw = await yamahaExec(`show nat descriptor address ${YAMAHA_NAT} detail`);
    const sessions = parseNatDetail(raw);
    console.log(`[yamaha] ${sessions.length} sessions parsed`);

    // For each destination: reverse DNS + RDAP + GeoIP (all entries; cached ones return immediately)
    const unique = [...new Set(sessions.map(s => s.dst))];
    await Promise.allSettled(unique.map(ip => reverseDns(ip)));
    await Promise.allSettled(unique.map(ip => lookupRdap(ip)));
    await lookupGeoBatch(unique);

    const now = Date.now();
    // Refresh ARP cache periodically (for src-IP → MAC resolution)
    // SSH session must be serialised → refresh synchronously before polling
    if (now - yamahaArpLastRefresh > YAMAHA_ARP_REFRESH_MS) {
      await refreshYamahaArp();
    }
    latestConnections = sessions.map(s => {
      const host = dnsCache.get(s.dst)?.host || s.dst;
      const rdap = rdapCache.get(s.dst);
      const geo  = geoCache.get(s.dst);
      const srcMac = resolveMacByIp(s.src);
      const srcMeta = getNodeMeta(s.src, srcMac);
      const enriched = {
        ...s,
        // Prefer ASUS DHCP table, fall back to Yamaha ARP
        srcMac,
        srcVendor:   srcMeta.vendor,
        srcDnsName:  srcMeta.dnsName,
        srcMdnsName: srcMeta.mdnsName,
        dstHost: host,
        country: rdap?.country || geo?.countryCode || null,
        org:     rdap?.org     || null,
        lat:     geo?.lat  ?? null,
        lon:     geo?.lon  ?? null,
        city:    geo?.city ?? null,
      };
      // Insert/update history
      const key = `${s.src}|${s.dst}|${s.dport}|${s.proto}`;
      const existing = connectionHistory.get(key);
      const isNew = !existing;
      const entry = {
        ...enriched,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen:  now,
      };
      connectionHistory.set(key, entry);
      // Append to log only on new discovery (reduce disk I/O)
      // lastSeen updates for existing entries are handled by the periodic snapshot
      if (isNew) appendHistoryLog(entry);
      return entry;
    });

    // Delete old history
    const cutoff = now - HISTORY_TTL_MS;
    for (const [k, v] of connectionHistory) {
      if (v.lastSeen < cutoff) connectionHistory.delete(k);
    }

    io.emit('connections-update', {
      connections: [...connectionHistory.values()],
      serverTime: now,
    });
    // Auto-investigation for each src IP observed by Yamaha (MAC resolved via combined ASUS+ARP)
    if (autoInvestigate) {
      const srcIps = [...new Set(sessions.map(s => s.src))];
      for (const ip of srcIps) enqueueAutoInvestigation(ip, resolveMacByIp(ip));
    }
  } catch (err) {
    console.error('[yamaha] poll error:', err.message);
    if (err.message.includes('timeout')) {
      // Timeout = unresponsive session → reset connection and reconnect (fast backoff)
      console.log('[yamaha] Timeout detected, resetting connection…');
      yamahaReady = false;
      if (yamahaConn) { try { yamahaConn.end(); } catch {} }
      scheduleYamahaReconnect(3000);
      return;
    }
  }
  setTimeout(pollYamahaConnections, 60000); // 60s: lighter load; ASUS (2s) handles real-time traffic
}

// ─── Auth state ───────────────────────────────────────────────────────────────
let authToken = null;
let tokenExpiry = 0;
let routerIp = DEFAULT_ROUTER_IP;
let pollTimer = null;
let asusEnabled = false;
let yamahaEnabled = true;
let lastAsusUser = '';
let lastAsusPass = '';
let homeCountry  = 'JP'; // Source country (default: Japan)
let uiLanguage   = 'ja'; // UI language ('ja' | 'en')
let autoInvestigate = false; // Auto-investigate unknown nodes
let adminToken   = '';   // App admin token (for API authentication)
let yamahaHostFp = '';   // Yamaha SSH host key fingerprint (TOFU)

// ─── Config file ──────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, '.widemap.json');

function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (data.yamaha) {
      if (data.yamaha.ip)   yamahaIp   = data.yamaha.ip;
      if (data.yamaha.user) yamahaUser = data.yamaha.user;
      if (data.yamaha.pass) yamahaPass = data.yamaha.pass;
      if (data.yamaha.enabled === false) yamahaEnabled = false;
      if (data.yamaha.hostFp) yamahaHostFp = data.yamaha.hostFp;
    }
    if (data.asus) {
      if (data.asus.ip)   routerIp     = data.asus.ip;
      if (data.asus.user) lastAsusUser = data.asus.user;
      if (data.asus.pass) lastAsusPass = data.asus.pass;
    }
    if (data.general?.homeCountry) homeCountry = data.general.homeCountry;
    if (data.general?.language && ['ja','en'].includes(data.general.language)) uiLanguage = data.general.language;
    if (typeof data.general?.autoInvestigate === 'boolean') autoInvestigate = data.general.autoInvestigate;
    if (data.adminToken) adminToken = data.adminToken;
    console.log('[config] Loaded:', CONFIG_FILE);
    return data;
  } catch {
    console.log('[config] No saved config, using defaults');
    return {};
  }
}

function saveConfig() {
  const data = {
    yamaha:  { ip: yamahaIp, user: yamahaUser, pass: yamahaPass, enabled: yamahaEnabled, hostFp: yamahaHostFp },
    asus:    { ip: routerIp, user: lastAsusUser, pass: lastAsusPass },
    general: { homeCountry, language: uiLanguage, autoInvestigate },
    adminToken,
  };
  try {
    // 0600 = owner read/write only (password protection)
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    // Also set permissions if the file already existed
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    console.log('[config] Saved:', CONFIG_FILE);
  } catch (e) {
    console.error('[config] Save failed:', e.message);
  }
}

// Admin token: generated automatically on first startup
function ensureAdminToken() {
  if (!adminToken) {
    adminToken = crypto.randomBytes(24).toString('hex');
    saveConfig();
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  Widemap admin token (initial):');
    console.log('  ' + adminToken);
    console.log('  → ブラウザ初回アクセス時にこのトークンを入力してください');
    console.log('══════════════════════════════════════════════════════════════\n');
  }
}

// API auth middleware (uses crypto.timingSafeEqual for timing-attack resistance)
function requireAdmin(req, res, next) {
  const provided = req.get('X-Admin-Token') || '';
  if (!adminToken) return res.status(503).json({ error: '管理トークン未初期化' });
  const a = Buffer.from(provided);
  const b = Buffer.from(adminToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '管理トークン不正' });
  }
  next();
}

// Admin token verification endpoint
app.post('/api/admin/verify', express.json(), (req, res) => {
  const provided = (req.body && req.body.token) || '';
  if (!adminToken) return res.status(503).json({ ok: false, error: '未初期化' });
  const a = Buffer.from(provided);
  const b = Buffer.from(adminToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return res.json({ ok: true });
  }
  // Small delay to mitigate brute-force
  setTimeout(() => res.status(401).json({ ok: false, error: 'トークン不正' }), 500);
});

// ─── Router data state ────────────────────────────────────────────────────────
let prevNetdev = {};
let prevPollTime = Date.now();
let latestAsusClients = []; // Last clients fetched from ASUS (for ip→mac resolution)

// ─── Node metadata cache (OUI / DNS / mDNS) ─────────────────────────────
const nodeMetaCache = new Map(); // ip -> { vendor, dnsName, mdnsName, lastFetched }
const NODE_META_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getOuiVendor(mac) {
  if (!mac || !ouiDb) return null;
  const prefix = mac.replace(/:/g, '').substring(0, 6).toUpperCase();
  return ouiDb.get(prefix) || null;
}

// Return existing cache while refreshing in background if stale
function getNodeMeta(ip, mac) {
  let meta = nodeMetaCache.get(ip);
  const now = Date.now();
  // Set OUI vendor immediately (in case mac becomes known later)
  const immediateVendor = getOuiVendor(mac);
  if (!meta) {
    meta = { vendor: immediateVendor, dnsName: null, mdnsName: null, lastFetched: 0 };
    nodeMetaCache.set(ip, meta);
    refreshNodeMeta(ip, mac); // async
  } else if (immediateVendor && !meta.vendor) {
    meta.vendor = immediateVendor;
  } else if (now - meta.lastFetched > NODE_META_TTL_MS) {
    refreshNodeMeta(ip, mac); // refresh async (returns existing value)
  }
  return meta;
}

async function refreshNodeMeta(ip, mac) {
  if (!isAllowedRouterIp(ip)) return;
  const meta = nodeMetaCache.get(ip) || { vendor: null, dnsName: null, mdnsName: null, lastFetched: 0 };
  if (mac) meta.vendor = getOuiVendor(mac) || meta.vendor;
  // Reverse DNS (1.5s timeout)
  try {
    const arr = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 1500))
    ]);
    meta.dnsName = (arr && arr[0]) || null;
  } catch { /* keep previous */ }
  // mDNS hostname (Bonjour, 2s)
  try {
    if (Bonjour) {
      const services = await probeBonjourForIp(ip, 2000);
      const named = services.find(s => s.host);
      if (named) meta.mdnsName = named.host;
    }
  } catch { /* keep previous */ }
  meta.lastFetched = Date.now();
  nodeMetaCache.set(ip, meta);
}

// Resolve MAC from IP: ASUS clientlist (DHCP-derived, high trust) → Yamaha ARP
function resolveMacByIp(ip) {
  if (!ip) return null;
  const asusMac = latestAsusClients.find(c => c.ip === ip)?.mac;
  if (asusMac) return asusMac;
  return yamahaArpCache.get(ip) || null;
}

// ─── SHA256 login with the router ─────────────────────────────────────────────
async function loginToRouter(ip, username, password) {
  const base = `http://${ip}`;

  // 1. Get nonce
  const id = crypto.randomBytes(5).toString('hex');
  const nonceRes = await axios.post(`${base}/get_Nonce.cgi`, JSON.stringify({ id }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  const nonce = nonceRes.data?.nonce;
  if (!nonce) throw new Error('ノンス取得失敗 — ルーターIPを確認してください');

  // 2. Compute SHA256 challenge-response
  const cnonce = crypto.randomBytes(16).toString('hex');
  const loginAuth = crypto
    .createHash('sha256')
    .update(`${username}:${nonce}:${password}:${cnonce}`)
    .digest('hex');

  // 3. POST to login_v2.cgi
  const params = new URLSearchParams({
    login_authorization: loginAuth,
    id,
    cnonce,
    login_captcha: '',
    action_mode: '',
    action_script: '',
    action_wait: '5',
    current_page: 'Main_Login.asp',
    next_page: '',
  });

  const res = await axios.post(`${base}/login_v2.cgi`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 8000,
    maxRedirects: 0,
    validateStatus: s => true,
  });

  // Extract token from Set-Cookie
  const cookies = res.headers['set-cookie'] || [];
  for (const c of cookies) {
    const m = c.match(/asus_token=([^;]+)/);
    if (m && m[1] !== 'deleted') return m[1];
  }

  // Fallback: check body
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (body.includes('index.asp')) return null; // success but no cookie (rare)
  throw new Error('ユーザー名またはパスワードが違います');
}

// ─── REST API ─────────────────────────────────────────────────────────────────
// Proxy nonce request so browser can call it without CORS issues
app.post('/api/nonce', requireAdmin, async (req, res) => {
  const ip = req.body.routerIp || DEFAULT_ROUTER_IP;
  if (!isAllowedRouterIp(ip)) {
    return res.status(400).json({ error: 'IPアドレスはプライベート範囲(10/8, 172.16/12, 192.168/16)のみ許可されます' });
  }
  try {
    const id = req.body.id || crypto.randomBytes(5).toString('hex');
    const r = await axios.post(`http://${ip}/get_Nonce.cgi`, JSON.stringify({ id }), {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    res.json({ nonce: r.data?.nonce || '', id });
  } catch (err) {
    res.status(502).json({ error: 'リクエスト失敗' });
  }
});

// Login: browser sends credentials → we do SHA256 auth → store token
app.post('/api/login', requireAdmin, async (req, res) => {
  // doAsus/doYamaha: true=connect, false=disable, undefined=leave as-is
  const { username, password, routerIp: ip,
          yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass } = req.body;
  const doAsus   = req.body.doAsus;
  const doYamaha = req.body.doYamaha;

  if (doAsus === undefined && doYamaha === undefined) {
    return res.status(400).json({ error: '設定対象を指定してください' });
  }

  // ── Input validation ──────────────────────────────
  if (ip !== undefined && ip !== '' && !isAllowedRouterIp(ip)) {
    return res.status(400).json({ error: 'ASUSのIPがプライベート範囲外です' });
  }
  if (yIp !== undefined && yIp !== '' && !isAllowedRouterIp(yIp)) {
    return res.status(400).json({ error: 'YamahaのIPがプライベート範囲外です' });
  }
  if (typeof username === 'string' && username.length > 64) {
    return res.status(400).json({ error: 'ユーザー名が長すぎます' });
  }
  if (typeof password === 'string' && password.length > 256) {
    return res.status(400).json({ error: 'パスワードが長すぎます' });
  }

  // ── ASUS connection ───────────────────────────────
  if (doAsus === true) {
    // Use saved password when omitted
    const effectivePass = password || lastAsusPass;
    if (!username || !effectivePass) {
      return res.status(400).json({ error: 'ASUSルーターのユーザー名とパスワードを入力してください' });
    }
    try {
      const targetIp = ip || DEFAULT_ROUTER_IP;
      const token = await loginToRouter(targetIp, username, effectivePass);
      authToken = token;
      tokenExpiry = Date.now() + 25 * 60 * 1000;
      routerIp = targetIp;
      asusEnabled = true;
      lastAsusUser = username;
      lastAsusPass = effectivePass;
      prevNetdev = {};
      prevPollTime = Date.now();
      startPolling();
      saveConfig();
      console.log(`[auth] ASUS logged in as ${username} @ ${targetIp}`);
    } catch (err) {
      console.error('[auth] ASUS login failed:', err.message);
      // Do not leak internal details outside
      return res.status(401).json({ error: 'ASUS認証失敗（IP・ユーザー名・パスワードを確認してください）' });
    }
  } else if (doAsus === false) {
    // Explicitly disable ASUS
    authToken = null; asusEnabled = false; stopPolling();
    console.log('[auth] ASUS disabled');
  }

  // ── Yamaha connection config update ──────────────
  if (doYamaha === true) {
    yamahaEnabled = true;
    if (yIp)   yamahaIp   = yIp;
    if (yUser) yamahaUser = yUser;
    if (yPass) yamahaPass = yPass;
    // Tear down existing connection/timers before reconnecting
    yamahaReady = false;
    yamahaConnecting = false;
    if (yamahaConn) { try { yamahaConn.removeAllListeners(); yamahaConn.end(); } catch {} yamahaConn = null; }
    scheduleYamahaReconnect(500);
    saveConfig();
    console.log(`[auth] Yamaha config updated: ${yamahaIp}`);
  } else if (doYamaha === false) {
    // Explicitly disable Yamaha
    yamahaEnabled = false;
    yamahaReady = false;
    yamahaConnecting = false;
    if (yamahaReconnectTimer) { clearTimeout(yamahaReconnectTimer); yamahaReconnectTimer = null; }
    if (yamahaConn) { try { yamahaConn.removeAllListeners(); yamahaConn.end(); } catch {} yamahaConn = null; }
    latestConnections = [];
    saveConfig();
    console.log('[auth] Yamaha disabled');
  }

  res.json({ success: true, routerIp: doAsus ? routerIp : undefined });
});

const ALLOWED_COUNTRIES = new Set([
  'JP','US','CA','GB','DE','FR','IT','ES','NL','SE','CH','NO',
  'AU','NZ','CN','KR','TW','HK','SG','IN','BR','RU',
]);
app.post('/api/config/general', requireAdmin, (req, res) => {
  const { homeCountry: hc, language: lang, autoInvestigate: ai } = req.body;
  if (hc) {
    if (!ALLOWED_COUNTRIES.has(hc)) {
      return res.status(400).json({ error: '無効な国コードです' });
    }
    homeCountry = hc;
  }
  if (lang) {
    if (!['ja','en'].includes(lang)) {
      return res.status(400).json({ error: 'invalid language' });
    }
    uiLanguage = lang;
  }
  if (typeof ai === 'boolean') {
    autoInvestigate = ai;
    if (ai) console.log('[auto-investigate] enabled');
    else    console.log('[auto-investigate] disabled');
  }
  saveConfig();
  res.json({ success: true, homeCountry, language: uiLanguage, autoInvestigate });
});

app.get('/api/status', requireAdmin, (req, res) => {
  res.json({
    authenticated: !!authToken && Date.now() < tokenExpiry,
    routerIp,
  });
});

// ─── Router data polling ──────────────────────────────────────────────────────
async function apiGet(hook) {
  const base = `http://${routerIp}`;
  const res = await axios.get(`${base}/appGet.cgi`, {
    params: { hook },
    headers: {
      Cookie: `asus_token=${authToken}`,
      Referer: `http://${routerIp}/index.asp`,
    },
    timeout: 8000,
  });
  const data = typeof res.data === 'string' ? (() => {
    try { return JSON.parse(res.data); } catch { return res.data; }
  })() : res.data;

  if (typeof data === 'string' && data.includes('Main_Login')) {
    throw new Error('TOKEN_EXPIRED');
  }
  return data;
}

function parseClientList(raw) {
  const src = raw?.get_clientlist || raw;
  if (!src || typeof src !== 'object') return [];
  return Object.entries(src)
    .filter(([mac, info]) => mac !== 'maclist' && mac !== 'ClientAPILevel' && typeof info === 'object')
    .map(([mac, info]) => {
      // isWL is the canonical band field (0=wired, 1=2.4G, 2=5G, 3=6G)
      // type may indicate device category, so prefer isWL
      const isWL = info.isWL;
      const connType = (isWL !== undefined && isWL !== null && isWL !== '')
        ? String(isWL)
        : String(info.type || '0');
      return ({
      mac,
      ip: info.ip || '',
      name: info.nickName || info.name || mac,
      type: connType,
      isOnline: info.isOnline === '1' || info.isOnline === 1,
      rssi: parseInt(info.rssi || '0'),
      curRx: parseFloat(info.curRx || '0'),
      curTx: parseFloat(info.curTx || '0'),
      totalRx: parseInt(info.totalRx || '0'),
      totalTx: parseInt(info.totalTx || '0'),
      ipMethod: info.ipMethod || 'dhcp',
      internetMode: info.internetMode || 'allow',
      amesh_papMac: info.amesh_papMac || '',
      vendor: info.vendor || lookupVendor(mac),
    });
  })
  .filter(c => c.isOnline);
}

function computeRates(clients) {
  // curRx/curTx are KB/s from firmware — convert to B/s for consistent display
  return clients.map(c => ({
    ...c,
    rxRate: (parseFloat(c.curRx) || 0) * 1024,
    txRate: (parseFloat(c.curTx) || 0) * 1024,
  }));
}

function parseNetdev(raw) {
  const nd = raw?.netdev || {};
  const dt = Math.max((Date.now() - prevPollTime) / 1000, 0.1);
  const result = {};
  for (const [key, val] of Object.entries(nd)) {
    // Router returns hex strings like "0x8d1ae12f"
    const bytes = parseInt(val || '0', 16);
    const prev = prevNetdev[key] ?? bytes;
    result[key] = { bytes, rate: Math.max(0, bytes - prev) / dt };
    prevNetdev[key] = bytes;
  }
  return result;
}

function parseMeshNodes(raw) {
  return (raw?.get_cfg_clientlist || []).map(n => ({
    mac: n.mac,
    ip: n.ip,
    model: n.ui_model_name || n.model_name || 'AiMesh Node',
    alias: n.alias || n.mac,
    online: n.online === '1',
  }));
}

// Auto-renew the ASUS token using stored credentials when it has expired.
// Falls back to notifying the client only after a few consecutive failures.
let asusRenewFailures = 0;
const ASUS_RENEW_MAX_FAILURES = 3;

async function ensureAsusAuth() {
  if (authToken && Date.now() < tokenExpiry) return true;
  if (!asusEnabled || !lastAsusUser || !lastAsusPass) return false;
  try {
    const token = await loginToRouter(routerIp, lastAsusUser, lastAsusPass);
    authToken = token;
    tokenExpiry = Date.now() + 25 * 60 * 1000;
    asusRenewFailures = 0;
    console.log('[auth] ASUS token auto-renewed');
    return true;
  } catch (e) {
    asusRenewFailures++;
    console.error(`[auth] ASUS auto-renew failed (${asusRenewFailures}/${ASUS_RENEW_MAX_FAILURES}):`, e.message);
    if (asusRenewFailures >= ASUS_RENEW_MAX_FAILURES) {
      io.emit('auth-required', { message: 'ASUSの自動再認証に失敗しました。設定から再ログインしてください。' });
      stopPolling();
    }
    return false;
  }
}

async function poll() {
  if (!await ensureAsusAuth()) return;
  try {
    const now = Date.now();
    const [clientRaw, netdevRaw, meshRaw] = await Promise.all([
      apiGet('get_clientlist()'),
      apiGet('netdev()'),
      apiGet('get_cfg_clientlist()'),
    ]);
    const clients = parseClientList(clientRaw);
    const withRates = computeRates(clients);
    latestAsusClients = withRates; // Cache for ip→mac resolution (used by resolveMacByIp)
    // Attach metadata (OUI vendor / DNS / mDNS) to each client
    for (const c of withRates) {
      const meta = getNodeMeta(c.ip, c.mac);
      c.vendor   = c.vendor || meta.vendor;
      c.dnsName  = meta.dnsName;
      c.mdnsName = meta.mdnsName;
    }
    const netdev = parseNetdev(netdevRaw);
    const meshNodes = parseMeshNodes(meshRaw);
    prevPollTime = now;

    io.emit('network-update', {
      timestamp: now,
      routerIp,
      clients: withRates,
      netdev,
      meshNodes,
      wanRx: netdev['WIRED_rx']?.rate ?? 0,
      wanTx: netdev['WIRED_tx']?.rate ?? 0,
    });
    // Auto-investigation for each ASUS-known client (ip+mac pair)
    if (autoInvestigate) {
      for (const c of withRates) {
        if (c.ip && c.mac) enqueueAutoInvestigation(c.ip, c.mac);
      }
    }
  } catch (err) {
    if (err.message === 'TOKEN_EXPIRED') {
      console.log('[poll] Token expired, requiring re-login');
      authToken = null;
      io.emit('auth-required', { message: 'セッションが切れました。再ログインしてください。' });
      stopPolling();
    } else {
      console.error('[poll error]', err.message);
      io.emit('poll-error', { message: err.message });
    }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_INTERVAL);
  poll();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Node Notes ───────────────────────────────────────────────────────────────
// User notes keyed by IP/MAC
const NOTES_FILE = path.join(__dirname, '.widemap.notes.json');
// Note: Object.create(null) is used to prevent prototype pollution
let notes = Object.create(null);

function loadNotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    notes = Object.create(null);
    // Copy existing keys while sanitising (drop invalid keys)
    let kept = 0, dropped = 0;
    for (const k of Object.keys(parsed)) {
      if (isSafeNoteKey(k) && typeof parsed[k] === 'string') {
        notes[k] = parsed[k];
        kept++;
      } else {
        dropped++;
      }
    }
    console.log(`[notes] Loaded ${kept} entries${dropped ? ` (dropped ${dropped} unsafe)` : ''}`);
  } catch { notes = Object.create(null); }
}
function saveNotes() {
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), { mode: 0o600 });
    try { fs.chmodSync(NOTES_FILE, 0o600); } catch {}
  } catch (e) { console.error('[notes] save failed:', e.message); }
}

// Composite key format: "ip|mac" recommended. Backward compat: "ip" or "mac" alone still accepted
// Client-side lookup finds entries matching either ip or mac
// Safe note-key regex: IPv4 and MAC (XX:XX:XX:XX:XX:XX) only, joinable with '|'
const NOTE_KEY_RE = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})(?:\|(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}))?$/;

function isSafeNoteKey(k) {
  return typeof k === 'string' && k.length <= 96 && NOTE_KEY_RE.test(k);
}

app.get('/api/notes', requireAdmin, (req, res) => res.json({ notes }));
app.post('/api/notes', requireAdmin, (req, res) => {
  const { ip, mac, note } = req.body || {};
  // Prefer ip|mac composite key; fall back to one side if the other is missing
  let key = '';
  if (ip && mac)      key = `${ip}|${mac}`;
  else if (ip)        key = ip;
  else if (mac)       key = mac;
  else if (req.body?.key) key = req.body.key; // backward compat
  // Prototype-pollution / unexpected-key defence: accept only IP/MAC format
  if (!isSafeNoteKey(key)) {
    return res.status(400).json({ error: 'invalid key (IP/MAC形式のみ)' });
  }
  if (typeof note === 'string') {
    const trimmed = note.trim().substring(0, 500);
    if (trimmed) {
      // Replace any existing entry sharing the same ip or mac (dedupe)
      if (ip || mac) {
        for (const k of Object.keys(notes)) {
          const [kip, kmac] = k.split('|');
          if ((ip && kip === ip) || (mac && (kmac === mac || kip === mac))) delete notes[k];
        }
      }
      notes[key] = trimmed;
    } else {
      // Empty note → delete (remove all entries matching ip or mac)
      if (ip || mac) {
        for (const k of Object.keys(notes)) {
          const [kip, kmac] = k.split('|');
          if ((ip && kip === ip) || (mac && (kmac === mac || kip === mac))) delete notes[k];
        }
      } else {
        delete notes[key];
      }
    }
  }
  saveNotes();
  io.emit('notes-update', { notes });
  res.json({ success: true });
});

// ─── Auto investigation (IP → note draft generation) ───────────────────
// TCP port connectivity probe
function probeTcp(ip, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
    sock.connect(port, ip);
  });
}

// Fetch HTTP Server header + <title>
async function probeHttpBanner(ip, port, https_ = false) {
  try {
    const url = `${https_ ? 'https' : 'http'}://${ip}${port === (https_ ? 443 : 80) ? '' : ':' + port}/`;
    const r = await axios.get(url, {
      timeout: 2500, maxRedirects: 0, validateStatus: () => true,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    const server = r.headers['server'] || '';
    const realm  = (r.headers['www-authenticate'] || '').match(/realm="([^"]+)"/i)?.[1] || '';
    const body   = typeof r.data === 'string' ? r.data : '';
    const title  = (body.match(/<title>([^<]+)<\/title>/i)?.[1] || '').trim().substring(0, 80);
    return { port, server, title, realm };
  } catch { return null; }
}

// SSDP M-SEARCH (1.5s)
function probeSsdp(targetIp, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 1\r\n' +
      'ST: ssdp:all\r\n\r\n'
    );
    sock.on('message', (data, rinfo) => {
      if (rinfo.address !== targetIp) return;
      const s = data.toString();
      const server = s.match(/SERVER:\s*([^\r\n]+)/i)?.[1]?.trim();
      const usn    = s.match(/USN:\s*([^\r\n]+)/i)?.[1]?.trim();
      const st     = s.match(/ST:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (server || usn || st) found.push({ server, usn, st });
    });
    sock.bind(() => {
      try { sock.send(msg, 1900, '239.255.255.250'); } catch {}
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, timeoutMs);
  });
}

// mDNS reverse PTR query (IP → hostname)
function probeMdns(ip, timeoutMs = 1500) {
  return new Promise(resolve => {
    const parts = ip.split('.').reverse();
    const name  = `${parts.join('.')}.in-addr.arpa`;
    // Build a minimal DNS packet
    const id = crypto.randomBytes(2);
    const flags = Buffer.from([0x00, 0x00]); // standard query
    const counts = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const qname = Buffer.concat(name.split('.').map(p => {
      const b = Buffer.from(p, 'utf8');
      return Buffer.concat([Buffer.from([b.length]), b]);
    }).concat([Buffer.from([0])]));
    const qtail = Buffer.from([0x00, 0x0c, 0x00, 0x01]); // PTR / IN
    const packet = Buffer.concat([id, flags, counts, qname, qtail]);

    const sock = dgram.createSocket('udp4');
    let host = null;
    sock.on('message', (data, rinfo) => {
      if (rinfo.address !== ip && rinfo.address !== '224.0.0.251') return;
      // Minimal response parser: extract the last TXT/PTR name
      const m = data.toString('binary').match(/[\x01-\x40]([A-Za-z0-9\-_]{2,63})\x05local/);
      if (m) host = m[1] + '.local';
    });
    sock.bind(() => {
      try { sock.setMulticastTTL(255); sock.send(packet, 5353, ip); } catch {}
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(host); }, timeoutMs);
  });
}

// ─── Apple model identifier → product name dictionary ─────────────────────
// (looked up from TXT record fields: model=, am=, md=)
const APPLE_MODELS = {
  // MacBook Air
  'MacBookAir10,1':'MacBook Air (M1, 2020)',
  'Mac14,2':'MacBook Air (M2, 2022)',
  'Mac14,15':'MacBook Air 15" (M2, 2023)',
  'Mac15,12':'MacBook Air 13" (M3, 2024)', 'Mac15,13':'MacBook Air 15" (M3, 2024)',
  'Mac16,12':'MacBook Air 13" (M4, 2025)', 'Mac16,13':'MacBook Air 15" (M4, 2025)',
  // MacBook Pro
  'MacBookPro17,1':'MacBook Pro 13" (M1, 2020)',
  'MacBookPro18,1':'MacBook Pro 16" (M1 Pro/Max, 2021)', 'MacBookPro18,2':'MacBook Pro 16" (M1 Pro/Max, 2021)',
  'MacBookPro18,3':'MacBook Pro 14" (M1 Pro/Max, 2021)', 'MacBookPro18,4':'MacBook Pro 14" (M1 Pro/Max, 2021)',
  'Mac14,7':'MacBook Pro 13" (M2, 2022)',
  'Mac14,5':'MacBook Pro 16" (M2 Pro/Max, 2023)','Mac14,6':'MacBook Pro 16" (M2 Pro/Max, 2023)',
  'Mac14,9':'MacBook Pro 14" (M2 Pro/Max, 2023)','Mac14,10':'MacBook Pro 14" (M2 Pro/Max, 2023)',
  'Mac15,3':'MacBook Pro 14" (M3, 2023)',
  'Mac15,6':'MacBook Pro 14" (M3 Pro, 2023)','Mac15,8':'MacBook Pro 14" (M3 Max, 2023)','Mac15,10':'MacBook Pro 14" (M3 Max, 2023)',
  'Mac15,7':'MacBook Pro 16" (M3 Pro, 2023)','Mac15,9':'MacBook Pro 16" (M3 Max, 2023)','Mac15,11':'MacBook Pro 16" (M3 Max, 2023)',
  'Mac16,1':'MacBook Pro 14" (M4, 2024)',
  'Mac16,6':'MacBook Pro 14" (M4 Pro, 2024)','Mac16,8':'MacBook Pro 14" (M4 Max, 2024)',
  'Mac16,5':'MacBook Pro 16" (M4 Pro, 2024)','Mac16,7':'MacBook Pro 16" (M4 Max, 2024)',
  // Mac mini / Studio / Pro
  'Macmini9,1':'Mac mini (M1, 2020)',
  'Mac14,3':'Mac mini (M2, 2023)', 'Mac14,12':'Mac mini (M2 Pro, 2023)',
  'Mac16,10':'Mac mini (M4, 2024)', 'Mac16,11':'Mac mini (M4 Pro, 2024)',
  'Mac13,1':'Mac Studio (M1 Max, 2022)','Mac13,2':'Mac Studio (M1 Ultra, 2022)',
  'Mac14,13':'Mac Studio (M2 Max, 2023)','Mac14,14':'Mac Studio (M2 Ultra, 2023)',
  'Mac14,8':'Mac Pro (M2 Ultra, 2023)',
  // iMac
  'iMac21,1':'iMac 24" (M1, 2021)','iMac21,2':'iMac 24" (M1, 2021)',
  'Mac15,4':'iMac 24" (M3, 2023)','Mac15,5':'iMac 24" (M3, 2023)',
  'Mac16,2':'iMac 24" (M4, 2024)','Mac16,3':'iMac 24" (M4, 2024)',
  // iPhone
  'iPhone10,1':'iPhone 8','iPhone10,4':'iPhone 8','iPhone10,2':'iPhone 8 Plus','iPhone10,5':'iPhone 8 Plus',
  'iPhone10,3':'iPhone X','iPhone10,6':'iPhone X',
  'iPhone11,2':'iPhone XS','iPhone11,4':'iPhone XS Max','iPhone11,6':'iPhone XS Max','iPhone11,8':'iPhone XR',
  'iPhone12,1':'iPhone 11','iPhone12,3':'iPhone 11 Pro','iPhone12,5':'iPhone 11 Pro Max','iPhone12,8':'iPhone SE (2nd gen)',
  'iPhone13,1':'iPhone 12 mini','iPhone13,2':'iPhone 12','iPhone13,3':'iPhone 12 Pro','iPhone13,4':'iPhone 12 Pro Max',
  'iPhone14,4':'iPhone 13 mini','iPhone14,5':'iPhone 13','iPhone14,2':'iPhone 13 Pro','iPhone14,3':'iPhone 13 Pro Max',
  'iPhone14,6':'iPhone SE (3rd gen)','iPhone14,7':'iPhone 14','iPhone14,8':'iPhone 14 Plus',
  'iPhone15,2':'iPhone 14 Pro','iPhone15,3':'iPhone 14 Pro Max','iPhone15,4':'iPhone 15','iPhone15,5':'iPhone 15 Plus',
  'iPhone16,1':'iPhone 15 Pro','iPhone16,2':'iPhone 15 Pro Max',
  'iPhone17,3':'iPhone 16','iPhone17,4':'iPhone 16 Plus','iPhone17,1':'iPhone 16 Pro','iPhone17,2':'iPhone 16 Pro Max','iPhone17,5':'iPhone 16e',
  // iPad
  'iPad8,1':'iPad Pro 11" (1st gen)','iPad11,1':'iPad mini (5th gen)','iPad11,3':'iPad Air (3rd gen)',
  'iPad11,6':'iPad (8th gen)','iPad12,1':'iPad (9th gen)','iPad13,1':'iPad Air (4th gen)',
  'iPad13,4':'iPad Pro 11" (3rd gen)','iPad13,8':'iPad Pro 12.9" (5th gen)',
  'iPad13,16':'iPad Air (5th gen)','iPad13,18':'iPad (10th gen)',
  'iPad14,1':'iPad mini (6th gen)','iPad14,3':'iPad Pro 11" (4th gen)','iPad14,5':'iPad Pro 12.9" (6th gen)',
  'iPad14,8':'iPad Air 11" (M2, 2024)','iPad14,10':'iPad Air 13" (M2, 2024)',
  'iPad15,3':'iPad Air 11" (M3, 2025)','iPad15,5':'iPad Air 13" (M3, 2025)',
  'iPad16,1':'iPad mini (7th gen)','iPad16,3':'iPad Pro 11" (M4, 2024)','iPad16,5':'iPad Pro 13" (M4, 2024)',
  // Apple Watch
  'Watch4,1':'Apple Watch Series 4','Watch5,1':'Apple Watch Series 5','Watch6,1':'Apple Watch SE',
  'Watch6,3':'Apple Watch Series 6','Watch6,12':'Apple Watch Series 7','Watch6,14':'Apple Watch Series 8',
  'Watch7,1':'Apple Watch SE (2nd gen)','Watch7,3':'Apple Watch Series 9','Watch7,5':'Apple Watch Ultra 2',
  // Apple TV
  'AppleTV5,3':'Apple TV HD','AppleTV6,2':'Apple TV 4K',
  'AppleTV11,1':'Apple TV 4K (2nd gen)','AppleTV14,1':'Apple TV 4K (3rd gen)',
  // HomePod
  'AudioAccessory1,1':'HomePod','AudioAccessory5,1':'HomePod mini','AudioAccessory6,1':'HomePod (2nd gen)',
};
function lookupAppleModel(id) {
  if (!id) return null;
  return APPLE_MODELS[id] || null;
}

// Bonjour: find common services in parallel and return ones whose IP matches
const BONJOUR_TYPES = [
  // Apple
  'airplay', 'airdrop', 'companion-link', 'device-info', 'homekit', 'raop', 'hap',
  'apple-mobdev2', 'apple-pairable', 'sleep-proxy', 'touch-able',
  // Amazon
  'amzn-alexa', 'amzn-wplay', 'amzn-tap', 'amzn-zigbee', 'amzn-rok', 'amzn-music',
  // LG (webOS Smart TV)
  'lg-mrcp', 'lg-mc', 'lgsmart', 'lg2nd-screen',
  // Samsung Smart TV
  'samsungmsf', 'sectv', 'samsung-ssd-c2',
  // Sony PlayStation / TV
  'psnpipe', 'acn-link', 'aquos',
  // Roku
  'rsp',
  // Common for TVs: DIAL (LG/Samsung/Sony etc.)
  'dial',
  // Plex / Synology NAS
  'plexmediasvr', 'synology-photo', 'syncthing',
  // Sonos / Bose / HEOS / Yamaha MusicCast
  'sonos', 'soundtouch', 'heos-audio', 'yxc', 'musiccast',
  // NVIDIA Shield
  'shield', 'gamestream',
  // Smart home / IoT
  'wemo', 'tasmota', 'esphome', 'home-assistant', 'shelly',
  // General
  'http', 'https', 'http-alt', 'ssh', 'sftp-ssh', 'workstation',
  // File sharing
  'smb', 'afpovertcp', 'nfs', 'webdav',
  // Printers and scanners
  'ipps', 'ipp', 'printer', 'pdl-datastream', 'uscan', 'uscans',
  // Streaming / IoT
  'googlecast', 'spotify-connect', 'hue', 'matter', 'esphomelib',
  // Network equipment and remote desktop
  'nvstream', 'rfb', 'vnc',
];

// Infer device category from MAC vendor (strong evidence)
function inferVendorCategory(vendor) {
  if (!vendor) return null;
  const v = vendor.toLowerCase();
  // Exact-match cases
  if (v.includes('apple')) return { brand: 'Apple', category: 'Apple機器' };
  if (v.includes('amazon')) return { brand: 'Amazon', category: 'Amazon機器 (Echo/Fire TV/Kindle等)' };
  if (v.includes('google')) return { brand: 'Google', category: 'Google機器 (Nest/Chromecast/Pixel等)' };
  if (v.includes('sonos')) return { brand: 'Sonos', category: 'Sonos スピーカー' };
  if (v.includes('roku')) return { brand: 'Roku', category: 'Roku ストリーミング' };
  if (v.includes('nintendo')) return { brand: 'Nintendo', category: 'Nintendo ゲーム機' };
  if (v.includes('sony')) return { brand: 'Sony', category: 'Sony 機器 (PlayStation/TV等)' };
  if (v.includes('microsoft')) return { brand: 'Microsoft', category: 'Microsoft 機器 (Xbox/Surface等)' };
  if (v.includes('philips')) return { brand: 'Philips', category: 'Philips 機器 (Hue等)' };
  if (v.includes('raspberry pi')) return { brand: 'RasPi', category: 'Raspberry Pi' };
  if (v.includes('espressif')) return { brand: 'Espressif', category: 'ESP32/ESP8266 IoT機器' };
  if (v.includes('shenzhen tp-link')) return { brand: 'TP-Link', category: 'TP-Link 機器' };
  if (v.includes('asustek')) return { brand: 'ASUS', category: 'ASUS 機器' };
  if (v.includes('yamaha')) return { brand: 'Yamaha', category: 'Yamaha 機器' };
  if (v.includes('switchbot')) return { brand: 'SwitchBot', category: 'SwitchBot IoT' };
  if (v.includes('netatmo')) return { brand: 'Netatmo', category: 'Netatmo IoT' };
  if (v.includes('canon')) return { brand: 'Canon', category: 'Canon (プリンタ/カメラ)' };
  if (v.includes('seiko epson')) return { brand: 'Epson', category: 'Epson プリンタ/スキャナ' };
  if (v.includes('hewlett packard') || v.includes('hp ')) return { brand: 'HP', category: 'HP 機器' };
  if (v.includes('lg electronics')) return { brand: 'LG', category: 'LG 機器 (TV/家電)' };
  if (v.includes('samsung')) return { brand: 'Samsung', category: 'Samsung 機器' };
  if (v.includes('panasonic')) return { brand: 'Panasonic', category: 'Panasonic 機器' };
  if (v.includes('intel ')) return { brand: 'Intel', category: 'Intel チップ搭載機 (PC/IoT)' };
  if (v.includes('lite-on') || v.includes('liteon')) return { brand: 'LiteOn', category: 'LiteOn製造 (Amazon Echoの可能性大)' };
  if (v.includes('foxconn') || v.includes('hon hai')) return { brand: 'Foxconn', category: 'Foxconn製造 (受託製造業者)' };
  return null;
}

let bonjourInstance = null;
function getBonjour() {
  if (!Bonjour) return null;
  if (!bonjourInstance) bonjourInstance = new Bonjour();
  return bonjourInstance;
}

function probeBonjourForIp(ip, timeoutMs = 3000) {
  return new Promise(resolve => {
    const bonjour = getBonjour();
    if (!bonjour) return resolve([]);
    const matches = [];
    const browsers = [];
    try {
      for (const type of BONJOUR_TYPES) {
        const browser = bonjour.find({ type, protocol: 'tcp' }, service => {
          const addrs = service.addresses || [];
          if (addrs.includes(ip)) {
            // Keep the full TXT record (for model-identifier extraction)
            const txt = service.txt || {};
            matches.push({
              type,
              name: service.name,
              host: service.host,
              port: service.port,
              txt,
            });
          }
        });
        browsers.push(browser);
      }
    } catch (e) {
      console.error('[bonjour] error:', e.message);
    }
    setTimeout(() => {
      browsers.forEach(b => { try { b.stop(); } catch {} });
      // Dedupe (same name+type counts as one)
      const seen = new Set();
      const uniq = matches.filter(m => {
        const k = m.type + '|' + m.name;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      resolve(uniq);
    }, timeoutMs);
  });
}

// NetBIOS Name Service (UDP/137) NodeStatus query → fetch computer name
function encodeNetbiosName(name) {
  let n = name.toUpperCase();
  while (n.length < 16) n += ' ';
  n = n.substring(0, 15) + '\x00';
  let out = '';
  for (let i = 0; i < n.length; i++) {
    const b = n.charCodeAt(i);
    out += String.fromCharCode(((b >> 4) & 0x0F) + 0x41);
    out += String.fromCharCode((b & 0x0F) + 0x41);
  }
  return out;
}

function probeNetbios(ip, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const txid = crypto.randomBytes(2);
    const flags = Buffer.from([0x00, 0x00]);
    const counts = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const encName = encodeNetbiosName('*');
    const qname = Buffer.concat([
      Buffer.from([32]), Buffer.from(encName, 'ascii'), Buffer.from([0])
    ]);
    const qtail = Buffer.from([0x00, 0x21, 0x00, 0x01]); // NBSTAT / IN
    const packet = Buffer.concat([txid, flags, counts, qname, qtail]);
    let result = null;
    sock.on('message', (data, rinfo) => {
      if (rinfo.address !== ip) return;
      try {
        // Response: header(12) + question(34) + answer-header(12) + numNames(1)
        const offset = 12 + 34 + 12;
        if (data.length < offset + 1) return;
        const numNames = data[offset];
        const names = [];
        let workstation = null;
        let domain = null;
        for (let i = 0; i < numNames; i++) {
          const start = offset + 1 + i * 18;
          if (start + 18 > data.length) break;
          const rawName = data.slice(start, start + 15).toString('ascii').replace(/\s+$/g, '').trim();
          const suffix = data[start + 15];
          const flagsHi = data[start + 16];
          const groupFlag = (flagsHi & 0x80) !== 0;
          if (!rawName) continue;
          // suffix 0x00 = Workstation Service (hostname)
          if (suffix === 0x00 && !groupFlag) workstation = rawName;
          // suffix 0x00 + group = domain/workgroup
          if (suffix === 0x00 && groupFlag) domain = rawName;
          names.push({ name: rawName, suffix: '0x' + suffix.toString(16).padStart(2,'0') });
        }
        result = { workstation, domain, names };
      } catch {}
    });
    sock.bind(() => {
      try { sock.send(packet, 137, ip); } catch {}
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(result); }, timeoutMs);
  });
}

// Look up MAC from the ARP table via Yamaha
async function probeYamahaArp(ip) {
  if (!yamahaEnabled || !yamahaReady) return null;
  try {
    const raw = await yamahaExec(`show arp`);
    const re = new RegExp(`(?:^|\\s)${ip.replace(/\./g, '\\.')}\\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})`);
    const m = raw.match(re);
    if (m) return m[1].toLowerCase();
  } catch (e) {
    console.error('[arp] error:', e.message);
  }
  return null;
}

// Combined investigation
async function investigateIp(ip) {
  if (!isAllowedRouterIp(ip)) return { error: 'IP範囲外' };
  const commonPorts = [22, 53, 80, 139, 443, 445, 548, 631, 1883, 5000, 7000, 8009, 8080, 8443, 8883, 9100, 32400, 49152];
  const [portResults, http80, http443, http8080, ssdp, host, hostByDns, bonjourServices, netbios, arpMac] = await Promise.all([
    Promise.all(commonPorts.map(async p => ({ p, open: await probeTcp(ip, p) }))),
    probeHttpBanner(ip, 80),
    probeHttpBanner(ip, 443, true),
    probeHttpBanner(ip, 8080),
    probeSsdp(ip),
    probeMdns(ip),
    dns.reverse(ip).then(arr => arr[0]).catch(() => null),
    probeBonjourForIp(ip, 3000),
    probeNetbios(ip),
    probeYamahaArp(ip),
  ]);
  const openPorts = portResults.filter(r => r.open).map(r => r.p);
  const httpInfo = [http80, http443, http8080].filter(Boolean);

  // === Build an "inference story" stacking weak evidence ===
  const story = [];
  story.push(`📍 ${ip}`);

  // ── ARP (via Yamaha) + look up OUI vendor
  let mac = arpMac;
  let vendor = null;
  let vendorInfo = null;
  if (mac) {
    vendor = ouiDb?.get(mac.replace(/:/g, '').substring(0, 6).toUpperCase()) || null;
    vendorInfo = inferVendorCategory(vendor);
    // Detect locally-administered MAC (privacy address)
    const firstByte = parseInt(mac.split(':')[0], 16);
    const isLocallyAdmin = (firstByte & 0x02) !== 0;
    let macLine = `    ${mac}`;
    if (vendor) macLine += ` — ${vendor}`;
    if (isLocallyAdmin) macLine += ' (locally administered/プライバシーMAC)';
    story.push(`  ↓ ARP (Yamaha)\n${macLine}`);
  }

  // ── Reverse DNS
  if (hostByDns) story.push(`  ↓ DNS reverse\n    ${hostByDns}`);

  // ── mDNS hostname
  let mdnsHost = host;
  if (!mdnsHost) {
    const named = bonjourServices?.find(s => s.host);
    if (named) mdnsHost = named.host;
  }
  if (mdnsHost) story.push(`  ↓ mDNS hostname\n    ${mdnsHost}.local`);

  // ── NetBIOS
  if (netbios?.workstation) {
    story.push(`  ↓ NetBIOS NodeStatus\n    ${netbios.workstation}${netbios.domain ? ` (workgroup: ${netbios.domain})` : ''}`);
  }

  // ── Enumerate Bonjour services
  const bonjourTypes = new Set((bonjourServices || []).map(s => s.type));
  if (bonjourTypes.size) {
    story.push(`  ↓ Bonjour services\n    ${[...bonjourTypes].join(', ')}`);
  }

  // ── Extract Apple model identifier (from multiple service TXTs)
  // _airplay TXT: model=Mac14,2  /  am=...
  // _device-info TXT: model=Mac14,2
  // _companion-link / _homekit TXT: md=...
  let appleModelId = null;
  let modelSource = null;
  for (const s of bonjourServices || []) {
    const tx = s.txt || {};
    const m = tx.model || tx.am || tx.md || tx['model'];
    if (m && /^[A-Za-z]+\d+,\d+/.test(m)) {
      appleModelId = m;
      modelSource = s.type;
      break;
    }
  }
  if (appleModelId) {
    story.push(`  ↓ ${modelSource} TXT record\n    model=${appleModelId}`);
    const productName = lookupAppleModel(appleModelId);
    if (productName) {
      story.push(`  ↓ Apple model identifier\n    ${productName}`);
    }
  }

  // ── Port scan
  if (openPorts.length) {
    story.push(`  ↓ open TCP ports\n    ${openPorts.join(', ')}`);
  }

  // ── HTTP banner
  for (const h of httpInfo) {
    const seg = [];
    if (h.title)  seg.push(`title="${h.title}"`);
    if (h.server) seg.push(`Server: ${h.server}`);
    if (h.realm)  seg.push(`Realm: ${h.realm}`);
    if (seg.length) story.push(`  ↓ HTTP/${h.port}\n    ${seg.join(' / ')}`);
  }

  // ── SSDP / UPnP
  for (const s of (ssdp || [])) {
    if (s.server) story.push(`  ↓ SSDP\n    ${s.server}`);
  }

  // === Inference logic ===
  // Weighted approach: strong evidence (model identifier, OUI brand) wins,
  // a port alone only conveys "possibility"
  const guesses = [];
  const brand = vendorInfo?.brand || null;
  // Extract brand keywords from HTTP banner
  const httpText = httpInfo.map(h => `${h.title || ''} ${h.server || ''} ${h.realm || ''}`).join(' ').toLowerCase();
  const httpMentionsAmazon  = /amazon|echo|fire ?tv|kindle|alexa/.test(httpText);
  const httpMentionsGoogle  = /google|nest|chromecast/.test(httpText);

  // ── Strong evidence (model identifier, etc.) ──
  if (appleModelId) {
    const name = lookupAppleModel(appleModelId);
    guesses.push(name ? `★ ${name}` : `★ Apple device (${appleModelId})`);
  }
  // ── Brand inference (OUI-derived is strong evidence) ──
  if (vendorInfo && !appleModelId) {
    // Prevent Amazon devices with Cast-compatible ports (8008/8009) from being misclassified as Google
    // Prioritise the OUI vendor
    guesses.push(`★ ${vendorInfo.category}`);
  }

  // ── Service-based inference (only as fallback when OUI is inconclusive) ──
  if (!appleModelId && !brand) {
    if (bonjourTypes.has('airplay') || bonjourTypes.has('raop'))             guesses.push('Apple AirPlay 機器');
    if (bonjourTypes.has('companion-link') || bonjourTypes.has('apple-mobdev2')) guesses.push('Apple iPhone/iPad');
    if (bonjourTypes.has('device-info') && !bonjourTypes.has('companion-link')) guesses.push('Apple Mac');
  }
  if (bonjourTypes.has('homekit') || bonjourTypes.has('hap'))              guesses.push('HomeKit アクセサリ');

  // ── Vendor-specific Bonjour (strong evidence, independent of OUI) ──
  const types = [...bonjourTypes];
  const hasAmznService = types.some(t => t.startsWith('amzn-'));
  const hasLgService   = types.some(t => t.startsWith('lg-') || t === 'lgsmart' || t === 'lg2nd-screen');
  const hasSamsungSvc  = types.some(t => t.startsWith('samsung') || t === 'sectv');
  const hasSonyPsn     = types.includes('psnpipe') || types.includes('acn-link');
  const hasSonySvc     = types.includes('aquos'); // Sharp/Sony family
  const hasSynology    = types.some(t => t.startsWith('synology'));

  if (hasAmznService) guesses.push('★ Amazon Alexa/Echo (Bonjour amzn-*)');
  if (hasLgService)   guesses.push('★ LG Smart TV (webOS)');
  if (hasSamsungSvc)  guesses.push('★ Samsung Smart TV');
  if (hasSonyPsn)     guesses.push('★ Sony PlayStation');
  if (hasSonySvc)     guesses.push('★ Sharp/Sony AQUOS');
  if (bonjourTypes.has('rsp'))             guesses.push('★ Roku ストリーミング機器');
  if (bonjourTypes.has('plexmediasvr'))    guesses.push('★ Plex Media Server');
  if (hasSynology)                          guesses.push('★ Synology NAS');
  if (bonjourTypes.has('syncthing'))       guesses.push('Syncthing 同期サーバ');
  if (bonjourTypes.has('sonos'))           guesses.push('★ Sonos スピーカー');
  if (bonjourTypes.has('soundtouch'))      guesses.push('★ Bose SoundTouch スピーカー');
  if (bonjourTypes.has('heos-audio'))      guesses.push('★ Denon/Marantz HEOS (オーディオ)');
  if (bonjourTypes.has('musiccast') || bonjourTypes.has('yxc')) guesses.push('★ Yamaha MusicCast (オーディオ)');
  if (bonjourTypes.has('shield') || bonjourTypes.has('gamestream') || bonjourTypes.has('nvstream'))
    guesses.push('★ NVIDIA Shield / GeForce 系');
  if (bonjourTypes.has('wemo'))            guesses.push('★ Belkin WeMo IoT');
  if (bonjourTypes.has('tasmota'))         guesses.push('★ Tasmota IoT デバイス');
  if (bonjourTypes.has('esphome') || bonjourTypes.has('esphomelib'))
    guesses.push('★ ESPHome IoT デバイス');
  if (bonjourTypes.has('shelly'))          guesses.push('★ Shelly IoT スイッチ');
  if (bonjourTypes.has('home-assistant'))  guesses.push('★ Home Assistant');
  if (bonjourTypes.has('matter'))          guesses.push('★ Matter 対応スマートデバイス');
  // DIAL: Smart TV protocol used by Chromecast/LG/Samsung/Sony etc.
  if (bonjourTypes.has('dial') && !hasLgService && !hasSamsungSvc && !bonjourTypes.has('googlecast'))
    guesses.push('DIAL 対応 Smart TV (LG/Samsung/Sony 等)');

  // Chromecast/Google: confirmed if googlecast Bonjour, Google vendor, or Google keyword in HTTP
  // Port 8009 alone is not enough (Amazon Fire TV etc. also expose Cast-compatible ports)
  if (bonjourTypes.has('googlecast')) {
    guesses.push('Chromecast / Google Cast 対応機器');
  } else if (openPorts.includes(8009) && (brand === 'Google' || httpMentionsGoogle)) {
    guesses.push('Chromecast / Google Cast 対応機器');
  } else if (openPorts.includes(8009) && brand !== 'Amazon' && !hasAmznService && !brand) {
    // Vendor unknown + no other Chromecast evidence → mark as possibility only
    guesses.push('Cast プロトコル対応機器（Chromecast互換ポート）');
  }

  // Non-Apple
  if (bonjourTypes.has('ipp') || bonjourTypes.has('ipps') || bonjourTypes.has('printer') || openPorts.includes(631) || openPorts.includes(9100))
    guesses.push('プリンタ');
  if (bonjourTypes.has('spotify-connect')) guesses.push('Spotify Connect 対応機器');
  if (bonjourTypes.has('hue'))             guesses.push('Philips Hue Bridge');
  if (bonjourTypes.has('matter') || bonjourTypes.has('esphomelib')) guesses.push('Matter/ESPHome IoT');
  if (bonjourTypes.has('smb') || openPorts.includes(445))   guesses.push('SMB/NAS 対応');
  if (openPorts.includes(32400))                            guesses.push('Plex Media Server');
  if (openPorts.includes(1883) || openPorts.includes(8883)) guesses.push('MQTT/IoT');
  if (netbios?.workstation && !brand?.includes('Apple') && !guesses.some(g => g.includes('Apple'))) {
    guesses.push('Windows/SMB 対応機器');
  }
  if (!guesses.length && openPorts.includes(22))            guesses.push('SSH 可能なホスト (Linux/サーバ)');

  // Hints from HTTP banner
  if (httpMentionsAmazon && !guesses.some(g => g.includes('Amazon'))) {
    guesses.unshift('★ HTTP応答に Amazon 関連文字列 → Amazon機器');
  }

  // Dedupe and format (★-prefixed = strong evidence, others = supplementary)
  const uniqGuesses = [...new Set(guesses)];
  if (uniqGuesses.length) {
    story.push('');
    const strong = uniqGuesses.filter(g => g.startsWith('★ ')).map(g => g.replace(/^★\s+/, ''));
    const weak   = uniqGuesses.filter(g => !g.startsWith('★ '));
    if (strong.length) story.push(`🎯 推論: ${strong.join(' / ')}`);
    if (weak.length)   story.push(`   補足: ${weak.join(' / ')}`);
  }

  // Show guidance when nothing was found
  if (story.length === 1) {
    story.push(`(調査でホスト名・サービス・ポートいずれも検出できず。mDNS/UPnPは L2 マルチキャストのため、サーバーが対象LANと別セグメントの場合は届きません)`);
  }

  return {
    draft: story.join('\n'),
    raw: { mac: arpMac, openPorts, httpInfo, ssdp, host: mdnsHost, hostByDns, bonjourServices, netbios, appleModelId },
  };
}

// ─── Auto-investigation queue (parallel processing) ──────────────────────
const INVESTIGATE_CONCURRENCY = 2;       // concurrency
const INVESTIGATE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // skip same IP for 24h
const investigatedAt = new Map();        // ip -> timestamp (last investigation time)
const investigationQueue = [];           // [{ip, mac}]
const inQueueIps = new Set();
let runningInvestigations = 0;

// Check whether a note is already recorded (matches by ip or mac)
function hasNote(ip, mac) {
  if (ip && notes[ip]) return true;
  if (mac && notes[mac]) return true;
  for (const k of Object.keys(notes)) {
    const [kip, kmac] = k.split('|');
    if (ip && kip === ip) return true;
    if (mac && (kmac === mac || kip === mac)) return true;
  }
  return false;
}

function enqueueAutoInvestigation(ip, mac) {
  if (!autoInvestigate) return;
  if (!ip || !isAllowedRouterIp(ip)) return;
  // Do not investigate the routers themselves
  if (ip === routerIp || ip === yamahaIp) return;
  if (hasNote(ip, mac)) return;
  if (inQueueIps.has(ip)) return;
  const last = investigatedAt.get(ip);
  if (last && Date.now() - last < INVESTIGATE_COOLDOWN_MS) return;
  inQueueIps.add(ip);
  investigationQueue.push({ ip, mac });
  drainInvestigationQueue();
}

function drainInvestigationQueue() {
  while (runningInvestigations < INVESTIGATE_CONCURRENCY && investigationQueue.length > 0) {
    const job = investigationQueue.shift();
    inQueueIps.delete(job.ip);
    runningInvestigations++;
    runAutoInvestigation(job.ip, job.mac).finally(() => {
      runningInvestigations--;
      drainInvestigationQueue();
    });
  }
}

async function runAutoInvestigation(ip, mac) {
  investigatedAt.set(ip, Date.now());
  // Re-check just before running (prevents races with manual notes)
  if (hasNote(ip, mac)) return;
  try {
    console.log(`[auto-investigate] start ${ip} (mac=${mac || '?'})`);
    const result = await investigateIp(ip);
    if (!result || !result.draft) return;
    if (hasNote(ip, mac)) return; // prevent double-save under race
    const key = (ip && mac) ? `${ip}|${mac}` : (ip || mac);
    if (!isSafeNoteKey(key)) return; // defence: do not save invalid keys
    const tag = '[Auto] ';
    notes[key] = (tag + result.draft).substring(0, 500);
    saveNotes();
    io.emit('notes-update', { notes });
    console.log(`[auto-investigate] saved ${ip}`);
  } catch (e) {
    console.error(`[auto-investigate] ${ip} failed: ${e.message}`);
  }
}

app.post('/api/notes/draft', requireAdmin, async (req, res) => {
  const ip = req.body?.ip;
  if (!ip || !isAllowedRouterIp(ip)) {
    return res.status(400).json({ error: '有効なプライベートIPを指定してください' });
  }
  try {
    const result = await investigateIp(ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
// Require admin token via handshake auth on connect
io.use((socket, next) => {
  const provided = socket.handshake.auth?.token || '';
  if (!adminToken) return next(new Error('管理トークン未初期化'));
  const a = Buffer.from(String(provided));
  const b = Buffer.from(adminToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new Error('Unauthorized'));
  }
  next();
});

io.on('connection', socket => {
  console.log('[ws] Client connected:', socket.id);
  // WARNING: never send passwords to clients (XSS / eavesdropping mitigation)
  // Only notify whether they are "set" as a boolean
  socket.emit('config', {
    routerIp: routerIp || DEFAULT_ROUTER_IP,
    asusUser: lastAsusUser,
    asusPassSet: !!lastAsusPass,
    authenticated: !!authToken && Date.now() < tokenExpiry,
    asusEnabled, yamahaEnabled,
    yamahaIp, yamahaUser,
    yamahaPassSet: !!yamahaPass,
    yamahaReady,
    homeCountry,
    language: uiLanguage,
    autoInvestigate,
    notes,
  });
  if (asusEnabled && (!authToken || Date.now() > tokenExpiry)) {
    socket.emit('auth-required', { message: 'セッションが切れています' });
  }
  if (yamahaEnabled && connectionHistory.size) {
    socket.emit('connections-update', {
      connections: [...connectionHistory.values()],
      serverTime: Date.now(),
    });
  }
});

server.listen(PORT, () => {
  console.log(`Widemap: http://localhost:${PORT}`);
  loadConfig();
  ensureAdminToken();
  loadNotes();
  loadConnectionHistory();
  console.log(`Router IP: ${routerIp}`);
  loadOuiDb();
  connectYamaha();

  // Periodic snapshot: write the latest lastSeen every 10 minutes (halves append volume)
  setInterval(snapshotHistory, 10 * 60 * 1000);
  // Periodic compaction: rewrite log every 30 minutes (dedupe + drop entries past TTL)
  setInterval(compactHistoryLog, 30 * 60 * 1000);
});

// Graceful shutdown: write a final snapshot on exit
function shutdown() {
  console.log('[shutdown] Saving history...');
  try {
    compactHistoryLog();
  } catch {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
