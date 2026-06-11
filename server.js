'use strict';

require('dotenv').config();
// Prefer IPv4 (prevents external HTTPS from stalling on IPv6, e.g. on EC2)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const { htmlEscape }  = require('./src/utils');
const enrichment      = require('./src/enrichment');
const history         = require('./src/history');
const deviceId        = require('./src/device-identify');
const threatIntel     = require('./src/threat-intel');
const notifier        = require('./src/notifier');
const backup          = require('./src/backup');
const yamaha          = require('./src/pollers/yamaha');
const asus            = require('./src/pollers/asus');
const dnsmasqLog      = require('./src/pollers/dnsmasq-log');
const inspectSyslog   = require('./src/pollers/inspect-syslog');
const dhcpdSyslog     = require('./src/pollers/dhcpd-syslog');
const devices         = require('./src/devices');

// ─── Extracted modules ────────────────────────────────────────────────────────
const notes          = require('./src/notes');
const configIo       = require('./src/config');       // file I/O only
const runtime        = require('./src/runtime');
const investigation  = require('./src/investigation');
const beacons        = require('./src/beacons');
const beaconDetector = require('./src/beacon-detector');

// ─── Route factories ──────────────────────────────────────────────────────────
const authRoutes        = require('./src/routes/auth');
const notesRoutes       = require('./src/routes/notes');
const connectionsRoutes = require('./src/routes/connections');
const devicesRoutes     = require('./src/routes/devices');
const backupRoutes      = require('./src/routes/backup');
const configRoutes      = require('./src/routes/config');
const slackRoutes       = require('./src/routes/slack');
const beaconsRoutes     = require('./src/routes/beacons');

// ─── Environment ──────────────────────────────────────────────────────────────
const SUBPATH           = (process.env.SUBPATH || '').replace(/\/$/, '');
const DEFAULT_ROUTER_IP = process.env.ROUTER_IP   || '192.168.1.1';
const POLL_INTERVAL     = parseInt(process.env.POLL_INTERVAL_MS || '60000');
const PORT              = parseInt(process.env.PORT || '3000');
const CONFIG_FILE       = path.join(__dirname, '.widemap.json');

// ─── Shared mutable state ─────────────────────────────────────────────────────
// Passed by reference to route modules so they can read and mutate it.
const appState = {
  adminToken:     '',
  homeCountry:    'JP',
  uiLanguage:     'ja',
  autoInvestigate: false,
  retentionDays:  730,
  dnsmasqEnabled: true,  dnsmasqLogFile: '/var/log/dnsmasq-queries.log',
  inspectEnabled: true,  inspectLogFile: '/var/log/yamaha-router.log',
  dhcpdEnabled:   true,  dhcpdLogFile:   '/var/log/yamaha-router.log',
};

// 差分 push 用タイムスタンプ: 前回 broadcast 以降に更新された接続だけを送信するため
let lastPollEmitTime = Date.now();

// ─── Express + Socket.IO setup ────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: false },
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    const host   = req.headers.host;
    if (!origin) return cb(null, true);
    try { const o = new URL(origin); cb(null, o.host === host); }
    catch { cb(null, false); }
  },
});

// ─── Config: load from / save to .widemap.json ───────────────────────────────

function loadConfig() {
  const data = configIo.loadFile(CONFIG_FILE);
  if (data.yamaha) {
    yamaha.configure({
      ip:            data.yamaha.ip      || '',
      user:          data.yamaha.user    || '',
      pass:          data.yamaha.pass    || '',
      enabled:       data.yamaha.enabled !== false,
      hostFp:        data.yamaha.hostFp  || '',
      natDescriptor: data.yamaha.nat     || '100',
    });
  }
  if (data.asus) {
    asus.configure({
      routerIp: data.asus.ip   || DEFAULT_ROUTER_IP,
      user:     data.asus.user || '',
      pass:     data.asus.pass || '',
      enabled:  data.asus.enabled ?? false,
    });
  }
  if (data.general?.homeCountry) appState.homeCountry = data.general.homeCountry;
  if (data.general?.language && ['ja', 'en'].includes(data.general.language)) appState.uiLanguage = data.general.language;
  if (typeof data.general?.autoInvestigate === 'boolean') appState.autoInvestigate = data.general.autoInvestigate;
  if (data.general?.retentionDays) appState.retentionDays = data.general.retentionDays;
  if (data.backup) {
    if (data.backup.intervalHours)  backup.configure({ intervalHours:  data.backup.intervalHours  });
    if (data.backup.maxGenerations) backup.configure({ maxGenerations: data.backup.maxGenerations });
  }
  if (data.slack)      notifier.configure({ ...data.slack, language: appState.uiLanguage });
  if (data.adminToken) appState.adminToken = data.adminToken;

  appState.dhcpdEnabled  = data.dhcpd?.enabled  !== false;
  appState.dhcpdLogFile  = data.dhcpd?.logFile   || '/var/log/yamaha-router.log';
  appState.inspectEnabled = data.inspect?.enabled !== false;
  appState.inspectLogFile = data.inspect?.logFile  || '/var/log/yamaha-router.log';
  appState.dnsmasqEnabled = data.dnsmasq?.enabled !== false;
  appState.dnsmasqLogFile = data.dnsmasq?.logFile  || '/var/log/dnsmasq-queries.log';

  dhcpdSyslog.configure({ logFile: appState.dhcpdLogFile, enabled: appState.dhcpdEnabled });
  inspectSyslog.configure({
    logFile:   appState.inspectLogFile,
    enabled:   appState.inspectEnabled,
    onSession: runtime.handleInspectSession,
  });
  dnsmasqLog.configure({
    logFile: appState.dnsmasqLogFile,
    enabled: appState.dnsmasqEnabled,
    onDnsQuery: ({ domain, resolvedIp }) => {
      if (resolvedIp) {
        enrichment.getDnsCache().set(resolvedIp, {
          host: domain, expires: Date.now() + 5 * 60 * 1000, source: 'dnsmasq',
        });
      }
    },
  });
  console.log('[config] Loaded:', CONFIG_FILE);
}

function saveConfig() {
  const data = {
    yamaha:  { ip: yamaha.getIp(), user: yamaha.getUser(), pass: '', enabled: yamaha.isEnabled(), hostFp: yamaha.getHostFp(), nat: yamaha.getNat() },
    asus:    { ip: asus.getRouterIp(), user: asus.getUser(), pass: '', enabled: asus.isEnabled() },
    general: { homeCountry: appState.homeCountry, language: appState.uiLanguage, autoInvestigate: appState.autoInvestigate, retentionDays: appState.retentionDays },
    backup:  backup.getConfig(),
    slack:   { ...notifier.getConfig(), tokenSet: undefined },
    adminToken: appState.adminToken,
    dnsmasq: { enabled: appState.dnsmasqEnabled, logFile: appState.dnsmasqLogFile },
    inspect: { enabled: appState.inspectEnabled, logFile: appState.inspectLogFile },
    dhcpd:   { enabled: appState.dhcpdEnabled,   logFile: appState.dhcpdLogFile   },
  };
  // Re-read to preserve passwords (not held in module state getters)
  try {
    const existing = configIo.loadFile(CONFIG_FILE);
    if (existing.yamaha?.pass) data.yamaha.pass = existing.yamaha.pass;
    if (existing.asus?.pass)   data.asus.pass   = existing.asus.pass;
    if (existing.slack?.token) data.slack.token = existing.slack.token;
  } catch {}
  try {
    configIo.saveFile(data, CONFIG_FILE);
    console.log('[config] Saved:', CONFIG_FILE);
  } catch (e) {
    console.error('[config] Save failed:', e.message);
  }
}

function ensureAdminToken() {
  if (!appState.adminToken) {
    appState.adminToken = crypto.randomBytes(24).toString('hex');
    saveConfig();
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  Widemap admin token (initial):');
    console.log('  ' + appState.adminToken);
    console.log('  → ブラウザ初回アクセス時にこのトークンを入力してください');
    console.log('══════════════════════════════════════════════════════════════\n');
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const provided = req.get('X-Admin-Token') || '';
  if (!appState.adminToken) return res.status(503).json({ error: '管理トークン未初期化' });
  const a = Buffer.from(provided);
  const b = Buffer.from(appState.adminToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '管理トークン不正' });
  }
  next();
}

// ─── Yamaha polling loop ──────────────────────────────────────────────────────

// Track session keys seen in the previous poll to detect newly-appeared sessions
// (used for poll-based beacon event recording when [INSPECT] is unavailable).
let lastPollKeys = new Set();

async function pollYamahaConnections() {
  if (!yamaha.isEnabled() || !yamaha.isReady()) return;
  try {
    const sessions = await yamaha.fetchNatSessions();
    console.log(`[yamaha] ${sessions.length} sessions parsed`);

    const unique = [...new Set(sessions.map(s => s.dst))];
    await Promise.allSettled(unique.map(ip => enrichment.reverseDns(ip)));
    await enrichment.lookupRdapBatch(unique);   // throttled: 5並列ずつ処理
    await enrichment.lookupGeoBatch(unique);

    const now = Date.now();
    if (yamaha.needsArpRefresh()) await yamaha.refreshYamahaArp();
    if (yamaha.needsNdpRefresh()) {
      await yamaha.refreshYamahaNdp();
      for (const [ip, mac] of yamaha.getArpCache()) {
        const ipv6 = yamaha.getNdpByMac(mac);
        if (ipv6 && ipv6.length) {
          devices.observeDevice({ ip, mac, ipv6Addr: ipv6[0], lastSeen: Date.now(), source: 'ndp' });
        }
      }
    }

    sessions.forEach(s => runtime.recordConnection(s, now));

    // Poll-based beacon event recording: only used as fallback when INSPECT syslog is
    // disabled.  When inspectEnabled=true, INSPECT provides precise TCP session-close
    // timestamps; writing poll events on top would duplicate observations with ±60 s
    // precision and skew the CoV calculation.
    // lastPollKeys is updated unconditionally so the delta is accurate when the setting toggles.
    const currentPollKeys = new Set(sessions.map(s => `${s.src}|${s.dst}|${s.dport}|${s.proto}`));
    if (!appState.inspectEnabled) {
      for (const s of sessions) {
        const key = `${s.src}|${s.dst}|${s.dport}|${s.proto}`;
        if (!lastPollKeys.has(key)) {
          const entry = history.getConnectionHistory().get(key);
          beacons.appendEvent({
            src: s.src, dst: s.dst,
            dstHost: entry?.dstHost || s.dst,
            dport: s.dport, proto: s.proto,
            seenAt: now, source: 'poll',
          });
        }
      }
    }
    lastPollKeys = currentPollKeys;

    history.pruneHistory();

    // 差分 push: 前回 emit 以降に lastSeen が更新されたエントリのみ送信
    const deltaConns = [...history.getConnectionHistory().values()]
      .filter(c => c.lastSeen > lastPollEmitTime);
    lastPollEmitTime = now;
    if (deltaConns.length > 0) {
      io.emit('connections-update', {
        connections: deltaConns,
        serverTime:  now,
        partial:     true,
        delta:       true,
      });
      console.log(`[yamaha] emit delta: ${deltaConns.length} connections (of ${history.getConnectionHistory().size} total)`);
    } else {
      console.log('[yamaha] emit delta: 0 changes, skipped');
    }

    if (appState.autoInvestigate) {
      const srcIps = [...new Set(sessions.map(s => s.src))];
      for (const ip of srcIps) investigation.enqueue(ip, runtime.resolveMacByIp(ip));
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

// ─── Express middleware ───────────────────────────────────────────────────────

app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const baseScript = `<script>window.BASE_URL = '${htmlEscape(SUBPATH)}';</script>`;
  res.type('html').send(
    html.replace('</head>', baseScript + '\n</head>')
        .replace(/__BASE__/g, htmlEscape(SUBPATH))
  );
});
// Serve static assets at both root and SUBPATH (for deployments behind a subpath proxy)
if (SUBPATH) app.use(SUBPATH, express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '64kb' }));

// ─── Threat intel re-match + client notification ──────────────────────────────
// Called after fetchThreatIntel() completes (startup + hourly refresh).
// Re-evaluates threat field for all in-memory connections, then pushes a
// partial connections-update so connected clients see updated threat badges
// without needing to manually trigger an API fetch.

function reMatchAndNotify() {
  const connectionHistory = history.getConnectionHistory();
  const updated = [];
  for (const [, entry] of connectionHistory) {
    const host     = entry.dstHost || entry.dst;
    const threat   = threatIntel.matchThreatIntel(entry.dst, host);
    const newThreat = threat || null;
    if (JSON.stringify(entry.threat) !== JSON.stringify(newThreat)) {
      entry.threat = newThreat;
      updated.push(entry);
    }
  }
  if (updated.length) {
    console.log(`[threat-intel] Re-matched ${updated.length} connections, notifying clients`);
    io.emit('connections-update', { connections: updated, serverTime: Date.now(), partial: true, delta: true });
  } else {
    console.log('[threat-intel] Re-match complete, no threat changes');
  }
}

// ─── Mount routes ─────────────────────────────────────────────────────────────

const routeCtx = {
  requireAdmin,
  getAdminToken:       () => appState.adminToken,
  asus, yamaha, enrichment, threatIntel, notifier, history, devices, deviceId, backup,
  dnsmasqLog, inspectSyslog, dhcpdSyslog,
  runtime, notes, io, beacons,
  saveConfig,
  persistSecret:       (section, updates) => configIo.persistSecret(section, updates, CONFIG_FILE),
  configFile:          CONFIG_FILE,
  fs,
  DEFAULT_ROUTER_IP, POLL_INTERVAL,
  appState,
  appRoot:             __dirname,
  setLatestConnections: () => {},  // Yamaha disabled clears in-memory session list
};

app.use('/api', authRoutes(routeCtx));
app.use('/api', notesRoutes(routeCtx));
app.use('/api', connectionsRoutes(routeCtx));
app.use('/api', devicesRoutes(routeCtx));
app.use('/api', backupRoutes({ ...routeCtx, saveConfig }));
app.use('/api', configRoutes(routeCtx));
app.use('/api', slackRoutes(routeCtx));
app.use('/api', beaconsRoutes({ requireAdmin, beacons }));

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  const provided = socket.handshake.auth?.token || '';
  if (!appState.adminToken) return next(new Error('管理トークン未初期化'));
  const a = Buffer.from(String(provided));
  const b = Buffer.from(appState.adminToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new Error('Unauthorized'));
  next();
});

io.on('connection', socket => {
  console.log('[ws] Client connected:', socket.id);
  socket.emit('config', {
    routerIp:       asus.getRouterIp() || DEFAULT_ROUTER_IP,
    asusUser:       asus.getUser(),
    asusPassSet:    asus.hasPass(),
    authenticated:  asus.isAuthenticated(),
    asusEnabled:    asus.isEnabled(),
    yamahaEnabled:  yamaha.isEnabled(),
    yamahaIp:       yamaha.getIp(),
    yamahaUser:     yamaha.getUser(),
    yamahaNat:      yamaha.getNat(),
    yamahaPassSet:  yamaha.hasPass(),
    yamahaReady:    yamaha.isReady(),
    homeCountry:    appState.homeCountry,
    language:       appState.uiLanguage,
    autoInvestigate: appState.autoInvestigate,
    retentionDays:  appState.retentionDays,
    notes:          notes.getAll(),
    dnsmasqEnabled: appState.dnsmasqEnabled,
    dnsmasqLogFile: appState.dnsmasqLogFile,
    inspectEnabled: appState.inspectEnabled,
    inspectLogFile: appState.inspectLogFile,
    dhcpdEnabled:   appState.dhcpdEnabled,
    dhcpdLogFile:   appState.dhcpdLogFile,
  });
  if (asus.isEnabled() && !asus.isAuthenticated()) {
    socket.emit('auth-required', { message: 'セッションが切れています' });
  }
  const connectionHistory = history.getConnectionHistory();
  if (yamaha.isEnabled() && connectionHistory.size) {
    // Initial emit: last 1h only — fast first render. Client fetches full 24h
    // in the background via GET /api/connections after the initial paint.
    const cutoff = Date.now() - 3_600_000; // 1h
    socket.emit('connections-update', {
      connections: [...connectionHistory.values()].filter(c => c.lastSeen >= cutoff),
      serverTime:  Date.now(),
      partial:     true,
      initialLoad: true,
    });
  }
});

// ─── Wire up poller callbacks ─────────────────────────────────────────────────

runtime.init({
  io, history, enrichment, threatIntel, notifier, deviceId, devices,
  asus, yamaha, dhcpdSyslog, beacons,
});

investigation.init({
  notes, io, yamaha, asus, deviceId,
  getAutoInvestigate: () => appState.autoInvestigate,
});

yamaha.configure({
  ip:            process.env.YAMAHA_IP   || '',
  user:          process.env.YAMAHA_USER || '',
  pass:          process.env.YAMAHA_PASS || '',
  natDescriptor: process.env.YAMAHA_NAT  || '100',
  onStatus:      (status) => io.emit('yamaha-status', status),
  onSaveConfig:  saveConfig,
});

asus.configure({
  routerIp:       DEFAULT_ROUTER_IP,
  onAuthRequired: (msg)  => io.emit('auth-required', { message: msg }),
  onPollError:    (msg)  => io.emit('poll-error',    { message: msg }),
  onNetworkUpdate: (data) => {
    // Deduplicate by IP: ASUS sometimes returns multiple entries for the same IP
    // (e.g. AiMesh node + main router, or 2.4GHz + 5GHz transient overlap).
    // Keep the entry with the strongest RSSI; this prevents vendor/asusName from
    // flip-flopping on every poll and causing observation count explosion.
    const byIp = new Map();
    for (const c of data.clients) {
      if (!c.ip) continue;
      const prev = byIp.get(c.ip);
      if (!prev || (c.rssi || 0) > (prev.rssi || 0)) byIp.set(c.ip, c);
    }
    for (const c of byIp.values()) {
      const ipv6 = yamaha.getNdpByMac(c.mac);
      c.ipv6Addrs = ipv6 || null;
      devices.observeDevice({
        ip: c.ip, mac: c.mac || null, vendor: c.vendor || null,
        mdnsName: c.mdnsName || null, dnsName: c.dnsName || null,
        ipv6Addr: (ipv6 && ipv6[0]) || null,
        asusName: c.name || null,
        lastSeen: Date.now(), source: 'asus',
      });
    }
    io.emit('network-update', data);
    if (appState.autoInvestigate) {
      for (const c of data.clients) {
        if (c.ip && c.mac) investigation.enqueue(c.ip, c.mac);
      }
    }
  },
  onSaveConfig:  saveConfig,
  lookupVendor:  deviceId.lookupVendor,
  getNodeMeta:   deviceId.getNodeMeta,
});

dhcpdSyslog.configure({
  onLease: ({ ip, mac }) => {
    devices.observeDevice({ ip, mac, lastSeen: Date.now(), source: 'dhcp' });
  },
});

// ─── Startup ──────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Widemap: http://localhost:${PORT}`);
  loadConfig();
  ensureAdminToken();
  notes.load();
  history.setRetentionDays(appState.retentionDays);
  history.loadConnectionHistory();
  runtime.setKnownMacs(history.getKnownMacs());
  devices.initDb();
  devices.seedFromConnectionHistory(history.getConnectionHistory());
  const staleChecked = devices.checkStaleMergeCandidates();
  if (staleChecked > 0) {
    console.log(`[devices] stale merge check: ${staleChecked} device(s) scanned for duplicates`);
  }
  enrichment.initDb();
  beacons.initDb();
  console.log(`Router IP: ${asus.getRouterIp()}`);
  deviceId.loadOuiDb();
  yamaha.connectYamaha(() => {
    yamaha.refreshYamahaArp().then(() => pollYamahaConnections());
  });
  dnsmasqLog.start();
  inspectSyslog.start();
  dhcpdSyslog.start();

  setInterval(() => history.snapshotHistory(),    10 * 60 * 1000);
  setInterval(() => history.compactHistoryLog(),  30 * 60 * 1000);

  threatIntel.fetchThreatIntel().then(() => {
    reMatchAndNotify();
  });
  setInterval(() => threatIntel.fetchThreatIntel().then(reMatchAndNotify), 60 * 60 * 1000);

  // Beacon detection: scan hourly, prune stale events
  function runBeaconScan() {
    const events     = beacons.getEvents();
    const candidates = beaconDetector.detectBeacons(events);
    for (const c of candidates) beacons.upsertBeacon(c);
    const pruned = beacons.pruneEvents();
    console.log(`[beacons] scan: ${candidates.length} candidate(s) from ${events.length} events (pruned ${pruned} old events)`);
  }
  setInterval(runBeaconScan, 60 * 60 * 1000);

  backup.startPeriodicBackup();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  console.log('[shutdown] Saving history...');
  try { history.snapshotHistory(); } catch {}
  try { history.closeDb();         } catch {}
  try { dnsmasqLog.stop();         } catch {}
  try { inspectSyslog.stop();      } catch {}
  try { dhcpdSyslog.stop();        } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
