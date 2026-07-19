// Connection history: SQLite-backed storage (better-sqlite3 — native, WAL mode)
'use strict';
const logger = require('./logger');
const { summarizeAppGroups } = require('./app-classifier');

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { runMigrations } = require('./db-migrate');
const { MIGRATED_IDS, expandSourceToRouterIds, routerKindForId } = require('./router-id');
const { checkObservationConsistency: checkConsistency } = require('./observation-consistency');
const { createHistoryCache, DEFAULT_HOT_MAX_ENTRIES } = require('./history-cache');
const { createHistoryQueries } = require('./history-queries');
const { createAiConversationStore } = require('./ai-conversation-store');

const DEFAULT_DB_PATH = process.env.EGRESSVIEW_DB_PATH || process.env.EGRESSVIEW_DB
  ? path.resolve(process.env.EGRESSVIEW_DB_PATH || process.env.EGRESSVIEW_DB)
  : path.join(__dirname, '..', '.egressview.db');
const JSONL_PATH = path.join(__dirname, '..', '.egressview.connections.jsonl');
const HISTORY_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years (default)
let historyTtlMs = HISTORY_TTL_MS;

let db = null;
let stmtUpsert = null;
let stmtSelectAll = null;
let stmtSelectByKey = null;
let stmtDeleteOld = null;
let stmtInsertNotifLog = null;
let stmtObsUpsert = null;
let stmtEnsureRouter = null;
let upsertTxn = null;
let upsertManyTxn = null;
let currentDbPath = DEFAULT_DB_PATH;

// Legacy source values from pollers are normalized into persistent routerIds.
// server.js overrides this at bootstrap via loadConnectionHistory() options;
// the default matches a config where both router sections exist.
let sourceRouterMap = { yamaha: MIGRATED_IDS.yamaha, cisco: MIGRATED_IDS.cisco };
// routerIds already ensured in the routers table this session (write-through cache)
let ensuredRouterIds = new Set();
let routerKinds = new Map();

// Keep one stable Map instance because Socket.IO and runtime consumers retain it.
const hotCache = createHistoryCache(process.env.EGRESSVIEW_HISTORY_HOT_MAX);
const connectionHistory = hotCache.map;

const CONNECTION_READ_COLUMNS = [
  'src', 'dst', 'dport', 'proto', 'sport', 'ttl', 'srcMac', 'srcVendor',
  'srcDnsName', 'srcMdnsName', 'dstHost', 'country', 'org', 'lat', 'lon',
  'city', 'firstSeen', 'lastSeen', 'agentHost', 'process', 'pid',
];

function connectionReadColumns(alias = 'c') {
  const columns = CONNECTION_READ_COLUMNS.map(column => `${alias}.${column}`).join(', ');
  return `${columns}, (
    SELECT GROUP_CONCAT(o.routerId)
    FROM connection_observations o
    WHERE o.src = ${alias}.src AND o.dst = ${alias}.dst
      AND o.dport = ${alias}.dport AND o.proto = ${alias}.proto
  ) AS observedByCsv`;
}

function normalizeObservedBy(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map(id => String(id).trim()).filter(Boolean))].sort();
}

function compatibilitySource(observedBy) {
  const kinds = new Set(normalizeObservedBy(observedBy).map(id =>
    routerKinds.get(id) || routerKindForId(id, sourceRouterMap)
  ));
  if (kinds.has('yamaha') && kinds.has('cisco')) return 'yamaha+cisco';
  if (kinds.has('cisco')) return 'cisco';
  if (kinds.has('yamaha')) return 'yamaha';
  return 'unknown';
}

function hydrateConnectionRow(row) {
  const observedBy = normalizeObservedBy(row.observedByCsv ?? row.observedBy);
  const hydrated = { ...row, observedBy, source: compatibilitySource(observedBy) };
  delete hydrated.observedByCsv;
  return hydrated;
}

function hydrateConnectionRows(rows) {
  return rows.map(hydrateConnectionRow);
}

const {
  queryByTimeRange,
  queryByTimeRangePaged,
  countByTimeRange,
  countFactsByTimeRange,
  createConnectionExportReader,
  groupDstByTimeRange,
  groupServiceByTimeRange,
  groupSrcForDstsByTimeRange,
  summarizeByTimeRange,
} = createHistoryQueries({
  getDb: () => db,
  getDbPath: () => currentDbPath,
  Database,
  connectionReadColumns,
  hydrateConnectionRows,
  normalizeObservedBy,
  compatibilitySource,
  summarizeAppGroups,
  onSummaryTiming: process.env.EGRESSVIEW_SUMMARY_TIMING === '1'
    ? timings => logger.info(`[history] summary timing ${JSON.stringify(timings)}`)
    : null,
});

const aiConversationStore = createAiConversationStore({ getDb: () => db });

function _secureDbFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.chmodSync(currentDbPath + suffix, 0o600); } catch {}
  }
}

function _openDb(p) {
  const d = new Database(p);
  d.pragma('journal_mode = WAL');
  d.pragma('busy_timeout = 5000');
  return d;
}

function _isDbHealthy(d) {
  try { return d.pragma('integrity_check')[0]?.integrity_check === 'ok'; }
  catch { return false; }
}

function _removeDbFiles(p) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + suffix); } catch {}
  }
}

/**
 * Copy the most recent backup generation over `targetPath`.
 * Backup files are closed snapshots, so a plain copy is safe.
 * @returns {boolean} true if a backup was copied
 */
function _tryRestoreLatestBackup(targetPath) {
  try {
    const backup = require('./backup');  // lazy: backup.js has no dependency on history.js
    const list = backup.listBackups();   // sorted oldest first
    if (!list.length) return false;
    const latest = list[list.length - 1];
    const p = backup.getBackupPath(latest.name);
    if (!p) return false;
    fs.copyFileSync(p, targetPath);
    logger.info(`[history] Restored from backup: ${latest.name}`);
    return true;
  } catch (e) {
    logger.error('[history] Backup restore failed:', e.message);
    return false;
  }
}

function initDb(dbPath, { sourceRouterMap: mapOverride } = {}) {
  if (mapOverride) sourceRouterMap = mapOverride;
  ensuredRouterIds = new Set();
  const actualPath = dbPath === ':memory:' ? ':memory:' : (dbPath ? path.resolve(dbPath) : DEFAULT_DB_PATH);
  currentDbPath = actualPath;
  // A heavily corrupted file can throw on open (SQLITE_NOTADB from the first
  // pragma), so treat open failure and integrity failure the same way.
  try { db = _openDb(actualPath); } catch { db = null; }
  _secureDbFiles();

  // Integrity check on startup; on failure, try the latest backup before
  // falling back to an empty database.
  if (!db || !_isDbHealthy(db)) {
    logger.error('[history] Database integrity check failed');
    if (db) { try { db.close(); } catch {} }
    _removeDbFiles(actualPath);

    if (_tryRestoreLatestBackup(actualPath)) {
      try { db = _openDb(actualPath); } catch { db = null; }
      if (!db || !_isDbHealthy(db)) {
        logger.error('[history] Restored backup is also corrupt, recreating empty DB');
        if (db) { try { db.close(); } catch {} }
        _removeDbFiles(actualPath);
        db = _openDb(actualPath);
      }
    } else {
      logger.warn('[history] No usable backup found, recreating empty DB');
      db = _openDb(actualPath);
    }
    _secureDbFiles();
  }

  // Run versioned migrations (takes pre-migration backup if pending changes exist)
  runMigrations(db, actualPath, { sourceRouterMap });

  // Create tables for fresh databases (idempotent — skipped if already exist)
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      src       TEXT NOT NULL,
      dst       TEXT NOT NULL,
      dport     INTEGER NOT NULL,
      proto     TEXT NOT NULL,
      sport     INTEGER,
      ttl       INTEGER,
      srcMac    TEXT,
      srcVendor TEXT,
      srcDnsName  TEXT,
      srcMdnsName TEXT,
      dstHost   TEXT,
      country   TEXT,
      org       TEXT,
      lat       REAL,
      lon       REAL,
      city      TEXT,
      firstSeen INTEGER NOT NULL,
      lastSeen  INTEGER NOT NULL,
      agentHost TEXT,
      process   TEXT,
      pid       INTEGER,
      PRIMARY KEY (src, dst, dport, proto)
    );
    CREATE INDEX IF NOT EXISTS idx_lastSeen ON connections(lastSeen);
    CREATE INDEX IF NOT EXISTS idx_src ON connections(src);
    CREATE INDEX IF NOT EXISTS idx_dst ON connections(dst);
  `);

  // Multi-router observation tables. Normally created by
  // the v4 migration; repeated here so a fresh DB gets them too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS routers (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      displayName TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      deletedAt   INTEGER
    );
    CREATE TABLE IF NOT EXISTS connection_observations (
      src             TEXT    NOT NULL,
      dst             TEXT    NOT NULL,
      dport           INTEGER NOT NULL,
      proto           TEXT    NOT NULL,
      routerId        TEXT    NOT NULL,
      firstObservedAt INTEGER NOT NULL,
      lastObservedAt  INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto, routerId)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_router   ON connection_observations(routerId);
    CREATE INDEX IF NOT EXISTS idx_obs_lastSeen ON connection_observations(lastObservedAt);
  `);
  routerKinds = new Map(db.prepare('SELECT id, kind FROM routers').all().map(row => [row.id, row.kind]));

  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      type            TEXT    NOT NULL,
      slackSent       INTEGER NOT NULL DEFAULT 0,
      src             TEXT,
      srcMac          TEXT,
      srcVendor       TEXT,
      srcMdnsName     TEXT,
      srcDnsName      TEXT,
      dst             TEXT,
      dstHost         TEXT,
      dport           INTEGER,
      proto           TEXT,
      country         TEXT,
      city            TEXT,
      org             TEXT,
      threatSource    TEXT,
      threatTag       TEXT,
      threatConfidence TEXT,
      detectedAt      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nlog_detectedAt ON notification_log(detectedAt);
  `);

  stmtInsertNotifLog = db.prepare(`
    INSERT INTO notification_log
      (type, slackSent, src, srcMac, srcVendor, srcMdnsName, srcDnsName,
       dst, dstHost, dport, proto, country, city, org,
       threatSource, threatTag, threatConfidence, detectedAt)
    VALUES
      (@type, @slackSent, @src, @srcMac, @srcVendor, @srcMdnsName, @srcDnsName,
       @dst, @dstHost, @dport, @proto, @country, @city, @org,
       @threatSource, @threatTag, @threatConfidence, @detectedAt)
  `);

  stmtUpsert = db.prepare(`
    INSERT INTO connections (src, dst, dport, proto, sport, ttl, srcMac, srcVendor, srcDnsName, srcMdnsName, dstHost, country, org, lat, lon, city, firstSeen, lastSeen)
    VALUES (@src, @dst, @dport, @proto, @sport, @ttl, @srcMac, @srcVendor, @srcDnsName, @srcMdnsName, @dstHost, @country, @org, @lat, @lon, @city, @firstSeen, @lastSeen)
    ON CONFLICT(src, dst, dport, proto) DO UPDATE SET
      sport = COALESCE(@sport, sport),
      ttl = COALESCE(@ttl, ttl),
      srcMac = COALESCE(@srcMac, srcMac),
      srcVendor = COALESCE(@srcVendor, srcVendor),
      srcDnsName = COALESCE(@srcDnsName, srcDnsName),
      srcMdnsName = COALESCE(@srcMdnsName, srcMdnsName),
      dstHost = COALESCE(@dstHost, dstHost),
      country = COALESCE(@country, country),
      org = COALESCE(@org, org),
      lat = COALESCE(@lat, lat),
      lon = COALESCE(@lon, lon),
      city = COALESCE(@city, city),
      firstSeen = MIN(firstSeen, @firstSeen),
      lastSeen = MAX(lastSeen, @lastSeen)
  `);

  stmtSelectAll = db.prepare(`
    SELECT ${connectionReadColumns('c')} FROM connections c
    WHERE c.lastSeen >= ? ORDER BY c.lastSeen DESC LIMIT ?
  `);
  stmtSelectByKey = db.prepare(`
    SELECT ${connectionReadColumns('c')} FROM connections c
    WHERE c.src = ? AND c.dst = ? AND c.dport = ? AND c.proto = ?
  `);
  stmtDeleteOld = db.prepare(`DELETE FROM connections WHERE lastSeen < ?`);

  stmtObsUpsert = db.prepare(`
    INSERT INTO connection_observations
      (src, dst, dport, proto, routerId, firstObservedAt, lastObservedAt)
    VALUES (@src, @dst, @dport, @proto, @routerId, @firstObservedAt, @lastObservedAt)
    ON CONFLICT(src, dst, dport, proto, routerId) DO UPDATE SET
      firstObservedAt = MIN(firstObservedAt, @firstObservedAt),
      lastObservedAt  = MAX(lastObservedAt,  @lastObservedAt)
  `);
  stmtEnsureRouter = db.prepare(`
    INSERT INTO routers (id, kind, displayName, createdAt, deletedAt)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);

  // Keep the connection and all router observations atomic. Pollers may still
  // submit a compatibility source value, but only routerIds are persisted.
  const writeEntry = entry => {
    stmtUpsert.run(entry);
    const observedBy = normalizeObservedBy(entry.observedBy);
    const routerIds = observedBy.length
      ? observedBy
      : expandSourceToRouterIds(entry.source, sourceRouterMap);
    for (const routerId of routerIds) {
      _ensureRouterRow(routerId);
      stmtObsUpsert.run({
        src: entry.src, dst: entry.dst, dport: entry.dport, proto: entry.proto,
        routerId,
        firstObservedAt: entry.firstSeen,
        lastObservedAt:  entry.lastSeen,
      });
    }
  };
  upsertTxn = db.transaction(writeEntry);
  upsertManyTxn = db.transaction(entries => {
    for (const entry of entries) writeEntry(entry);
  });

  logger.info('[history] SQLite database initialized (WAL mode)');
}

function _ensureRouterRow(routerId) {
  if (ensuredRouterIds.has(routerId)) return;
  const isLegacy = routerId.startsWith('legacy-');
  const kind = routerKinds.get(routerId) || routerKindForId(routerId, sourceRouterMap);
  stmtEnsureRouter.run(
    routerId,
    kind,
    routerId,
    Date.now(),
    isLegacy ? Date.now() : null,
  );
  ensuredRouterIds.add(routerId);
  routerKinds.set(routerId, kind);
}

function upsertEntry(entry) {
  const observedBy = normalizeObservedBy(entry.observedBy);
  upsertTxn(normalizeEntryForWrite(entry, observedBy));
}

function normalizeEntryForWrite(entry, observedBy = normalizeObservedBy(entry.observedBy)) {
  return {
    src: entry.src,
    dst: entry.dst,
    dport: entry.dport ?? 0,
    proto: entry.proto || 'TCP',
    sport: entry.sport ?? null,
    ttl: entry.ttl ?? null,
    srcMac: entry.srcMac || null,
    srcVendor: entry.srcVendor || null,
    srcDnsName: entry.srcDnsName || null,
    srcMdnsName: entry.srcMdnsName || null,
    dstHost: entry.dstHost || null,
    country: entry.country || null,
    org: entry.org || null,
    lat: entry.lat ?? null,
    lon: entry.lon ?? null,
    city: entry.city || null,
    firstSeen: entry.firstSeen ?? Date.now(),
    lastSeen:  entry.lastSeen  ?? Date.now(),
    source: observedBy.length ? compatibilitySource(observedBy) : (entry.source || 'yamaha'),
    observedBy,
  };
}

// Migrate from JSONL to SQLite (one-time)
function migrateFromJsonl() {
  // Check both .jsonl and .jsonl.migrated (in case DB was recreated after a previous migration)
  let sourcePath = null;
  if (fs.existsSync(JSONL_PATH)) {
    sourcePath = JSONL_PATH;
  } else if (fs.existsSync(JSONL_PATH + '.migrated')) {
    sourcePath = JSONL_PATH + '.migrated';
  }
  if (!sourcePath) return;

  // Skip if DB already has data (migration was already done successfully)
  const count = db.prepare('SELECT COUNT(*) as cnt FROM connections').get();
  if (count.cnt > 0) return;

  logger.info('[history] Migrating JSONL to SQLite...');
  const data = fs.readFileSync(sourcePath, 'utf8');
  const cutoff = Date.now() - historyTtlMs;
  let imported = 0, skipped = 0;

  const insertMany = db.transaction((lines) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e.src || !e.dst || (e.lastSeen || 0) < cutoff) { skipped++; continue; }
        upsertEntry(e);
        imported++;
      } catch { skipped++; }
    }
  });

  insertMany(data.split('\n'));

  // Rename to .migrated (if not already)
  if (sourcePath === JSONL_PATH) {
    fs.renameSync(JSONL_PATH, JSONL_PATH + '.migrated');
  }
  logger.info(`[history] Migration complete: ${imported} imported, ${skipped} skipped`);
}

// Load all active entries into memory cache
function loadIntoMemory() {
  const cutoff = Date.now() - historyTtlMs;
  const rows = hydrateConnectionRows(stmtSelectAll.all(cutoff, hotCache.limit));
  hotCache.replace(rows, row => `${row.src}|${row.dst}|${row.dport}|${row.proto}`);
  logger.info(`[history] Loaded ${connectionHistory.size} hot sessions from SQLite (max ${hotCache.limit})`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function loadConnectionHistory(dbPath, opts = {}) {
  if (db) { try { db.close(); } catch {} db = null; }  // close stale connection before reopening
  initDb(dbPath, opts);
  migrateFromJsonl();
  loadIntoMemory();

  // Startup junction diagnostic: counts only, no traffic data.
  const consistency = checkObservationConsistency();
  if (consistency) {
    const { missingObservations, orphanObservations, underMerged, kindMismatches } = consistency;
    if (missingObservations || orphanObservations || underMerged || kindMismatches) {
      logger.error(`[history] observation consistency MISMATCH: missing=${missingObservations} orphans=${orphanObservations} underMerged=${underMerged} kindMismatches=${kindMismatches}`);
    } else {
      logger.info('[history] observation consistency OK');
    }
  }
}

function appendHistoryLog(entry) {
  try {
    upsertEntry(entry);
  } catch (err) {
    logger.error('[history] upsert error:', err.message);
  }
}

/**
 * Persist one poll's connection and observation changes atomically.
 * Unlike appendHistoryLog(), errors propagate so callers cannot publish a
 * partially persisted poll as successful.
 */
function appendHistoryLogs(entries) {
  if (!entries?.length) return 0;
  if (!db || !upsertManyTxn) throw new Error('history database is not initialized');
  const normalized = entries.map(entry => normalizeEntryForWrite(entry));
  try {
    upsertManyTxn(normalized);
    return normalized.length;
  } catch (err) {
    // _ensureRouterRow uses a write-through cache. Rebuild it after rollback
    // so a failed batch cannot leave the cache ahead of SQLite.
    try {
      ensuredRouterIds = new Set(db.prepare('SELECT id FROM routers').all().map(row => row.id));
      routerKinds = new Map(db.prepare('SELECT id, kind FROM routers').all().map(row => [row.id, row.kind]));
    } catch {
      ensuredRouterIds.clear();
    }
    throw err;
  }
}

// Batch sync: write all current in-memory entries to SQLite
function snapshotHistory() {
  if (!db || connectionHistory.size === 0) return;
  appendHistoryLogs([...connectionHistory.values()]);
  logger.info(`[history] Snapshot ${connectionHistory.size} entries to SQLite`);
}

// Delete old entries from SQLite (junction rows go in the same transaction
// so the two representations can never diverge on a delete)
function compactHistoryLog() {
  if (!db) return;
  const cutoff = Date.now() - historyTtlMs;
  const deleteTxn = db.transaction(cut => {
    db.prepare(`
      DELETE FROM connection_observations
      WHERE (src, dst, dport, proto) IN
        (SELECT src, dst, dport, proto FROM connections WHERE lastSeen < ?)
    `).run(cut);
    return stmtDeleteOld.run(cut);
  });
  const info = deleteTxn(cutoff);
  if (info.changes > 0) {
    logger.info(`[history] Pruned ${info.changes} old entries from SQLite`);
  }
}

/**
 * Diagnostic validation of the observation junction table.
 * No IP/MAC values are included — counts only.
 */
function checkObservationConsistency() {
  return checkConsistency(db);
}

// Prune memory cache
function pruneHistory() {
  const cutoff = Date.now() - historyTtlMs;
  const result = hotCache.prune(cutoff);
  if (result.evicted) logger.info(`[history] Evicted ${result.evicted} cold entries from memory (${connectionHistory.size}/${hotCache.limit} hot)`);
  return result;
}

function getConnectionHistory() { return connectionHistory; }

function cacheConnection(key, entry) {
  return hotCache.set(key, entry);
}

function getConnection(key) {
  const cached = connectionHistory.get(key);
  if (cached) return cached;
  if (!db || typeof key !== 'string') return null;
  const [src, dst, dport, proto] = key.split('|');
  if (!src || !dst || dport === undefined || !proto) return null;
  const row = stmtSelectByKey.get(src, dst, Number(dport), proto);
  if (!row) return null;
  const hydrated = hydrateConnectionRow(row);
  if (hydrated.lastSeen >= Date.now() - historyTtlMs) {
    cacheConnection(key, hydrated);
  }
  return hydrated;
}

function setHotMaxEntries(value) {
  const result = hotCache.setLimit(value);
  logger.info(`[history] Hot cache limit set to ${result.hotMaxEntries} entries`);
  return result;
}

function getMemoryStats() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    hotEntries: connectionHistory.size,
    hotMaxEntries: hotCache.limit,
    persistedEntries: db ? db.prepare('SELECT COUNT(*) AS n FROM connections').get().n : 0,
  };
}

// Bulk-inserts entries for demo / seed purposes. Silently skips failures.
function seedConnections(entries) {
  if (!db || !stmtUpsert) return 0;
  let count = 0;
  for (const entry of entries) {
    try { upsertEntry(entry); count++; } catch {}
  }
  return count;
}

function logNotification(entry, type, slackSent) {
  if (!db || !stmtInsertNotifLog) return;
  try {
    stmtInsertNotifLog.run({
      type,
      slackSent: slackSent ? 1 : 0,
      src:             entry.src             || null,
      srcMac:          entry.srcMac          || null,
      srcVendor:       entry.srcVendor       || null,
      srcMdnsName:     entry.srcMdnsName     || null,
      srcDnsName:      entry.srcDnsName      || null,
      dst:             entry.dst             || null,
      dstHost:         entry.dstHost         || null,
      dport:           entry.dport           ?? null,
      proto:           entry.proto           || null,
      country:         entry.country         || null,
      city:            entry.city            || null,
      org:             entry.org             || null,
      threatSource:    entry.threat?.source  || null,
      threatTag:       entry.threat?.tag     || null,
      threatConfidence:entry.threat?.confidence || null,
      detectedAt:      Date.now(),
    });
  } catch (err) {
    logger.error('[history] logNotification error:', err.message);
  }
}

function queryNotificationLog(from, to) {
  if (!db) return [];
  const conditions = [];
  const params = [];
  if (from != null) { conditions.push('detectedAt >= ?'); params.push(from); }
  if (to   != null) { conditions.push('detectedAt <= ?'); params.push(to); }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(
    `SELECT * FROM notification_log${where} ORDER BY detectedAt DESC LIMIT 2000`
  ).all(...params);
}

// Returns devices/destinations that appeared for the first time during [from, to].
// "New" = the global MIN(firstSeen) across all history falls within the window.
function queryNewNodes(from, to) {
  if (!db) return { deviceCount: 0, destinationCount: 0, newDevices: [], newDestinations: [] };
  if (from == null || to == null) return { deviceCount: 0, destinationCount: 0, newDevices: [], newDestinations: [] };
  const newDevices = db.prepare(
    `SELECT src, srcMac, srcVendor, srcDnsName, srcMdnsName, MIN(firstSeen) as firstSeen
     FROM connections GROUP BY src
     HAVING MIN(firstSeen) >= ? AND MIN(firstSeen) <= ?
     ORDER BY firstSeen DESC`
  ).all(from, to);
  const newDestinations = db.prepare(
    `SELECT dst, MAX(dstHost) as dstHost, MAX(country) as country, MAX(org) as org,
            MIN(firstSeen) as firstSeen
     FROM connections GROUP BY dst
     HAVING MIN(firstSeen) >= ? AND MIN(firstSeen) <= ?
     ORDER BY firstSeen DESC`
  ).all(from, to);
  return {
    deviceCount: newDevices.length,
    destinationCount: newDestinations.length,
    newDevices,
    newDestinations,
  };
}

function getKnownMacs() {
  if (!db) return new Set();
  return new Set(
    db.prepare('SELECT DISTINCT srcMac FROM connections WHERE srcMac IS NOT NULL').all().map(r => r.srcMac)
  );
}

function upsertRouterMetadata(record) {
  if (!db || !record?.id) return;
  db.prepare(`
    INSERT INTO routers (id, kind, displayName, createdAt, deletedAt)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, displayName=excluded.displayName, deletedAt=NULL
  `).run(record.id, record.kind, record.displayName || record.id, record.createdAt || Date.now());
  routerKinds.set(record.id, record.kind);
}

function tombstoneRouterMetadata(id) {
  if (!db || !id) return;
  db.prepare('UPDATE routers SET deletedAt = ? WHERE id = ?').run(Date.now(), id);
}

function setRetentionDays(days) {
  historyTtlMs = days * 24 * 60 * 60 * 1000;
  logger.info(`[history] Retention set to ${days} days (${historyTtlMs}ms)`);
}

function closeDb() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}

// ─── Test helper ─────────────────────────────────────────────────────────────

/** Re-initialize with an in-memory SQLite DB (or a given path) for unit tests. */
function _initForTest(dbPath, opts = {}) {
  if (db) { try { db.close(); } catch {} db = null; }
  hotCache.clear();
  hotCache.setLimit(opts.hotMaxEntries);
  initDb(dbPath || ':memory:', opts);
}

/** Insert into DB AND sync to in-memory Map (for WebSocket filter tests). */
function _appendAndLoad(entry) {
  appendHistoryLog(entry);
  const key = `${entry.src}|${entry.dst}|${entry.dport ?? 0}|${entry.proto || 'TCP'}`;
  const observedBy = normalizeObservedBy(entry.observedBy).length
    ? normalizeObservedBy(entry.observedBy)
    : expandSourceToRouterIds(entry.source || 'yamaha', sourceRouterMap);
  connectionHistory.set(key, {
    ...entry,
    dport: entry.dport ?? 0,
    proto: entry.proto || 'TCP',
    observedBy,
    source: compatibilitySource(observedBy),
  });
}

module.exports = {
  loadConnectionHistory,
  appendHistoryLog,
  appendHistoryLogs,
  snapshotHistory,
  compactHistoryLog,
  pruneHistory,
  getConnectionHistory,
  cacheConnection,
  getConnection,
  setHotMaxEntries,
  getMemoryStats,
  queryByTimeRange,
  queryByTimeRangePaged,
  countByTimeRange,
  countFactsByTimeRange,
  createConnectionExportReader,
  seedConnections,
  groupDstByTimeRange,
  groupServiceByTimeRange,
  groupSrcForDstsByTimeRange,
  summarizeByTimeRange,
  ...aiConversationStore,
  getKnownMacs,
  upsertRouterMetadata,
  tombstoneRouterMetadata,
  logNotification,
  queryNotificationLog,
  queryNewNodes,
  setRetentionDays,
  closeDb,
  checkObservationConsistency,
  observationIdsForSource: source => expandSourceToRouterIds(source, sourceRouterMap),
  HISTORY_TTL_MS,
  DEFAULT_HOT_MAX_ENTRIES,
  _initForTest,
  _appendAndLoad,
};
