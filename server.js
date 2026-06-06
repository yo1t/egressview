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
const yamaha = require('./src/pollers/yamaha');
const asus = require('./src/pollers/asus');

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
let latestConnections = [];

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
      });
    }
    if (data.asus) {
      asus.configure({
        routerIp: data.asus.ip || DEFAULT_ROUTER_IP,
        user: data.asus.user || '',
        pass: data.asus.pass || '',
      });
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
    yamaha: { ip: yamaha.getIp(), user: yamaha.getUser(), pass: process.env.YAMAHA_PASS || '', enabled: yamaha.isEnabled(), hostFp: yamaha.getHostFp() },
    asus: { ip: asus.getRouterIp(), user: asus.getUser(), pass: '' },
    general: { homeCountry, language: uiLanguage, autoInvestigate },
    adminToken,
  };
  // Re-read to preserve passwords (they are not stored in module state getters)
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (existing.yamaha?.pass) data.yamaha.pass = existing.yamaha.pass;
    if (existing.asus?.pass) data.asus.pass = existing.asus.pass;
  } catch {}
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    console.log('[config] Saved:', CONFIG_FILE);
  } catch (e) {
    console.error('[config] Save failed:', e.message);
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
  return yamaha.getArpMac(ip);
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

    const connectionHistory = history.getConnectionHistory();
    latestConnections = sessions.map(s => {
      const host = enrichment.getDnsCache().get(s.dst)?.host || s.dst;
      const rdap = enrichment.getRdapCache().get(s.dst);
      const geo  = enrichment.getGeoCache().get(s.dst);
      const srcMac = resolveMacByIp(s.src);
      const srcMeta = deviceId.getNodeMeta(s.src, srcMac);
      const enriched = {
        ...s,
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
        threat:  threatIntel.matchThreatIntel(s.dst, host) || null,
      };
      const key = `${s.src}|${s.dst}|${s.dport}|${s.proto}`;
      const existing = connectionHistory.get(key);
      const isNew = !existing;
      const entry = { ...enriched, firstSeen: existing?.firstSeen ?? now, lastSeen: now };
      connectionHistory.set(key, entry);
      if (isNew) history.appendHistoryLog(entry);
      return entry;
    });

    history.pruneHistory();

    io.emit('connections-update', {
      connections: [...connectionHistory.values()],
      serverTime: now,
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
          yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass } = req.body;
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
  if (typeof password === 'string' && password.length > 256) {
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
      // Persist ASUS password
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        cfg.asus = cfg.asus || {};
        cfg.asus.ip = targetIp;
        cfg.asus.user = username;
        cfg.asus.pass = finalPass;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      } catch {}
      console.log(`[auth] ASUS logged in as ${username} @ ${targetIp}`);
    } catch (err) {
      console.error('[auth] ASUS login failed:', err.message);
      return res.status(401).json({ error: 'ASUS認証失敗（IP・ユーザー名・パスワードを確認してください）' });
    }
  } else if (doAsus === false) {
    asus.disable();
    console.log('[auth] ASUS disabled');
  }

  // ── Yamaha ──
  if (doYamaha === true) {
    yamaha.configure({ enabled: true, ip: yIp || yamaha.getIp(), user: yUser || yamaha.getUser() });
    // Persist Yamaha password
    if (yPass) {
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        cfg.yamaha = cfg.yamaha || {};
        cfg.yamaha.ip = yIp || yamaha.getIp();
        cfg.yamaha.user = yUser || yamaha.getUser();
        cfg.yamaha.pass = yPass;
        cfg.yamaha.enabled = true;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      } catch {}
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
  const { homeCountry: hc, language: lang, autoInvestigate: ai } = req.body;
  if (hc) {
    if (!ALLOWED_COUNTRIES.has(hc)) return res.status(400).json({ error: '無効な国コードです' });
    homeCountry = hc;
  }
  if (lang) {
    if (!['ja','en'].includes(lang)) return res.status(400).json({ error: 'invalid language' });
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
  res.json({ authenticated: asus.isAuthenticated(), routerIp: asus.getRouterIp() });
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
    yamahaPassSet: yamaha.hasPass(),
    yamahaReady: yamaha.isReady(),
    homeCountry,
    language: uiLanguage,
    autoInvestigate,
    notes,
  });
  if (asus.isEnabled() && !asus.isAuthenticated()) {
    socket.emit('auth-required', { message: 'セッションが切れています' });
  }
  const connectionHistory = history.getConnectionHistory();
  if (yamaha.isEnabled() && connectionHistory.size) {
    socket.emit('connections-update', {
      connections: [...connectionHistory.values()],
      serverTime: Date.now(),
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
  history.loadConnectionHistory();
  console.log(`Router IP: ${asus.getRouterIp()}`);
  deviceId.loadOuiDb();
  yamaha.connectYamaha(() => {
    yamaha.refreshYamahaArp().then(() => pollYamahaConnections());
  });

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
});

// Graceful shutdown
function shutdown() {
  console.log('[shutdown] Saving history...');
  try { history.snapshotHistory(); } catch {}
  try { history.closeDb(); } catch {}
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
