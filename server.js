require('dotenv').config();
// Prefer IPv4 (prevents external HTTPS from stalling on IPv6, e.g. on EC2)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { isAllowedRouterIp, htmlEscape } = require('./src/utils');
const enrichment = require('./src/enrichment');
const history = require('./src/history');
const deviceId = require('./src/device-identify');
const threatIntel = require('./src/threat-intel');
const notifier = require('./src/notifier');
const backup = require('./src/backup');
const yamaha = require('./src/pollers/yamaha');
const asus = require('./src/pollers/asus');
const dnsmasqLog    = require('./src/pollers/dnsmasq-log');
const inspectSyslog = require('./src/pollers/inspect-syslog');
const dhcpdSyslog   = require('./src/pollers/dhcpd-syslog');
const devices       = require('./src/devices');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  allowRequest: (req, cb) => {
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

// ─── App state ────────────────────────────────────────────────────────────────
let homeCountry  = 'JP';
let uiLanguage   = 'ja';
let autoInvestigate = false;
let adminToken   = '';
let retentionDays = 730; // 2 years default
let latestConnections = [];
let knownMacs = new Set();
let dnsmasqEnabled  = true;
let dnsmasqLogFile  = '/var/log/dnsmasq-queries.log';
let inspectEnabled  = true;
let inspectLogFile  = '/var/log/yamaha-router.log';
let dhcpdEnabled    = true;
let dhcpdLogFile    = '/var/log/yamaha-router.log';

// Debounce timer for [INSPECT] connections-update emissions
let inspectEmitTimer = null;
function scheduleInspectEmit() {
  if (inspectEmitTimer) return;
  inspectEmitTimer = setTimeout(() => {
    inspectEmitTimer = null;
    const cutoff = Date.now() - 86400_000;
    io.emit('connections-update', {
      connections: [...history.getConnectionHistory().values()].filter(c => c.lastSeen >= cutoff),
      serverTime: Date.now(),
      partial: true,
    });
  }, 1000);
}

// ─── Config file ──────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, '.widemap.json');

function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (data.yamaha) {
      yamaha.configure({
        ip: data.yamaha.ip || '',
        user: data.yamaha.user || '',
        pass: data.yamaha.pass || '',
        enabled: data.yamaha.enabled !== false,
        hostFp: data.yamaha.hostFp || '',
        natDescriptor: data.yamaha.nat || '100',
      });
    }
    if (data.asus) {
      asus.configure({
        routerIp: data.asus.ip || DEFAULT_ROUTER_IP,
        user: data.asus.user || '',
        pass: data.asus.pass || '',
        enabled: data.asus.enabled ?? false,
      });
    }
    if (data.general?.homeCountry) homeCountry = data.general.homeCountry;
    if (data.general?.language && ['ja','en'].includes(data.general.language)) uiLanguage = data.general.language;
    if (typeof data.general?.autoInvestigate === 'boolean') autoInvestigate = data.general.autoInvestigate;
    if (data.general?.retentionDays) retentionDays = data.general.retentionDays;
    if (data.backup) {
      if (data.backup.intervalHours) backup.configure({ intervalHours: data.backup.intervalHours });
      if (data.backup.maxGenerations) backup.configure({ maxGenerations: data.backup.maxGenerations });
    }
    if (data.slack) notifier.configure({ ...data.slack, language: uiLanguage });
    if (data.adminToken) adminToken = data.adminToken;
    dhcpdEnabled = data.dhcpd?.enabled !== false;
    dhcpdLogFile = data.dhcpd?.logFile || '/var/log/yamaha-router.log';
    dhcpdSyslog.configure({ logFile: dhcpdLogFile, enabled: dhcpdEnabled });
    inspectEnabled = data.inspect?.enabled !== false;
    inspectLogFile = data.inspect?.logFile || '/var/log/yamaha-router.log';
    inspectSyslog.configure({
      logFile:   inspectLogFile,
      enabled:   inspectEnabled,
      onSession: handleInspectSession,
    });
    dnsmasqEnabled = data.dnsmasq?.enabled !== false;
    dnsmasqLogFile = data.dnsmasq?.logFile || '/var/log/dnsmasq-queries.log';
    dnsmasqLog.configure({
      logFile: dnsmasqLogFile,
      enabled: dnsmasqEnabled,
      onDnsQuery: ({ clientIp, domain, resolvedIp }) => {
        if (resolvedIp) {
          enrichment.getDnsCache().set(resolvedIp, {
            host: domain,
            expires: Date.now() + 5 * 60 * 1000,
            source: 'dnsmasq',
          });
        }
      },
    });
    console.log('[config] Loaded:', CONFIG_FILE);
    return data;
  } catch {
    console.log('[config] No saved config, using defaults');
    return {};
  }
}

function saveConfig() {
  const data = {
    yamaha: { ip: yamaha.getIp(), user: yamaha.getUser(), pass: process.env.YAMAHA_PASS || '', enabled: yamaha.isEnabled(), hostFp: yamaha.getHostFp(), nat: yamaha.getNat() },
    asus: { ip: asus.getRouterIp(), user: asus.getUser(), pass: '', enabled: asus.isEnabled() },
    general: { homeCountry, language: uiLanguage, autoInvestigate, retentionDays },
    backup: backup.getConfig(),
    slack: { ...notifier.getConfig(), tokenSet: undefined },
    adminToken,
    dnsmasq: { enabled: dnsmasqEnabled, logFile: dnsmasqLogFile },
    inspect: { enabled: inspectEnabled, logFile: inspectLogFile },
    dhcpd:   { enabled: dhcpdEnabled,   logFile: dhcpdLogFile   },
  };
  // Re-read to preserve passwords (they are not stored in module state getters)
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (existing.yamaha?.pass) data.yamaha.pass = existing.yamaha.pass;
    if (existing.asus?.pass) data.asus.pass = existing.asus.pass;
    if (existing.slack?.token) data.slack.token = existing.slack.token;
  } catch {}
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    console.log('[config] Saved:', CONFIG_FILE);
  } catch (e) {
    console.error('[config] Save failed:', e.message);
  }
}

/**
 * Atomically merge credential fields into one section of the config file.
 * Use when a new plaintext secret is received (login/setup routes).
 * `saveConfig()` preserves existing secrets, but does not know newly-entered ones.
 */
function persistSecret(section, updates) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg[section] = { ...(cfg[section] || {}), ...updates };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  } catch (e) {
    console.error('[config] persistSecret failed:', e.message);
  }
}

// ─── Admin token ──────────────────────────────────────────────────────────────
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

// ─── Resolve MAC by IP (ASUS DHCP table → Yamaha ARP) ─────────────────────────
function resolveMacByIp(ip) {
  if (!ip) return null;
  const asusMac = asus.getClientMac(ip);
  if (asusMac) return asusMac;
  const dhcpdMac = dhcpdSyslog.getMacByIp(ip);
  if (dhcpdMac) return dhcpdMac;
  return yamaha.getArpMac(ip);
}

// ─── Shared connection record helper ─────────────────────────────────────────
/**
 * Enrich a session from caches, upsert into connectionHistory, notify.
 * @param {object} session  - { src, sport, dst, dport, proto, ttl? }
 * @param {number} [now]    - timestamp (defaults to Date.now())
 * @returns {{ entry, key, isNew }}
 */
function recordConnection(session, now = Date.now()) {
  const { src, sport, dst, dport, proto } = session;

  const srcMac  = resolveMacByIp(src);
  const srcMeta = deviceId.getNodeMeta(src, srcMac);

  // Resolve dstHost: prefer dnsmasq > PTR (if not junk) > raw IP
  const dnsCached = enrichment.getDnsCache().get(dst);
  let dstHost = dst;
  if (dnsCached && dnsCached.expires > now) {
    if (dnsCached.source === 'dnsmasq' || !enrichment.isPtrJunk(dnsCached.host)) {
      dstHost = dnsCached.host;
    }
  }

  const rdap = enrichment.getRdapCache().get(dst);
  const geo  = enrichment.getGeoCache().get(dst);

  const enriched = {
    src, sport: sport ?? null, dst, dport, proto,
    srcMac,
    srcVendor:   srcMeta.vendor,
    srcDnsName:  srcMeta.dnsName,
    srcMdnsName: srcMeta.mdnsName,
    dstHost,
    country: rdap?.country || geo?.countryCode || null,
    org:     rdap?.org     || null,
    lat:     geo?.lat  ?? null,
    lon:     geo?.lon  ?? null,
    city:    geo?.city ?? null,
    threat:  threatIntel.matchThreatIntel(dst, dstHost) || null,
    ttl:     session.ttl ?? 0,
  };

  const connectionHistory = history.getConnectionHistory();
  const key      = `${src}|${dst}|${dport}|${proto}`;
  const existing = connectionHistory.get(key);
  const isNew    = !existing;
  const entry    = { ...enriched, firstSeen: existing?.firstSeen ?? now, lastSeen: now };
  connectionHistory.set(key, entry);

  if (entry.threat) notifier.notify(entry);
  if (entry.srcMac && !knownMacs.has(entry.srcMac)) {
    knownMacs.add(entry.srcMac);
    notifier.notifyNewDevice(entry);
    io.emit('new-device', entry);
  }
  if (isNew) history.appendHistoryLog(entry);

  // Update device inventory
  devices.upsert({
    ip:        entry.src,
    mac:       entry.srcMac      || null,
    vendor:    entry.srcVendor   || null,
    dnsName:   entry.srcDnsName  || null,
    mdnsName:  entry.srcMdnsName || null,
    firstSeen: entry.firstSeen,
    lastSeen:  entry.lastSeen,
    source:    proto === 'TCP' ? 'inspect' : 'nat',
  });

  return { entry, key, isNew };
}

// ─── [INSPECT] session handler ───────────────────────────────────────────────
function handleInspectSession(session) {
  const now = Date.now();
  const { dst } = session;

  const rdap = enrichment.getRdapCache().get(dst);
  const geo  = enrichment.getGeoCache().get(dst);

  const { key } = recordConnection(session, now);

  // Async: enrich missing geo/rdap/ptr in background (fire-and-forget)
  if (!rdap || !geo) {
    const connectionHistory = history.getConnectionHistory();
    Promise.allSettled([
      enrichment.reverseDns(dst),
      enrichment.lookupRdap(dst),
      enrichment.lookupGeoBatch([dst]),
    ]).then(() => {
      const e = connectionHistory.get(key);
      if (!e) return;
      const dc2  = enrichment.getDnsCache().get(dst);
      const now2 = Date.now();
      if (dc2 && dc2.expires > now2) {
        if (dc2.source === 'dnsmasq' || !enrichment.isPtrJunk(dc2.host)) e.dstHost = dc2.host;
      }
      const r2 = enrichment.getRdapCache().get(dst);
      const g2 = enrichment.getGeoCache().get(dst);
      e.country = r2?.country || g2?.countryCode || e.country;
      e.org     = r2?.org     || e.org;
      e.lat     = g2?.lat  ?? e.lat;
      e.lon     = g2?.lon  ?? e.lon;
      e.city    = g2?.city ?? e.city;
    }).catch(() => {});
  }

  scheduleInspectEmit();
}

// ─── Notes ────────────────────────────────────────────────────────────────────
const NOTES_FILE = path.join(__dirname, '.widemap.notes.json');
let notes = Object.create(null);

const NOTE_KEY_RE = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})(?:\|(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}))?$/;

function isSafeNoteKey(k) {
  return typeof k === 'string' && k.length <= 96 && NOTE_KEY_RE.test(k);
}

function loadNotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    notes = Object.create(null);
    let kept = 0, dropped = 0;
    for (const k of Object.keys(parsed)) {
      if (isSafeNoteKey(k) && typeof parsed[k] === 'string') { notes[k] = parsed[k]; kept++; }
      else { dropped++; }
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

// ─── Auto-investigation queue ─────────────────────────────────────────────────
const INVESTIGATE_CONCURRENCY = 2;
const INVESTIGATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const investigatedAt = new Map();
const investigationQueue = [];
const inQueueIps = new Set();
let runningInvestigations = 0;

function enqueueAutoInvestigation(ip, mac) {
  if (!autoInvestigate) return;
  if (!ip || !isAllowedRouterIp(ip)) return;
  if (ip === asus.getRouterIp() || ip === yamaha.getIp()) return;
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
  if (hasNote(ip, mac)) return;
  try {
    console.log(`[auto-investigate] start ${ip} (mac=${mac || '?'})`);
    const result = await deviceId.investigateIp(ip, {
      ouiDb: deviceId.getOuiDb(),
      yamahaExec: yamaha.isReady() ? yamaha.yamahaExec : null,
      yamahaEnabled: yamaha.isEnabled(),
      yamahaReady: yamaha.isReady(),
    });
    if (!result || !result.draft) return;
    if (hasNote(ip, mac)) return;
    const key = (ip && mac) ? `${ip}|${mac}` : (ip || mac);
    if (!isSafeNoteKey(key)) return;
    const tag = '[Auto] ';
    notes[key] = (tag + result.draft).substring(0, 500);
    saveNotes();
    io.emit('notes-update', { notes });
    console.log(`[auto-investigate] saved ${ip}`);
  } catch (e) {
    console.error(`[auto-investigate] ${ip} failed: ${e.message}`);
  }
}

// ─── Yamaha polling logic ─────────────────────────────────────────────────────
async function pollYamahaConnections() {
  if (!yamaha.isEnabled() || !yamaha.isReady()) return;
  try {
    const sessions = await yamaha.fetchNatSessions();
    console.log(`[yamaha] ${sessions.length} sessions parsed`);

    const unique = [...new Set(sessions.map(s => s.dst))];
    await Promise.allSettled(unique.map(ip => enrichment.reverseDns(ip)));
    await Promise.allSettled(unique.map(ip => enrichment.lookupRdap(ip)));
    await enrichment.lookupGeoBatch(unique);

    const now = Date.now();
    if (yamaha.needsArpRefresh()) {
      await yamaha.refreshYamahaArp();
    }
    if (yamaha.needsNdpRefresh()) {
      await yamaha.refreshYamahaNdp();
    }

    latestConnections = sessions.map(s => {
      const { entry } = recordConnection(s, now);
      return entry;
    });

    history.pruneHistory();

    const pollCutoff = now - 86400_000;
    io.emit('connections-update', {
      connections: [...connectionHistory.values()].filter(c => c.lastSeen >= pollCutoff),
      serverTime: now,
      partial: true,
    });

    if (autoInvestigate) {
      const srcIps = [...new Set(sessions.map(s => s.src))];
      for (const ip of srcIps) enqueueAutoInvestigation(ip, resolveMacByIp(ip));
    }
  } catch (err) {
    console.error('[yamaha] poll error:', err.message);
    if (err.message.includes('timeout')) {
      console.log('[yamaha] Timeout detected, resetting connection…');
      yamaha.reconnect();
      return;
    }
  }
  setTimeout(pollYamahaConnections, 60000);
}

// ─── Express routes ───────────────────────────────────────────────────────────
// Serve index.html with __BASE__ substituted
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html').send(html.replace(/__BASE__/g, htmlEscape(SUBPATH)));
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '64kb' }));

// Admin token verification
app.post('/api/admin/verify', express.json(), (req, res) => {
  const provided = (req.body && req.body.token) || '';
  if (!adminToken) return res.status(503).json({ ok: false, error: '未初期化' });
  const a = Buffer.from(provided);
  const b = Buffer.from(adminToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return res.json({ ok: true });
  }
  setTimeout(() => res.status(401).json({ ok: false, error: 'トークン不正' }), 500);
});

// Proxy nonce request
app.post('/api/nonce', requireAdmin, async (req, res) => {
  const axios = require('axios');
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

// Login / setup
app.post('/api/login', requireAdmin, async (req, res) => {
  const { username, password, routerIp: ip,
          yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass, yamahaNat: yNat } = req.body;
  const doAsus   = req.body.doAsus;
  const doYamaha = req.body.doYamaha;

  if (doAsus === undefined && doYamaha === undefined) {
    return res.status(400).json({ error: '設定対象を指定してください' });
  }

  if (ip !== undefined && ip !== '' && !isAllowedRouterIp(ip)) {
    return res.status(400).json({ error: 'ASUSのIPがプライベート範囲外です' });
  }
  if (yIp !== undefined && yIp !== '' && !isAllowedRouterIp(yIp)) {
    return res.status(400).json({ error: 'YamahaのIPがプライベート範囲外です' });
  }
  if (typeof username === 'string' && username.length > 64) {
    return res.status(400).json({ error: 'ユーザー名が長すぎます' });
  }
  if (typeof password === 'string' && password.length > 256) { // pragma: allowlist secret
    return res.status(400).json({ error: 'パスワードが長すぎます' });
  }

  // ── ASUS ──
  if (doAsus === true) {
    const effectivePass = password || (asus.hasPass() ? '' : '');
    // Re-read stored pass from config for fallback
    let storedPass = '';
    try { storedPass = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).asus?.pass || ''; } catch {}
    const finalPass = password || storedPass;
    if (!username || !finalPass) {
      return res.status(400).json({ error: 'ASUSルーターのユーザー名とパスワードを入力してください' });
    }
    try {
      const targetIp = ip || DEFAULT_ROUTER_IP;
      await asus.login(targetIp, username, finalPass);
      asus.startPolling(POLL_INTERVAL);
      saveConfig();
      persistSecret('asus', { ip: targetIp, user: username, pass: finalPass });
      console.log(`[auth] ASUS logged in as ${username} @ ${targetIp}`);
    } catch (err) {
      console.error('[auth] ASUS login failed:', err.message);
      return res.status(401).json({ error: 'ASUS認証失敗（IP・ユーザー名・パスワードを確認してください）' });
    }
  } else if (doAsus === false) {
    asus.disable();
    saveConfig();
    console.log('[auth] ASUS disabled');
  }

  // ── Yamaha ──
  if (doYamaha === true) {
    yamaha.configure({ enabled: true, ip: yIp || yamaha.getIp(), user: yUser || yamaha.getUser(), natDescriptor: yNat || undefined });
    // Persist Yamaha password
    if (yPass) {
      persistSecret('yamaha', { ip: yIp || yamaha.getIp(), user: yUser || yamaha.getUser(), pass: yPass, nat: yNat || '100', enabled: true });
      yamaha.configure({ pass: yPass });
    }
    yamaha.reconnect();
    saveConfig();
    console.log(`[auth] Yamaha config updated: ${yamaha.getIp()}`);
  } else if (doYamaha === false) {
    yamaha.disconnect();
    latestConnections = [];
    saveConfig();
    console.log('[auth] Yamaha disabled');
  }

  res.json({ success: true, routerIp: doAsus ? asus.getRouterIp() : undefined });
});

const ALLOWED_COUNTRIES = new Set([
  'JP','US','CA','GB','DE','FR','IT','ES','NL','SE','CH','NO',
  'AU','NZ','CN','KR','TW','HK','SG','IN','BR','RU',
]);
app.post('/api/config/general', requireAdmin, (req, res) => {
  const { homeCountry: hc, language: lang, autoInvestigate: ai, retentionDays: rd } = req.body;
  if (hc) {
    if (!ALLOWED_COUNTRIES.has(hc)) return res.status(400).json({ error: '無効な国コードです' });
    homeCountry = hc;
  }
  if (lang) {
    if (!['ja','en'].includes(lang)) return res.status(400).json({ error: 'invalid language' });
    uiLanguage = lang;
    notifier.configure({ language: lang });
  }
  if (typeof ai === 'boolean') {
    autoInvestigate = ai;
    if (ai) console.log('[auto-investigate] enabled');
    else    console.log('[auto-investigate] disabled');
  }
  if (rd && [7, 30, 90, 180, 365, 730].includes(Number(rd))) {
    retentionDays = Number(rd);
    history.setRetentionDays(retentionDays);
    console.log(`[config] Retention set to ${retentionDays} days`);
  }
  saveConfig();
  res.json({ success: true, homeCountry, language: uiLanguage, autoInvestigate, retentionDays });
});

app.get('/api/status', requireAdmin, (req, res) => {
  res.json({
    authenticated: asus.isAuthenticated(),
    routerIp: asus.getRouterIp(),
    enrichment: enrichment.getApiStats(),
  });
});

// Notes API
app.get('/api/notes', requireAdmin, (req, res) => res.json({ notes }));
app.post('/api/notes', requireAdmin, (req, res) => {
  const { ip, mac, note } = req.body || {};
  let key = '';
  if (ip && mac)      key = `${ip}|${mac}`;
  else if (ip)        key = ip;
  else if (mac)       key = mac;
  else if (req.body?.key) key = req.body.key;
  if (!isSafeNoteKey(key)) {
    return res.status(400).json({ error: 'invalid key (IP/MAC形式のみ)' });
  }
  if (typeof note === 'string') {
    const trimmed = note.trim().substring(0, 500);
    if (trimmed) {
      if (ip || mac) {
        for (const k of Object.keys(notes)) {
          const [kip, kmac] = k.split('|');
          if ((ip && kip === ip) || (mac && (kmac === mac || kip === mac))) delete notes[k];
        }
      }
      notes[key] = trimmed;
    } else {
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

// Investigation endpoint
app.post('/api/notes/draft', requireAdmin, async (req, res) => {
  const ip = req.body?.ip;
  if (!ip || !isAllowedRouterIp(ip)) {
    return res.status(400).json({ error: '有効なプライベートIPを指定してください' });
  }
  try {
    const result = await deviceId.investigateIp(ip, {
      ouiDb: deviceId.getOuiDb(),
      yamahaExec: yamaha.isReady() ? yamaha.yamahaExec : null,
      yamahaEnabled: yamaha.isEnabled(),
      yamahaReady: yamaha.isReady(),
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Connections history API ──────────────────────────────────────────────────

app.get('/api/connections', requireAdmin, (req, res) => {
  const from = req.query.from != null && req.query.from !== '' ? parseInt(req.query.from) : null;
  const to   = req.query.to   != null && req.query.to   !== '' ? parseInt(req.query.to)   : null;
  const connections = history.queryByTimeRange(from, to);
  res.json({ connections, serverTime: Date.now() });
});

// ─── Device Inventory API ────────────────────────────────────────────────────

app.get('/api/devices', requireAdmin, (req, res) => {
  const all = devices.getAll();
  // Attach current IPv6 addresses from NDP cache (keyed by MAC)
  for (const d of all) {
    if (d.mac) {
      const ipv6 = yamaha.getNdpByMac(d.mac);
      d.ipv6Addrs = ipv6 || null;
    } else {
      d.ipv6Addrs = null;
    }
  }
  res.json({ devices: all });
});

// ─── Backup / Restore API ─────────────────────────────────────────────────────

app.get('/api/backup/list', requireAdmin, (req, res) => {
  res.json({ backups: backup.listBackups(), config: backup.getConfig() });
});

app.post('/api/backup/create', requireAdmin, (req, res) => {
  const name = backup.createBackup();
  if (name) res.json({ success: true, name });
  else res.status(500).json({ error: 'Backup failed' });
});

app.get('/api/backup/download/:name', requireAdmin, (req, res) => {
  const p = backup.getBackupPath(req.params.name);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.download(p);
});

app.post('/api/backup/restore', requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Backup name required' });
  try {
    backup.restoreFromGeneration(name);
    // Reload history from restored DB
    history.loadConnectionHistory();
    knownMacs = history.getKnownMacs();
    res.json({ success: true, message: `Restored from ${name}. Restart recommended.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Data sources config API ──────────────────────────────────────────────────

app.get('/api/config/datasources', requireAdmin, (req, res) => {
  res.json({
    dnsmasq: { enabled: dnsmasqEnabled, logFile: dnsmasqLogFile },
    inspect: { enabled: inspectEnabled, logFile: inspectLogFile },
    dhcpd:   { enabled: dhcpdEnabled,   logFile: dhcpdLogFile   },
  });
});

app.post('/api/config/datasources', requireAdmin, (req, res) => {
  const { dnsmasq, inspect } = req.body || {};
  if (dnsmasq) {
    if (typeof dnsmasq.enabled === 'boolean') dnsmasqEnabled = dnsmasq.enabled;
    if (typeof dnsmasq.logFile === 'string' && dnsmasq.logFile.trim()) {
      dnsmasqLogFile = dnsmasq.logFile.trim();
    }
    dnsmasqLog.stop();
    dnsmasqLog.configure({
      logFile: dnsmasqLogFile,
      enabled: dnsmasqEnabled,
      onDnsQuery: ({ clientIp, domain, resolvedIp }) => {
        if (resolvedIp) {
          enrichment.getDnsCache().set(resolvedIp, {
            host: domain,
            expires: Date.now() + 5 * 60 * 1000,
            source: 'dnsmasq',
          });
        }
      },
    });
    if (dnsmasqEnabled) dnsmasqLog.start();
  }
  if (inspect) {
    if (typeof inspect.enabled === 'boolean') inspectEnabled = inspect.enabled;
    if (typeof inspect.logFile === 'string' && inspect.logFile.trim()) {
      inspectLogFile = inspect.logFile.trim();
    }
    inspectSyslog.stop();
    inspectSyslog.configure({ logFile: inspectLogFile, enabled: inspectEnabled, onSession: handleInspectSession });
    if (inspectEnabled) inspectSyslog.start();
  }
  const { dhcpd } = req.body || {};
  if (dhcpd) {
    if (typeof dhcpd.enabled === 'boolean') dhcpdEnabled = dhcpd.enabled;
    if (typeof dhcpd.logFile === 'string' && dhcpd.logFile.trim()) {
      dhcpdLogFile = dhcpd.logFile.trim();
    }
    dhcpdSyslog.stop();
    dhcpdSyslog.configure({ logFile: dhcpdLogFile, enabled: dhcpdEnabled });
    if (dhcpdEnabled) dhcpdSyslog.start();
  }
  saveConfig();
  res.json({
    success: true,
    dnsmasq: { enabled: dnsmasqEnabled, logFile: dnsmasqLogFile },
    inspect: { enabled: inspectEnabled, logFile: inspectLogFile },
    dhcpd:   { enabled: dhcpdEnabled,   logFile: dhcpdLogFile   },
  });
});

const UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

app.post('/api/backup/upload', requireAdmin, (req, res) => {
  // Accept raw body as DB file (max 100MB)
  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on('data', chunk => {
    if (aborted) return;
    received += chunk.length;
    if (received > UPLOAD_MAX_BYTES) {
      aborted = true;
      req.destroy();
      return res.status(413).json({ error: `File too large (max ${UPLOAD_MAX_BYTES / 1024 / 1024}MB)` });
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) return res.status(400).json({ error: 'File too small' });
      const tempPath = path.join(__dirname, '.widemap-upload-temp.db');
      fs.writeFileSync(tempPath, buf);
      backup.restoreFromFile(tempPath);
      fs.unlinkSync(tempPath);
      history.loadConnectionHistory();
      knownMacs = history.getKnownMacs();
      res.json({ success: true, message: 'Restored from uploaded file. Restart recommended.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.get('/api/config/slack', requireAdmin, (req, res) => {
  const cfg = notifier.getConfig();
  // Also return displayName from file (not held in notifier module)
  let displayName = '';
  try {
    const fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    displayName = fileCfg.slack?.displayName || '';
  } catch {}
  res.json({ config: { ...cfg, displayName } });
});

app.post('/api/config/slack', requireAdmin, (req, res) => {
  const { enabled, token, userId, cooldownMinutes, displayName } = req.body || {};
  notifier.configure({
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    token: typeof token === 'string' && token ? token : undefined,
    userId: typeof userId === 'string' ? userId : undefined,
    cooldownMinutes: typeof cooldownMinutes === 'number' ? cooldownMinutes : undefined,
  });
  // Persist sensitive/extra fields directly (getConfig() intentionally omits token)
  const slackUpdates = {};
  if (typeof token === 'string' && token) slackUpdates.token = token;
  if (typeof displayName === 'string') slackUpdates.displayName = displayName;
  if (Object.keys(slackUpdates).length) persistSecret('slack', slackUpdates);
  saveConfig();
  const fileCfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } })();
  res.json({ success: true, config: { ...notifier.getConfig(), displayName: fileCfg.slack?.displayName || '' } });
});

app.post('/api/slack/test', requireAdmin, async (req, res) => {
  const result = await notifier.test();
  if (result.ok) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

app.post('/api/slack/verify', requireAdmin, async (req, res) => {
  let { token } = req.body || {};
  // Fall back to stored token if not provided (token field shows "(保存済み)" but is empty)
  if (!token) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      token = cfg.slack?.token || '';
    } catch {}
  }
  const result = await notifier.verifyToken(token);
  res.json(result);
});

app.post('/api/slack/lookup-user', requireAdmin, async (req, res) => {
  let { username, token } = req.body || {};
  // If no token provided, use the stored one
  if (!token) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      token = cfg.slack?.token || '';
    } catch {}
  }
  const result = await notifier.lookupUser(username, token);
  res.json(result);
});

app.post('/api/backup/config', requireAdmin, (req, res) => {
  const { intervalHours, maxGenerations } = req.body || {};
  if (intervalHours) backup.configure({ intervalHours: Number(intervalHours) });
  if (maxGenerations) backup.configure({ maxGenerations: Number(maxGenerations) });
  backup.stopPeriodicBackup();
  backup.startPeriodicBackup();
  saveConfig();
  res.json({ success: true, config: backup.getConfig() });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
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
  socket.emit('config', {
    routerIp: asus.getRouterIp() || DEFAULT_ROUTER_IP,
    asusUser: asus.getUser(),
    asusPassSet: asus.hasPass(),
    authenticated: asus.isAuthenticated(),
    asusEnabled: asus.isEnabled(),
    yamahaEnabled: yamaha.isEnabled(),
    yamahaIp: yamaha.getIp(),
    yamahaUser: yamaha.getUser(),
    yamahaNat: yamaha.getNat(),
    yamahaPassSet: yamaha.hasPass(),
    yamahaReady: yamaha.isReady(),
    homeCountry,
    language: uiLanguage,
    autoInvestigate,
    retentionDays,
    notes,
    dnsmasqEnabled,
    dnsmasqLogFile,
    inspectEnabled,
    inspectLogFile,
    dhcpdEnabled,
    dhcpdLogFile,
  });
  if (asus.isEnabled() && !asus.isAuthenticated()) {
    socket.emit('auth-required', { message: 'セッションが切れています' });
  }
  const connectionHistory = history.getConnectionHistory();
  if (yamaha.isEnabled() && connectionHistory.size) {
    const connectCutoff = Date.now() - 86400_000;
    socket.emit('connections-update', {
      connections: [...connectionHistory.values()].filter(c => c.lastSeen >= connectCutoff),
      serverTime: Date.now(),
      partial: true,
    });
  }
});

// ─── Wire up poller callbacks ─────────────────────────────────────────────────
yamaha.configure({
  ip: process.env.YAMAHA_IP || '',
  user: process.env.YAMAHA_USER || '',
  pass: process.env.YAMAHA_PASS || '',
  natDescriptor: process.env.YAMAHA_NAT || '100',
  onStatus: (status) => io.emit('yamaha-status', status),
  onSaveConfig: saveConfig,
});

asus.configure({
  routerIp: DEFAULT_ROUTER_IP,
  onAuthRequired: (msg) => io.emit('auth-required', { message: msg }),
  onPollError: (msg) => io.emit('poll-error', { message: msg }),
  onNetworkUpdate: (data) => {
    // Attach IPv6 addresses from NDP cache (by MAC)
    for (const c of data.clients) {
      const ipv6 = yamaha.getNdpByMac(c.mac);
      c.ipv6Addrs = ipv6 || null;
    }
    io.emit('network-update', data);
    if (autoInvestigate) {
      for (const c of data.clients) {
        if (c.ip && c.mac) enqueueAutoInvestigation(c.ip, c.mac);
      }
    }
  },
  onSaveConfig: saveConfig,
  lookupVendor: deviceId.lookupVendor,
  getNodeMeta: deviceId.getNodeMeta,
});

// ─── Startup ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Widemap: http://localhost:${PORT}`);
  loadConfig();
  ensureAdminToken();
  loadNotes();
  history.setRetentionDays(retentionDays);
  history.loadConnectionHistory();
  knownMacs = history.getKnownMacs();
  devices.initDb();
  devices.seedFromConnectionHistory(history.getConnectionHistory());
  console.log(`Router IP: ${asus.getRouterIp()}`);
  deviceId.loadOuiDb();
  yamaha.connectYamaha(() => {
    yamaha.refreshYamahaArp().then(() => pollYamahaConnections());
  });
  dnsmasqLog.start();
  inspectSyslog.start();
  dhcpdSyslog.start();

  // Periodic snapshot/compaction
  setInterval(() => history.snapshotHistory(), 10 * 60 * 1000);
  setInterval(() => history.compactHistoryLog(), 30 * 60 * 1000);
  // Threat intel: fetch on startup and every hour
  threatIntel.fetchThreatIntel().then(() => {
    // Re-match all existing connections against freshly loaded threat feeds
    const connectionHistory = history.getConnectionHistory();
    let matched = 0;
    for (const [key, entry] of connectionHistory) {
      const host = entry.dstHost || entry.dst;
      const threat = threatIntel.matchThreatIntel(entry.dst, host);
      if (threat) { entry.threat = threat; matched++; }
      else { entry.threat = null; }
    }
    if (matched) console.log(`[threat-intel] Re-matched ${matched} existing connections`);
  });
  setInterval(() => threatIntel.fetchThreatIntel(), 60 * 60 * 1000);
  // Backup
  backup.startPeriodicBackup();
});

// Graceful shutdown
function shutdown() {
  console.log('[shutdown] Saving history...');
  try { history.snapshotHistory(); } catch {}
  try { history.closeDb(); } catch {}
  try { dnsmasqLog.stop(); } catch {}
  try { inspectSyslog.stop(); } catch {}
  try { dhcpdSyslog.stop(); } catch {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
