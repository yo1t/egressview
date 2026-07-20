'use strict';

require('dotenv').config();
// Prefer IPv4 (prevents external HTTPS from stalling on IPv6, e.g. on EC2)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

const express     = require('express');
const http        = require('http');
const https   = require('https');
const { Server } = require('socket.io');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const utils           = require('./src/utils');
const { htmlEscape }  = utils;
const logger          = require('./src/logger');
const runtimeProfiler = require('./src/runtime-profiler');
const { resolvePollInterval } = require('./src/runtime-settings');
const enrichment      = require('./src/enrichment');
const history         = require('./src/history');
const deviceId        = require('./src/device-identify');
const threatIntel     = require('./src/threat-intel');
const { manualThreatLookup } = require('./src/manual-threat-lookup');
const { aiProvider }  = require('./src/ai-provider');
const notifier        = require('./src/notifier');
const i18n            = require('./src/i18n-server');
const backup          = require('./src/backup');
const yamaha          = require('./src/pollers/yamaha-adapter');
const cisco           = require('./src/pollers/cisco-adapter');
const asus            = require('./src/pollers/asus');
const dnsmasqLog      = require('./src/pollers/dnsmasq-log');
const inspectSyslog   = require('./src/pollers/inspect-syslog');
const dhcpdSyslog     = require('./src/pollers/dhcpd-syslog');
const devices         = require('./src/devices');

// ─── Extracted modules ────────────────────────────────────────────────────────
const notes          = require('./src/notes');
const configIo       = require('./src/config');       // file I/O only
const runtime        = require('./src/runtime');
const pollScheduler  = require('./src/poll-scheduler');
const investigation  = require('./src/investigation');
const beacons        = require('./src/beacons');
const beaconDetector = require('./src/beacon-detector');
const sessions       = require('./src/sessions');
const authPassword   = require('./src/auth-password');
const { runDbBootstrap }    = require('./src/db-bootstrap');
const { sourceRouterIdMap } = require('./src/router-id');
const { createDefaultAppState, applyConfigToAppState } = require('./src/app-state');
const enrichmentQueue = require('./src/enrichment-queue');
const beaconScanRunner = require('./src/beacon-scan-runner');
const { configureHttpApp } = require('./src/http-app');
const { createHealthState } = require('./src/health-state');
const { registerSocketHandlers } = require('./src/socket-handlers');
const { migrateRouterConfigFile, loadRouterConfig, publicRouter } = require('./src/router-config');
const { createRouterManager } = require('./src/router-manager');

// ─── Environment ──────────────────────────────────────────────────────────────
const SUBPATH           = (process.env.SUBPATH || '').replace(/\/$/, '');
const DEFAULT_ROUTER_IP = process.env.ROUTER_IP   || '192.168.1.1';
const POLL_INTERVAL     = resolvePollInterval(process.env.POLL_INTERVAL_MS, logger);
// PORT is resolved after the early config read below (env > config file > 3000)
let PORT = parseInt(process.env.PORT || '3000');
const CONFIG_FILE       = process.env.EGRESSVIEW_CONFIG_PATH
  ? path.resolve(process.env.EGRESSVIEW_CONFIG_PATH)
  : require('./src/config').DEFAULT_CONFIG_FILE;

// Demo mode: pre-seeds sample data and uses a fixed token so the app can be
// explored without real router hardware (used in CI for Playwright smoke tests).
const DEMO_MODE       = process.env.DEMO_MODE === 'true';
const DEMO_ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN || 'demo-token-ci';
const DEMO_DB_PATH         = path.join(__dirname, '.egressview.demo.db');
const DEMO_RUNTIME_DB_PATH = path.join(__dirname, '.egressview.demo.runtime.db');
const DEMO_BACKUP_DIR      = path.join(__dirname, '.egressview-demo-backups');
const _rawAssetVersion = process.env.EGRESSVIEW_ASSET_VERSION || '';
const ASSET_VERSION    = /^[A-Za-z0-9._-]+$/.test(_rawAssetVersion) ? _rawAssetVersion : (() => {
  if (_rawAssetVersion) console.warn(`[server] EGRESSVIEW_ASSET_VERSION contains invalid characters ('${_rawAssetVersion}'); falling back to timestamp.`);
  return String(Date.now());
})();


// ─── Shared mutable state ─────────────────────────────────────────────────────
// Passed by reference to route modules so they can read and mutate it.
const appState = createDefaultAppState();
const healthState = createHealthState();
let routerConfigState = { routers: [], tombstones: [], migrated: false };
let routerManager = null;
const routerManagerApi = {
  list: () => routerManager?.list() || routerConfigState.routers.map(router => publicRouter(router)),
  detect: input => {
    if (!routerManager) throw new Error('router manager is not ready');
    return routerManager.detect(input);
  },
  upsert: input => {
    if (!routerManager) throw new Error('router manager is not ready');
    return routerManager.upsert(input);
  },
  remove: id => routerManager?.remove(id) || false,
};

// ─── Express + Socket.IO setup ────────────────────────────────────────────────
const app = express();

// HTTPS opt-in (P2-22): the protocol must be decided before the server is
// created, so read just the https section of the config file early.
// Default is HTTP — self-signed certs trigger browser warnings, so HTTPS
// stays opt-in (same trade-off as comparable home-lab tools).
const tls = require('./src/tls');
let tlsOptions = null;
{
  const early = configIo.loadFileOrThrow(CONFIG_FILE);
  if (early.https?.enabled) {
    tlsOptions = tls.loadOrCreate(early.https, __dirname);
    if (!tlsOptions) logger.warn('[tls] HTTPS requested but unavailable — falling back to HTTP');
  }
  // Allow port to be set in config file; env var takes precedence
  if (!process.env.PORT && Number.isFinite(parseInt(early.port))) {
    PORT = parseInt(early.port);
  }
}
const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
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

// ─── Config: load from / save to config file ─────────────────────────────────

function loadConfig() {
  routerConfigState = migrateRouterConfigFile(CONFIG_FILE);
  const data = configIo.loadFileOrThrow(CONFIG_FILE);
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
  if (data.cisco) {
    cisco.configure({
      ip:         data.cisco.ip         || '',
      user:       data.cisco.user       || '',
      pass:       data.cisco.pass       || '',
      enablePass: data.cisco.enablePass || '',
      enabled:    data.cisco.enabled === true,
      hostFp:     data.cisco.hostFp    || '',
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
  if (data.backup) {
    if (data.backup.intervalHours)  backup.configure({ intervalHours:  data.backup.intervalHours  });
    if (data.backup.maxGenerations) backup.configure({ maxGenerations: data.backup.maxGenerations });
    if (Number.isInteger(data.backup.maxBackupBytes) && data.backup.maxBackupBytes >= 0) {
      backup.configure({ maxBackupBytes: data.backup.maxBackupBytes });
    }
    if (typeof data.backup.autoPrune === 'boolean') {
      backup.configure({ autoPrune: data.backup.autoPrune });
    }
  }
  applyConfigToAppState(appState, data, { isAllowedLogPath: utils.isAllowedLogPath, logger });
  if (data.slack) notifier.configure({ ...data.slack, language: appState.uiLanguage });
  if (data.manualThreat) manualThreatLookup.configure(data.manualThreat);
  if (data.ai) aiProvider.configure(data.ai);
  i18n.setLanguage(appState.uiLanguage);

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
  logger.info('[config] Loaded:', CONFIG_FILE);
}

function saveConfig(sectionOverrides = {}) {
  const existing = configIo.loadFileOrThrow(CONFIG_FILE);
  const data = {
    ...existing,
    yamaha:  { ip: yamaha.getIp(), user: yamaha.getUser(), pass: '', enabled: yamaha.isEnabled(), hostFp: yamaha.getHostFp(), nat: yamaha.getNat() },
    cisco:   { ip: cisco.getIp(), user: cisco.getUser(), pass: '', enablePass: '', enabled: cisco.isEnabled(), hostFp: cisco.getHostFp() },
    asus:    { ip: asus.getRouterIp(), user: asus.getUser(), pass: '', enabled: asus.isEnabled() },
    general: { homeCountry: appState.homeCountry, language: appState.uiLanguage, autoInvestigate: appState.autoInvestigate, retentionDays: appState.retentionDays },
    backup:  backup.getConfig(),
    slack:   { ...notifier.getConfig(), tokenSet: undefined },
    adminToken: appState.adminToken,
    dnsmasq: { enabled: appState.dnsmasqEnabled, logFile: appState.dnsmasqLogFile },
    inspect: { enabled: appState.inspectEnabled, logFile: appState.inspectLogFile },
    dhcpd:   { enabled: appState.dhcpdEnabled,   logFile: appState.dhcpdLogFile   },
    beacons: appState.beaconConfig,
    https:   { enabled: appState.httpsEnabled, certPath: appState.httpsCertPath, keyPath: appState.httpsKeyPath },
    auth:    { passwordHash: appState.authPasswordHash, salt: appState.authPasswordSalt },
    manualThreat: manualThreatLookup.exportConfig(),
    ai:       aiProvider.exportConfig(),
  };
  // Preserve passwords from the strict read above (not held in module getters).
  try {
    if (existing.yamaha?.pass) data.yamaha.pass = existing.yamaha.pass;
    if (existing.cisco?.pass)  { data.cisco.pass = existing.cisco.pass; data.cisco.enablePass = existing.cisco.enablePass || ''; }
    if (existing.asus?.pass)   data.asus.pass   = existing.asus.pass;
    if (existing.slack?.token) data.slack.token = existing.slack.token;
  } catch {}
  for (const section of ['yamaha', 'cisco', 'asus', 'slack']) {
    if (sectionOverrides[section]) {
      data[section] = { ...data[section], ...sectionOverrides[section] };
    }
  }
  configIo.saveFile(data, CONFIG_FILE);
  logger.info('[config] Saved:', CONFIG_FILE);
}

function persistRouterConfigs(routers, tombstones) {
  const data = configIo.loadFileOrThrow(CONFIG_FILE);
  configIo.saveFile({ ...data, routers, routerTombstones: tombstones }, CONFIG_FILE);
  routerConfigState = loadRouterConfig({ ...data, routers, routerTombstones: tombstones });
}

function ensureAdminToken() {
  if (!appState.adminToken) {
    appState.adminToken = crypto.randomBytes(24).toString('hex');
    saveConfig();
    process.stderr.write('\n══════════════════════════════════════════════════════════════\n');
    process.stderr.write('  EgressView admin token (initial):\n');
    process.stderr.write('  ' + appState.adminToken + '\n');
    process.stderr.write('  → API/自動化用トークン（ブラウザはパスワードでログイン）\n');
    process.stderr.write('══════════════════════════════════════════════════════════════\n\n');
  }
}

function ensureLoginPassword() {
  if (!appState.authPasswordHash) {
    const initial = authPassword.generateInitialPassword();
    const { salt, hash } = authPassword.hashPassword(initial);
    appState.authPasswordSalt = salt;
    appState.authPasswordHash = hash;
    saveConfig();
    process.stderr.write('\n══════════════════════════════════════════════════════════════\n');
    process.stderr.write('  EgressView login password (initial):\n');
    process.stderr.write('  ' + initial + '\n');
    process.stderr.write('  → ブラウザ初回アクセス時にこのパスワードでログインしてください\n');
    process.stderr.write('    （設定画面からいつでも変更できます）\n');
    process.stderr.write('══════════════════════════════════════════════════════════════\n\n');
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// A request is authorized when the X-Admin-Token header carries either
//   (a) a per-device session token issued by password login, or
//   (b) the admin token (kept as an API/automation credential).
// Returns the matching session row for (a), the string 'admin' for (b),
// or null.  The same check covers Socket.IO handshakes.
function authenticate(provided) {
  if (!provided) return null;
  const session = sessions.verifySession(provided);
  if (session) return session;
  if (appState.adminToken) {
    const a = Buffer.from(provided);
    const b = Buffer.from(appState.adminToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'admin';
  }
  return null;
}

function requireAdmin(req, res, next) {
  if (!appState.adminToken) return res.status(503).json({ error: '認証未初期化' });
  const auth = authenticate(req.get('X-Admin-Token') || '');
  if (!auth) return res.status(401).json({ error: '認証エラー' });
  req.session = auth === 'admin' ? null : auth;  // session row for login sessions
  next();
}

// ─── Connection enrichment queue ──────────────────────────────────────────────
// The poll loops themselves live in src/poll-scheduler.js (extracted in P2-23).
// The queue itself now lives in src/enrichment-queue.js as the second step of
// P2-26, keeping server.js focused on bootstrap and dependency wiring.

// ─── Threat intel re-match + client notification ──────────────────────────────
// Called after fetchThreatIntel() completes (startup + hourly refresh).
// Re-evaluates threat field for all in-memory connections, then pushes a
// partial connections-update so connected clients see updated threat badges
// without needing to manually trigger an API fetch.

async function reMatchAndNotify() {
  const startedAt = Date.now();
  const connectionHistory = history.getConnectionHistory();
  const updated = [];
  const CHUNK = 5000;
  let processed = 0;
  for (const [, entry] of connectionHistory) {
    const host     = entry.dstHost || entry.dst;
    const threat   = threatIntel.matchThreatIntel(entry.dst, host);
    const newThreat = threat || null;
    if (JSON.stringify(entry.threat) !== JSON.stringify(newThreat)) {
      entry.threat = newThreat;
      updated.push(entry);
    }
    if (++processed % CHUNK === 0) {
      await new Promise(r => setImmediate(r));
    }
  }
  if (updated.length) {
    logger.info(`[threat-intel] Re-matched ${updated.length} connections, notifying clients`);
    io.emit('connections-update', { connections: updated, serverTime: Date.now(), partial: true, delta: true });
  } else {
    logger.debug('[threat-intel] Re-match complete, no threat changes');
  }
  runtimeProfiler.recordWall('threatIntel.reMatch', Date.now() - startedAt);
}

// ─── Beacon detection scan ────────────────────────────────────────────────────

const routeCtx = {
  requireAdmin,
  getAdminToken:       () => appState.adminToken,
  asus, yamaha, cisco, enrichment, threatIntel, notifier, history, devices, deviceId, backup,
  dnsmasqLog, inspectSyslog, dhcpdSyslog,
  runtime, notes, io, beacons, sessions, authPassword,
  saveConfig,
  loadConfig:          () => configIo.loadFileSafe(CONFIG_FILE),
  configFile:          CONFIG_FILE,
  fs,
  DEFAULT_ROUTER_IP, POLL_INTERVAL,
  appState,
  appRoot:             __dirname,
  setLatestConnections: () => {},  // Yamaha disabled clears in-memory session list
  startYamahaPolling: pollScheduler.startYamahaPolling,
  startCiscoPolling:  pollScheduler.startCiscoPolling,
  routerManager:      routerManagerApi,
  manualThreat:       manualThreatLookup,
  aiProvider,
};

configureHttpApp(app, {
  subpath: SUBPATH,
  assetVersion: ASSET_VERSION,
  demoMode: DEMO_MODE,
  appRoot: __dirname,
  htmlEscape,
  tlsEnabled: Boolean(tlsOptions),
  routeCtx,
  requireAdmin,
  beacons,
  appState,
  saveConfig,
  beaconScanRunner,
  logger,
  healthState,
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

registerSocketHandlers({
  io,
  appState,
  authenticate,
  asus,
  yamaha,
  cisco,
  notes,
  history,
  threatIntel,
  defaultRouterIp: DEFAULT_ROUTER_IP,
  logger,
  getRouters: () => routerManagerApi.list(),
});

// ─── Wire notifier log callback ───────────────────────────────────────────────

notifier.setLogCallback((entry, type, slackSent) => {
  history.logNotification(entry, type, slackSent);
});

// ─── Wire up poller callbacks ─────────────────────────────────────────────────

runtime.init({
  io, history, enrichment, threatIntel, notifier, deviceId, devices,
  asus, yamaha, cisco, dhcpdSyslog, beacons,
});

pollScheduler.init({
  io, yamaha, cisco, runtime, history, devices, beacons, investigation,
  appState, queueConnectionEnrichment: enrichmentQueue.queueConnectionEnrichment,
  pollIntervalMs: POLL_INTERVAL,
});

investigation.init({
  notes, io, yamaha, asus, deviceId,
  getAutoInvestigate: () => appState.autoInvestigate,
});

yamaha.configure({
  ip:            DEMO_MODE ? '' : (process.env.YAMAHA_IP   || ''),
  user:          DEMO_MODE ? '' : (process.env.YAMAHA_USER || ''),
  pass:          DEMO_MODE ? '' : (process.env.YAMAHA_PASS || ''),
  natDescriptor: process.env.YAMAHA_NAT  || '100',
  onStatus:      (status) => io.emit('yamaha-status', status),
  onSaveConfig:  saveConfig,
});

cisco.configure({
  ip:         DEMO_MODE ? '' : (process.env.CISCO_IP          || ''),
  user:       DEMO_MODE ? '' : (process.env.CISCO_USER        || ''),
  pass:       DEMO_MODE ? '' : (process.env.CISCO_PASS        || ''),
  enablePass: DEMO_MODE ? '' : (process.env.CISCO_ENABLE_PASS || ''),
  onStatus:   (status) => io.emit('cisco-status', status),
  onSaveConfig: saveConfig,
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

// Binds to all interfaces if HOST is unset (normal usage: reachable from other
// LAN devices). Tests and sandboxed environments can restrict it to loopback
// via HOST=127.0.0.1.
const HOST = process.env.HOST || undefined;

server.listen(PORT, HOST, () => {
  runtimeProfiler.start({ logger });
  logger.info(`EgressView: ${tlsOptions ? 'https' : 'http'}://${HOST || 'localhost'}:${PORT}`);
  try {
    loadConfig();
  } catch (err) {
    logger.error('[startup] Failed to load config; refusing to continue:', err.message);
    server.close(() => process.exit(1));
    return;
  }
  const configuredDbPath = process.env.EGRESSVIEW_DB_PATH || process.env.EGRESSVIEW_DB || '';
  if (DEMO_MODE && !configuredDbPath && fs.existsSync(DEMO_DB_PATH)) {
    // Copy the committed snapshot to a separate runtime file so the tracked
    // snapshot is never modified at runtime. Remove sidecars from a previous
    // run first; pairing stale WAL data with a fresh snapshot corrupts it.
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(DEMO_RUNTIME_DB_PATH + suffix); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    fs.copyFileSync(DEMO_DB_PATH, DEMO_RUNTIME_DB_PATH);
  }
  const runtimeDbPath = DEMO_MODE ? (configuredDbPath || DEMO_RUNTIME_DB_PATH) : configuredDbPath;
  if (runtimeDbPath) process.env.EGRESSVIEW_DB_PATH = runtimeDbPath;
  backup.configure({ dbPath: runtimeDbPath });

  if (DEMO_MODE) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[demo] DEMO_MODE=true is not allowed when NODE_ENV=production. Refusing to start.');
      process.exit(1);
    }
    // Use a separate DB file for demo mode so production data is never touched.
    // If .egressview.demo.db exists (committed to git), start from that snapshot.
    // Otherwise fall back to a fresh in-memory-style DB at the demo path.
    backup.configure({ backupDir: DEMO_BACKUP_DIR });
    // Override token with a known value so CI / contributors can authenticate
    appState.adminToken = DEMO_ADMIN_TOKEN;
    logger.info(`[demo] DEMO_MODE active — admin token: ${DEMO_ADMIN_TOKEN}`);
  } else {
    ensureAdminToken();
  }
  ensureLoginPassword();

  notes.load();
  history.setRetentionDays(appState.retentionDays);

  // DB bootstrap: history (owning schema migrations) must attach first; a
  // migration failure throws here before any other module opens the file.
  // The source→routerId map keeps the v4 expansion deterministic: a legacy
  // source maps to yamaha1/cisco1 while its config section exists.
  const rawCfg = configIo.loadFileSafe(CONFIG_FILE);
  const sourceRouterMap = sourceRouterIdMap({
    hasYamahaConfig: !!(rawCfg.yamaha && (rawCfg.yamaha.ip || rawCfg.yamaha.user)),
    hasCiscoConfig:  !!(rawCfg.cisco  && (rawCfg.cisco.ip  || rawCfg.cisco.user)),
  });
  const { staleEnrichmentIps } = runDbBootstrap({ dbPath: runtimeDbPath, sourceRouterMap, history, sessions, devices, enrichment, beacons });
  setInterval(() => sessions.pruneExpired(), 6 * 60 * 60 * 1000);

  if (DEMO_MODE) {
    const { seedDemoConnections } = require('./scripts/demo-seed');
    const seeded = seedDemoConnections(history);
    logger.info(`[demo] seeded ${seeded} sample connections`);
  }

  runtime.setKnownMacs(history.getKnownMacs());
  devices.seedFromConnectionHistory(history.getConnectionHistory());
  const staleChecked = devices.checkStaleMergeCandidates();
  if (staleChecked > 0) {
    logger.info(`[devices] stale merge check: ${staleChecked} device(s) scanned for duplicates`);
  }
  enrichmentQueue.init({ history, enrichment, io, logger });
  if (staleEnrichmentIps.length) {
    logger.info(`[enrichment] Queuing ${staleEnrichmentIps.length} stale IPs for background refresh`);
    enrichmentQueue.queueStaleConnectionEnrichment(staleEnrichmentIps);
  }
  beaconScanRunner.init({ appState, beacons, beaconDetector, threatIntel, enrichment, logger });

  routerManager = createRouterManager({
    records: routerConfigState.routers,
    tombstones: routerConfigState.tombstones,
    persist: persistRouterConfigs,
    pollIntervalMs: POLL_INTERVAL,
    runtime, history, devices, beacons, enrichmentQueue, investigation, appState, io,
  });
  runtime.setRouterRegistry(routerManager.registry);

  if (!DEMO_MODE) {
    logger.info(`Router IP: ${asus.getRouterIp()}`);
    deviceId.loadOuiDb();
    dnsmasqLog.start();
    inspectSyslog.start();
    dhcpdSyslog.start();
  } else {
    deviceId.loadOuiDb();
  }

  setInterval(() => runtimeProfiler.measureSync('history.snapshot', () => history.snapshotHistory()),
    10 * 60 * 1000);
  setInterval(() => runtimeProfiler.measureSync('history.compact', () => history.compactHistoryLog()),
    30 * 60 * 1000);

  threatIntel.fetchThreatIntel()
    .then(() => reMatchAndNotify())
    .catch(err => logger.error('[threat] initial fetch failed:', err.message));
  setInterval(() => {
    threatIntel.fetchThreatIntel()
      .then(() => reMatchAndNotify())
      .catch(err => logger.error('[threat] periodic fetch failed:', err.message));
  }, 60 * 60 * 1000);

  if (!DEMO_MODE) beaconScanRunner.scheduleBeaconScan();

  backup.startPeriodicBackup();
  healthState.markReady();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(exitCode = 0) {
  healthState.markNotReady();
  logger.info('[shutdown] Saving history...');
  try { routerManager?.stopAll();   } catch {}
  try { runtimeProfiler.measureSync('history.shutdownSnapshot', () => history.snapshotHistory()); } catch {}
  runtimeProfiler.stop();
  try { history.closeDb();         } catch {}
  try { dnsmasqLog.stop();         } catch {}
  try { inspectSyslog.stop();      } catch {}
  try { dhcpdSyslog.stop();        } catch {}
  process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT',  () => shutdown(0));

// ─── Process-level error handlers ─────────────────────────────────────────────
// As a long-running monitoring tool, an unhandled promise rejection (mostly
// network-related) should not take the process down. uncaughtException may
// mean state is corrupted, so snapshot history before exiting.
process.on('unhandledRejection', (reason) => {
  logger.error('[process] Unhandled promise rejection:', reason?.stack || reason?.message || String(reason));
});

process.on('uncaughtException', (err) => {
  logger.error('[process] Uncaught exception — saving state and exiting:', err.stack || err.message);
  shutdown(1);
});
