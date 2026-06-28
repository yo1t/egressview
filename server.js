'use strict';

require('dotenv').config();
// Prefer IPv4 (prevents external HTTPS from stalling on IPv6, e.g. on EC2)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

const express = require('express');
const http    = require('http');
const https   = require('https');
const { Server } = require('socket.io');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const { htmlEscape }  = require('./src/utils');
const logger          = require('./src/logger');
const enrichment      = require('./src/enrichment');
const history         = require('./src/history');
const deviceId        = require('./src/device-identify');
const threatIntel     = require('./src/threat-intel');
const notifier        = require('./src/notifier');
const i18n            = require('./src/i18n-server');
const backup          = require('./src/backup');
const yamaha          = require('./src/pollers/yamaha-adapter');
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
const sessions       = require('./src/sessions');
const authPassword   = require('./src/auth-password');

// ─── Route factories ──────────────────────────────────────────────────────────
const authRoutes        = require('./src/routes/auth');
const notesRoutes       = require('./src/routes/notes');
const connectionsRoutes = require('./src/routes/connections');
const devicesRoutes     = require('./src/routes/devices');
const backupRoutes      = require('./src/routes/backup');
const configRoutes      = require('./src/routes/config');
const slackRoutes           = require('./src/routes/slack');
const beaconsRoutes         = require('./src/routes/beacons');
const notificationLogRoutes = require('./src/routes/notification-log');

// ─── Environment ──────────────────────────────────────────────────────────────
const SUBPATH           = (process.env.SUBPATH || '').replace(/\/$/, '');
const DEFAULT_ROUTER_IP = process.env.ROUTER_IP   || '192.168.1.1';
const POLL_INTERVAL     = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
// PORT is resolved after the early config read below (env > config file > 3000)
let PORT = parseInt(process.env.PORT || '3000');
const CONFIG_FILE       = require('./src/config').DEFAULT_CONFIG_FILE;

// Demo mode: pre-seeds sample data and uses a fixed token so the app can be
// explored without real router hardware (used in CI for Playwright smoke tests).
const DEMO_MODE       = process.env.DEMO_MODE === 'true';
const DEMO_ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN || 'demo-token-ci';
const DEMO_DB_PATH     = path.join(__dirname, '.egressview.demo.db');
const DEMO_BACKUP_DIR  = path.join(__dirname, '.egressview-demo-backups');
const _rawAssetVersion = process.env.EGRESSVIEW_ASSET_VERSION || '';
const ASSET_VERSION    = /^[A-Za-z0-9._-]+$/.test(_rawAssetVersion) ? _rawAssetVersion : (() => {
  if (_rawAssetVersion) console.warn(`[server] EGRESSVIEW_ASSET_VERSION contains invalid characters ('${_rawAssetVersion}'); falling back to timestamp.`);
  return String(Date.now());
})();


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
  httpsEnabled:  false,
  httpsCertPath: '',
  httpsKeyPath:  '',
  authPasswordHash: '',
  authPasswordSalt: '',
  beaconConfig: {
    enabled:        true,
    minObs:         4,
    maxCov:         0.5,
    minIntervalMs:  60_000,
    maxIntervalMs:  4 * 3600_000,
    scanIntervalMs: 60 * 60 * 1000,
    // Known-benign vendor telemetry — defaults measured against production
    // false positives on 2026-06-12 (296 candidates, all vendor heartbeats)
    whitelistDomains: [
      'amazonaws.com', 'amazon.com', 'amazon.co.jp', 'aws.dev',
      'amazonalexa.com', 'cloudfront.net',
      'firetvcaptiveportal.com', 'mmechocaptiveportal.com',
      'netflix.com', 'nflxvideo.net',
      'daikinsmartdb.jp',
      'time.apple.com', 'push.apple.com',
      'windows.com', 'windowsupdate.com',
    ],
    // RDAP org substrings — candidates resolving to these orgs are excluded
    // unless the destination also hits a threat-intel feed
    orgAllowlist: [
      'Amazon', 'Google', 'Microsoft', 'Apple', 'Akamai',
      'Netflix', 'Fastly', 'Cloudflare', 'GitHub', 'New Relic',
    ],
  },
};

// 差分 push 用タイムスタンプ: 前回 broadcast 以降に更新された接続だけを送信するため
let lastPollEmitTime = Date.now();

// ─── Express + Socket.IO setup ────────────────────────────────────────────────
const app = express();

// HTTPS opt-in (P2-22): the protocol must be decided before the server is
// created, so read just the https section of the config file early.
// Default is HTTP — self-signed certs trigger browser warnings, so HTTPS
// stays opt-in (same trade-off as comparable home-lab tools).
const tls = require('./src/tls');
let tlsOptions = null;
{
  const early = configIo.loadFile(CONFIG_FILE);
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
  i18n.setLanguage(appState.uiLanguage);
  if (data.adminToken) appState.adminToken = data.adminToken;

  if (data.auth && typeof data.auth === 'object') {
    appState.authPasswordHash = data.auth.passwordHash || '';
    appState.authPasswordSalt = data.auth.salt || '';
  }
  if (data.https && typeof data.https === 'object') {
    appState.httpsEnabled  = data.https.enabled === true;
    appState.httpsCertPath = data.https.certPath || '';
    appState.httpsKeyPath  = data.https.keyPath  || '';
  }
  if (data.beacons && typeof data.beacons === 'object') {
    const bc = appState.beaconConfig;
    if (typeof data.beacons.enabled === 'boolean')        bc.enabled        = data.beacons.enabled;
    if (Number.isFinite(data.beacons.minObs))             bc.minObs         = data.beacons.minObs;
    if (Number.isFinite(data.beacons.maxCov))             bc.maxCov         = data.beacons.maxCov;
    if (Number.isFinite(data.beacons.minIntervalMs))      bc.minIntervalMs  = data.beacons.minIntervalMs;
    if (Number.isFinite(data.beacons.maxIntervalMs))      bc.maxIntervalMs  = data.beacons.maxIntervalMs;
    if (Number.isFinite(data.beacons.scanIntervalMs))     bc.scanIntervalMs = data.beacons.scanIntervalMs;
    if (Array.isArray(data.beacons.whitelistDomains))     bc.whitelistDomains = data.beacons.whitelistDomains;
    if (Array.isArray(data.beacons.orgAllowlist))         bc.orgAllowlist     = data.beacons.orgAllowlist;
  }

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
  logger.info('[config] Loaded:', CONFIG_FILE);
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
    beacons: appState.beaconConfig,
    https:   { enabled: appState.httpsEnabled, certPath: appState.httpsCertPath, keyPath: appState.httpsKeyPath },
    auth:    { passwordHash: appState.authPasswordHash, salt: appState.authPasswordSalt },
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
    logger.info('[config] Saved:', CONFIG_FILE);
  } catch (e) {
    logger.error('[config] Save failed:', e.message);
  }
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

// ─── Yamaha polling loop ──────────────────────────────────────────────────────

// Track session keys seen in the previous poll to detect newly-appeared sessions
// (used for poll-based beacon event recording when [INSPECT] is unavailable).
let lastPollKeys = new Set();
const enrichmentQueue = new Set();
let enrichmentQueueRunning = false;

function refreshCachedEnrichmentForDestinations(ips) {
  const ipSet = new Set(ips);
  const updated = [];
  for (const entry of history.getConnectionHistory().values()) {
    if (!ipSet.has(entry.dst)) continue;

    let changed = false;
    const setIfChanged = (field, value) => {
      if (value == null || entry[field] === value) return;
      entry[field] = value;
      changed = true;
    };

    const now = Date.now();
    const dnsCached = enrichment.getDnsCache().get(entry.dst);
    if (dnsCached && dnsCached.expires > now) {
      if (dnsCached.source === 'dnsmasq' || !enrichment.isPtrJunk(dnsCached.host)) {
        setIfChanged('dstHost', dnsCached.host);
      }
    }
    const rdap = enrichment.getRdapCache().get(entry.dst);
    const geo  = enrichment.getGeoCache().get(entry.dst);
    setIfChanged('country', rdap?.country || geo?.countryCode);
    setIfChanged('org', rdap?.org);
    setIfChanged('lat', geo?.lat);
    setIfChanged('lon', geo?.lon);
    setIfChanged('city', geo?.city);
    if (!changed) continue;

    history.appendHistoryLog(entry);
    updated.push(entry);
  }
  if (updated.length) {
    io.emit('connections-update', { connections: updated, serverTime: Date.now(), partial: true, delta: true });
  }
}

function queueConnectionEnrichment(ips) {
  for (const ip of ips) enrichmentQueue.add(ip);
  if (enrichmentQueueRunning) return;
  enrichmentQueueRunning = true;
  setImmediate(runConnectionEnrichmentQueue);
}

async function runConnectionEnrichmentQueue() {
  try {
    while (enrichmentQueue.size) {
      const batch = [...enrichmentQueue].slice(0, 250);
      batch.forEach(ip => enrichmentQueue.delete(ip));
      await Promise.allSettled(batch.map(ip => enrichment.reverseDns(ip)));
      await enrichment.lookupRdapBatch(batch);
      await enrichment.lookupGeoBatch(batch);
      refreshCachedEnrichmentForDestinations(batch);
    }
  } catch (err) {
    logger.error('[enrichment] background queue error:', err.message);
  } finally {
    enrichmentQueueRunning = false;
    if (enrichmentQueue.size) queueConnectionEnrichment([]);
  }
}

async function pollYamahaConnections() {
  if (!yamaha.isEnabled()) return;
  try {
    if (!yamaha.isReady()) {
      logger.debug('[yamaha] poll skipped: not ready');
      return;
    }
    const sessions = await yamaha.fetchSessions();
    logger.debug(`[yamaha] ${sessions.length} sessions parsed`);

    const unique = [...new Set(sessions.map(s => s.dst))];
    queueConnectionEnrichment(unique);

    const now = Date.now();
    if (yamaha.needsArpRefresh()) await yamaha.refreshArp();
    if (yamaha.needsNdpRefresh()) {
      await yamaha.refreshNdp();
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
      logger.debug(`[yamaha] emit delta: ${deltaConns.length} connections (of ${history.getConnectionHistory().size} total)`);
    } else {
      logger.debug('[yamaha] emit delta: 0 changes, skipped');
    }

    if (appState.autoInvestigate) {
      const srcIps = [...new Set(sessions.map(s => s.src))];
      for (const ip of srcIps) investigation.enqueue(ip, runtime.resolveMacByIp(ip));
    }
  } catch (err) {
    logger.error('[yamaha] poll error:', err.message);
    if (err.message.includes('timeout')) {
      logger.warn('[yamaha] Timeout detected, resetting connection…');
      yamaha.reconnect();
      // fall through so setTimeout still runs — otherwise polling stops permanently
    }
  } finally {
    if (yamaha.isEnabled()) setTimeout(pollYamahaConnections, POLL_INTERVAL);
  }
}

// ─── Express middleware ───────────────────────────────────────────────────────

// Security headers — applied to every response
app.use((req, res, next) => {
  // Nonce for the BASE_URL bootstrap <script> tag — eliminates 'unsafe-inline' from script-src
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (tlsOptions) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    `script-src 'self' 'nonce-${res.locals.cspNonce}' https://d3js.org https://cdn.jsdelivr.net; ` +
    "style-src 'self'; " +
    "style-src-elem 'self'; " +
    "style-src-attr 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self' wss: https://cdn.jsdelivr.net; " +
    "object-src 'none'; " +
    "base-uri 'self';"
  );
  next();
});

const indexRoutes = ['/', '/index.html'];
if (SUBPATH) indexRoutes.push(`${SUBPATH}/`, `${SUBPATH}/index.html`);

app.get(indexRoutes, (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const baseScript = `<script nonce="${res.locals.cspNonce}">window.BASE_URL = '${htmlEscape(SUBPATH)}'; window._DEMO_MODE = ${DEMO_MODE};</script>`;
  res.type('html').send(
    html.replace('</head>', baseScript + '\n</head>')
        .replace(/__BASE__/g, htmlEscape(SUBPATH))
        .replace(/__ASSET_VERSION__/g, htmlEscape(ASSET_VERSION))
  );
});

const jsModuleRoutes = ['/js/:file'];
if (SUBPATH) jsModuleRoutes.push(`${SUBPATH}/js/:file`);
app.get(jsModuleRoutes, (req, res, next) => {
  const file = req.params.file || '';
  if (!/^[A-Za-z0-9._-]+\.js$/.test(file)) return next();
  const filePath = path.join(__dirname, 'public', 'js', file);
  fs.readFile(filePath, 'utf8', (err, js) => {
    if (err) return next();
    const replaced = js.replace(/__ASSET_VERSION__/g, htmlEscape(ASSET_VERSION));
    const etag = `"${ASSET_VERSION}-${file}"`;
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type('application/javascript').send(replaced);
  });
});

// Serve static assets at both root and SUBPATH (for deployments behind a subpath proxy)
const staticOptions = {
  setHeaders(res, filePath) {
    // Require revalidation for fallback/static JS paths as well; /js/*.js is
    // normally served by jsModuleRoutes above so import URLs can be versioned.
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
};
if (SUBPATH) app.use(SUBPATH, express.static(path.join(__dirname, 'public'), staticOptions));
app.use(express.static(path.join(__dirname, 'public'), staticOptions));
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
    logger.info(`[threat-intel] Re-matched ${updated.length} connections, notifying clients`);
    io.emit('connections-update', { connections: updated, serverTime: Date.now(), partial: true, delta: true });
  } else {
    logger.debug('[threat-intel] Re-match complete, no threat changes');
  }
}

// ─── Beacon detection scan ────────────────────────────────────────────────────

let beaconScanTimer = null;

function runBeaconScan() {
  const cfg = appState.beaconConfig;
  if (!cfg.enabled) return;

  const events = beacons.getEvents();
  const detected = beaconDetector.detectBeacons(events, {
    minObs:           cfg.minObs,
    maxCov:           cfg.maxCov,
    minIntervalMs:    cfg.minIntervalMs,
    maxIntervalMs:    cfg.maxIntervalMs,
    whitelistDomains: cfg.whitelistDomains,
  });

  // RDAP org allowlist: drop candidates resolving to known-benign vendors.
  // A threat-intel hit overrides the allowlist — never hide a flagged dst.
  const allow = cfg.orgAllowlist.map(o => o.toLowerCase());
  const candidates = detected.filter(c => {
    if (threatIntel.matchThreatIntel(c.dst, c.dstHost || c.dst)) return true;
    const org = (enrichment.getRdapCache().get(c.dst)?.org || '').toLowerCase();
    return !org || !allow.some(a => org.includes(a));
  });

  for (const c of candidates) beacons.upsertBeacon(c);
  const removed = beacons.pruneCandidatesNotIn(
    candidates.map(c => `${c.src}|${c.dst}|${c.dport}|${c.proto}`)
  );
  const pruned = beacons.pruneEvents();
  logger.info(`[beacons] scan: ${candidates.length} candidate(s) from ${events.length} events ` +
             `(${detected.length - candidates.length} org-allowlisted, ${removed} stale removed, ${pruned} old events pruned)`);
}

/** (Re)start the periodic scan using the configured interval. */
function scheduleBeaconScan() {
  if (beaconScanTimer) clearInterval(beaconScanTimer);
  beaconScanTimer = setInterval(runBeaconScan, appState.beaconConfig.scanIntervalMs);
}

// ─── Mount routes ─────────────────────────────────────────────────────────────

const routeCtx = {
  requireAdmin,
  getAdminToken:       () => appState.adminToken,
  asus, yamaha, enrichment, threatIntel, notifier, history, devices, deviceId, backup,
  dnsmasqLog, inspectSyslog, dhcpdSyslog,
  runtime, notes, io, beacons, sessions, authPassword,
  saveConfig,
  loadConfig:          () => configIo.loadFile(CONFIG_FILE),
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
app.use('/api', backupRoutes(routeCtx));
app.use('/api', configRoutes(routeCtx));
app.use('/api', slackRoutes(routeCtx));
app.use('/api', notificationLogRoutes(routeCtx));
app.use('/api', beaconsRoutes({
  requireAdmin, beacons, appState, saveConfig,
  onConfigChange: () => { scheduleBeaconScan(); runBeaconScan(); },
}));

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  const provided = String(socket.handshake.auth?.token || '');
  if (!appState.adminToken) return next(new Error('認証未初期化'));
  if (!authenticate(provided)) return next(new Error('Unauthorized'));
  next();
});

io.on('connection', socket => {
  logger.debug('[ws] Client connected:', socket.id);
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

// ─── Wire notifier log callback ───────────────────────────────────────────────

notifier.setLogCallback((entry, type, slackSent) => {
  history.logNotification(entry, type, slackSent);
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
  logger.info(`EgressView: ${tlsOptions ? 'https' : 'http'}://localhost:${PORT}`);
  loadConfig();
  const configuredDbPath = process.env.EGRESSVIEW_DB_PATH || process.env.EGRESSVIEW_DB || '';
  const runtimeDbPath = DEMO_MODE ? (configuredDbPath || DEMO_DB_PATH) : configuredDbPath;
  if (runtimeDbPath) process.env.EGRESSVIEW_DB_PATH = runtimeDbPath;
  backup.configure({ dbPath: runtimeDbPath });

  if (DEMO_MODE) {
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

  sessions.initDb(runtimeDbPath);
  setInterval(() => sessions.pruneExpired(), 6 * 60 * 60 * 1000);
  notes.load();
  history.setRetentionDays(appState.retentionDays);
  history.loadConnectionHistory(runtimeDbPath);

  if (DEMO_MODE) {
    const { seedDemoConnections } = require('./scripts/demo-seed');
    const seeded = seedDemoConnections(history);
    logger.info(`[demo] seeded ${seeded} sample connections`);
  }

  runtime.setKnownMacs(history.getKnownMacs());
  devices.initDb(runtimeDbPath);
  devices.seedFromConnectionHistory(history.getConnectionHistory());
  const staleChecked = devices.checkStaleMergeCandidates();
  if (staleChecked > 0) {
    logger.info(`[devices] stale merge check: ${staleChecked} device(s) scanned for duplicates`);
  }
  enrichment.initDb(runtimeDbPath);
  beacons.initDb(runtimeDbPath);

  if (!DEMO_MODE) {
    logger.info(`Router IP: ${asus.getRouterIp()}`);
    deviceId.loadOuiDb();
    yamaha.connect(() => {
      yamaha.refreshArp().then(() => pollYamahaConnections());
    });
    dnsmasqLog.start();
    inspectSyslog.start();
    dhcpdSyslog.start();
  } else {
    deviceId.loadOuiDb();
  }

  setInterval(() => history.snapshotHistory(),    10 * 60 * 1000);
  setInterval(() => history.compactHistoryLog(),  30 * 60 * 1000);

  threatIntel.fetchThreatIntel().then(() => {
    reMatchAndNotify();
  });
  setInterval(() => threatIntel.fetchThreatIntel().then(reMatchAndNotify), 60 * 60 * 1000);

  if (!DEMO_MODE) scheduleBeaconScan();

  backup.startPeriodicBackup();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  logger.info('[shutdown] Saving history...');
  try { history.snapshotHistory(); } catch {}
  try { history.closeDb();         } catch {}
  try { dnsmasqLog.stop();         } catch {}
  try { inspectSyslog.stop();      } catch {}
  try { dhcpdSyslog.stop();        } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
