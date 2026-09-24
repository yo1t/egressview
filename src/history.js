// Connection history: SQLite-backed storage (better-sqlite3 — native, WAL mode)
'use strict';
const logger = require('./logger');
const { summarizeAppGroups } = require('./app-classifier');

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { runMigrations, SCHEMA_VERSION } = require('./db-migrate');
const {
  checkLiveDatabase, isCorruptionError, restoreFromCandidates, DbRestoreFailClosedError,
} = require('./db-restore');
const {
  takeCleanShutdownMarker, chooseStartupCheck, writeCleanShutdownMarker, openHandlesTo,
} = require('./db-startup-check');
const { MIGRATED_IDS, expandSourceToRouterIds, routerKindForId } = require('./router-id');
const { checkObservationConsistency: checkConsistency } = require('./observation-consistency');
const { createHistoryCache, DEFAULT_HOT_MAX_ENTRIES } = require('./history-cache');
const { createHistoryQueries } = require('./history-queries');
const { createAgentAttribution } = require('./agent-attribution');
const { createAiConversationStore } = require('./ai-conversation-store');
const { createAiUsageStore } = require('./ai-usage-store');
const { createAiNotificationStore } = require('./ai-notification-store');
const { CONNECTIONS_SQL, OBSERVATIONS_SQL, EVENTS_SQL } = require('./history-schema');
const { reportSchemaCompleteness } = require('./schema-completeness');
const { applyWalPragmas } = require('./sqlite-wal');
const { createConnectionBuckets } = require('./connection-buckets');
const routerPollWindows = require('./router-poll-windows');
const { createAgentAppDaily } = require('./agent-app-daily');

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

// The source tag for a flow an endpoint agent reported. Kept apart from the
// router source values because an agent observation carries a process name and
// no router identity.
const AGENT_SOURCE = 'agent';

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
  groupAgentOnlyDstByTimeRange,
  groupDstByTimeRange,
  groupServiceByTimeRange,
  groupSrcForDstsByTimeRange,
  groupSrcByTimeRange,
  listSourceDeviceKeys,
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

// When traffic happened, folded once per closed five-minute window. See
// connection-buckets.js for why `connections` cannot answer this itself.
const connectionBuckets = createConnectionBuckets({ getDb: () => db, logger });
const agentAppDaily = createAgentAppDaily({ getDb: () => db, logger });

const aiConversationStore = createAiConversationStore({ getDb: () => db });
const aiUsageStore = createAiUsageStore({ getDb: () => db });
const aiNotificationStore = createAiNotificationStore({ getDb: () => db });
const agentAttribution = createAgentAttribution({ getDb: () => db });

function attachAgentAttributions(rows, options) {
  return agentAttribution.attach(rows, options);
}

function _secureDbFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.chmodSync(currentDbPath + suffix, 0o600); } catch {}
  }
}

function _openDb(p) {
  const d = new Database(p);
  applyWalPragmas(d);
  d.pragma('busy_timeout = 5000');
  return d;
}

// The tables a Hub database cannot be without. A candidate lacking them is not
// a backup of this Hub, whatever `integrity_check` says -- an empty file passes
// that check with no tables at all.
const RESTORE_REQUIRED_TABLES = ['connections'];

// What the startup check did, and when the database was last checked in full.
// Carried to the clean-shutdown marker, so the next start knows how old the
// last full check is (db-startup-check.js).
let startupCheck = null;
let lastFullCheckAt = null;
let closedCleanly = false;

/** Backup files newest first, as paths. */
function _backupCandidates() {
  const backup = require('./backup');  // lazy: backup.js has no dependency on history.js
  return backup.listBackups()
    .slice()
    .reverse()
    .map(entry => backup.getBackupPath(entry.name))
    .filter(Boolean);
}

function initDb(dbPath, { sourceRouterMap: mapOverride, onProgress } = {}) {
  if (mapOverride) sourceRouterMap = mapOverride;
  ensuredRouterIds = new Set();
  const actualPath = dbPath === ':memory:' ? ':memory:' : (dbPath ? path.resolve(dbPath) : DEFAULT_DB_PATH);
  currentDbPath = actualPath;
  // Startup check, failing closed (db-restore.js says why). Only a check that
  // ran and found damage leads to a restore, and the restore never removes the
  // live file until a backup has been copied beside it and verified. Anything
  // else stops the start with the files as they were.
  closedCleanly = false;
  lastFullCheckAt = null;
  let checkPlan = { mode: 'full', reason: 'in-memory database' };
  if (actualPath !== ':memory:') {
    const marker = takeCleanShutdownMarker(actualPath);
    checkPlan = chooseStartupCheck(marker);
    lastFullCheckAt = marker.lastFullCheckAt;
  }

  let damaged = false;
  try {
    db = _openDb(actualPath);
  } catch (error) {
    if (!isCorruptionError(error)) {
      throw new DbRestoreFailClosedError(
        `The database could not be opened (${error.code || error.message}). `
        + 'It has not been touched. Stopping rather than guessing.',
        { cause: error }
      );
    }
    db = null;
    damaged = true;
  }
  _secureDbFiles();
  const checkStartedAt = Date.now();
  if (db && checkLiveDatabase(db, { mode: checkPlan.mode }) === 'corrupt') damaged = true;
  startupCheck = {
    ...checkPlan,
    ms: Date.now() - checkStartedAt,
    result: damaged ? 'damaged' : 'ok',
  };
  if (!damaged && checkPlan.mode === 'full') lastFullCheckAt = Date.now();
  logger.info(`[history] Startup check: ${checkPlan.mode === 'quick' ? 'quick_check' : 'integrity_check'} `
    + `(${checkPlan.reason}) -- ${startupCheck.result} in ${(startupCheck.ms / 1000).toFixed(1)} s`);

  if (damaged) {
    logger.error('[history] Database integrity check failed; looking for a backup that verifies');
    if (db) { try { db.close(); } catch {} db = null; }
    if (actualPath === ':memory:') {
      throw new DbRestoreFailClosedError('An in-memory database failed its check.');
    }
    restoreFromCandidates({
      targetPath: actualPath,
      candidates: _backupCandidates(),
      Database,
      maxSchemaVersion: SCHEMA_VERSION,
      requiredTables: RESTORE_REQUIRED_TABLES,
      logger,
    });
    db = _openDb(actualPath);
    _secureDbFiles();
    // The restored copy was verified in full before it was swapped in.
    lastFullCheckAt = Date.now();
  }

  // Run versioned migrations (takes pre-migration backup if pending changes exist)
  runMigrations(db, actualPath, { sourceRouterMap, onProgress });
  onProgress?.('initializing');

  // Create tables for fresh databases (idempotent — skipped if already exist)
  db.exec(CONNECTIONS_SQL);
  db.exec(OBSERVATIONS_SQL);
  routerKinds = new Map(db.prepare('SELECT id, kind FROM routers').all().map(row => [row.id, row.kind]));

  db.exec(EVENTS_SQL);

  // Said before anything prepares a statement against a table that may not be
  // there. `integrity_check` above passes with a table missing, so without
  // this the first symptom is a query failing much later (P2-97).
  reportSchemaCompleteness({
    db,
    Database,
    runMigrations,
    sourceRouterMap,
    logger,
    version: db.pragma('user_version', { simple: true }),
  });

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
    INSERT INTO connections (src, dst, dport, proto, sport, ttl, srcMac, srcVendor, srcDnsName, srcMdnsName, dstHost, country, org, lat, lon, city, firstSeen, lastSeen, agentHost, process, pid)
    VALUES (@src, @dst, @dport, @proto, @sport, @ttl, @srcMac, @srcVendor, @srcDnsName, @srcMdnsName, @dstHost, @country, @org, @lat, @lon, @city, @firstSeen, @lastSeen, @agentHost, @process, @pid)
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
      lastSeen = MAX(lastSeen, @lastSeen),
      -- Written by whichever side knows: a router poll carries no process name
      -- and must not erase the one an agent supplied for the same flow.
      agentHost = COALESCE(@agentHost, agentHost),
      process = COALESCE(@process, process),
      pid = COALESCE(@pid, pid)
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
    // Entries reach this from several places -- pollers, snapshots, replayed
    // history -- and only agent-fed ones carry these. Defaulted here so a
    // caller that predates them is not required to know about them.
    stmtUpsert.run({
      ...entry,
      agentHost: entry.agentHost ?? null,
      process: entry.process ?? null,
      pid: entry.pid ?? null,
    });
    const observedBy = normalizeObservedBy(entry.observedBy);
    // An agent is not a router. Falling through to the source expansion here
    // would invent a placeholder router row and put a machine into the router
    // list, so a flow only an agent saw records no router observation at all.
    if (!observedBy.length && entry.source === AGENT_SOURCE) return;
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
    // Only an endpoint agent supplies these, and this function decides the
    // shape of everything that reaches SQLite. Leaving them out here silently
    // discarded the one fact a router can never provide.
    agentHost: entry.agentHost || null,
    process: entry.process || null,
    pid: Number.isInteger(entry.pid) ? entry.pid : null,
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
  // These rows came out of SQLite, so they are already there. Without this the
  // first snapshot after startup would write the whole cache back for nothing.
  lastSnapshotAt = Date.now();
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

// Overlap on the window below. It costs a few extra rows and removes any
// dependence on the two clocks agreeing, or on a write landing before the
// snapshot that is already running reads the map.
const SNAPSHOT_OVERLAP_MS = 60 * 1000;
let lastSnapshotAt = 0;

/**
 * Persist the entries whose lastSeen moved since the previous snapshot.
 *
 * What this exists for is the plain lastSeen/count bump: recordConnections
 * writes new and observer-changed entries inline, but not those, so without a
 * snapshot they would live only in memory.
 *
 * It used to write the whole hot cache. Measured on one Hub 2026-09-19: 99,698
 * entries rewritten every ten minutes to save about 100 that had changed,
 * blocking the event loop for 5 to 9.8 seconds each time -- the device list,
 * the connection log and every static file waited behind it. Anything that
 * changes an entry some other way (enrichment, threat re-match) persists it
 * itself.
 */
function snapshotHistory() {
  if (!db || connectionHistory.size === 0) return;
  const startedAt = Date.now();
  const since = lastSnapshotAt ? lastSnapshotAt - SNAPSHOT_OVERLAP_MS : 0;
  const pending = [];
  for (const entry of connectionHistory.values()) {
    if ((entry.lastSeen || 0) >= since) pending.push(entry);
  }
  lastSnapshotAt = startedAt;
  if (!pending.length) return;
  appendHistoryLogs(pending);
  logger.info(`[history] Snapshot ${pending.length}/${connectionHistory.size} entries to SQLite`);
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

function queryNotificationLog(from, to, { sourceScope = null } = {}) {
  if (!db) return [];
  const conditions = [];
  const params = [];
  if (from != null) { conditions.push('detectedAt >= ?'); params.push(from); }
  if (to   != null) { conditions.push('detectedAt <= ?'); params.push(to); }
  if (sourceScope?.sourceKind === 'router') {
    conditions.push(`EXISTS (
      SELECT 1 FROM connections c
      JOIN connection_observations o
        ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      WHERE c.src = notification_log.src
        AND (notification_log.dst IS NULL OR c.dst = notification_log.dst)
        AND (notification_log.dport IS NULL OR c.dport = notification_log.dport)
        AND (notification_log.proto IS NULL OR LOWER(c.proto) = LOWER(notification_log.proto))
        AND o.routerId = ?
    )`);
    params.push(sourceScope.sourceId);
  } else if (sourceScope?.sourceKind === 'agent') {
    conditions.push(`EXISTS (
      SELECT 1 FROM agent_observations o
      WHERE o.agentId = ? AND o.localAddress = notification_log.src
        AND (notification_log.dst IS NULL OR o.remoteAddress = notification_log.dst)
        AND (notification_log.dport IS NULL OR o.remotePort = notification_log.dport)
        AND (notification_log.proto IS NULL OR LOWER(o.networkProtocol) = LOWER(notification_log.proto))
    )`);
    params.push(sourceScope.sourceId);
  } else if (sourceScope) {
    throw new TypeError('Unsupported source scope');
  }
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

// Which five-minute windows a router answered in. Written once per poll
// cycle, so the chart can tell "no answer" from "nothing was sent" (P3-157).
function recordPollWindow({ id, ok, at } = {}) {
  if (!db || !id) return;
  try {
    routerPollWindows.recordPoll(db, id, at || Date.now(), { ok: !!ok });
  } catch (err) {
    logger.warn(`[history] could not record the poll window for ${id}: ${err.message}`);
  }
}

function prunePollWindows() {
  if (!db) return 0;
  try {
    return routerPollWindows.prune(db);
  } catch (err) {
    logger.warn(`[history] could not prune the poll windows: ${err.message}`);
    return 0;
  }
}

function monitoringGaps({ from, to, now = Date.now() } = {}) {
  if (!db) return [];
  try {
    return routerPollWindows.pollGaps(db, { from, to, now });
  } catch (err) {
    logger.warn(`[history] could not read the poll windows: ${err.message}`);
    return [];
  }
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
    try {
      db.close();
      closedCleanly = true;
    } catch {
      closedCleanly = false;
    }
    db = null;
  }
}

/**
 * Records that this run stopped in an orderly way, so the next start can use
 * the quick check. Called by the SIGTERM path after every database is closed,
 * and by nothing else. A marker has to be earned:
 *
 *   - this module's connection closed cleanly, and
 *   - the process holds no descriptor on the database, -wal, -shm or
 *     -journal at all -- whichever module opened it.
 *
 * @returns {{ written: boolean, reason: string }}
 */
function markCleanShutdown({ openHandles = openHandlesTo } = {}) {
  if (!currentDbPath || currentDbPath === ':memory:') return { written: false, reason: 'no database file' };
  if (db) return { written: false, reason: 'the database is still open' };
  if (!closedCleanly) return { written: false, reason: 'the database did not close cleanly' };
  const stillOpen = openHandles(currentDbPath);
  if (stillOpen && stillOpen.length) {
    return {
      written: false,
      reason: `${stillOpen.length} handle(s) to the database are still open: `
        + [...new Set(stillOpen.map(file => path.basename(file)))].join(', '),
    };
  }
  writeCleanShutdownMarker(currentDbPath, { lastFullCheckAt });
  return { written: true, reason: stillOpen ? 'every handle closed' : 'handles cannot be listed on this platform' };
}

/** What the startup check did: mode, reason, duration, result. */
function getStartupCheck() {
  return startupCheck ? { ...startupCheck, lastFullCheckAt } : null;
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
  connectionBuckets,
  agentAppDaily,
  compactHistoryLog,
  pruneHistory,
  getConnectionHistory,
  cacheConnection,
  getConnection,
  setHotMaxEntries,
  getMemoryStats,
  queryByTimeRange,
  queryByTimeRangePaged,
  attachAgentAttributions,
  countByTimeRange,
  countFactsByTimeRange,
  createConnectionExportReader,
  seedConnections,
  groupAgentOnlyDstByTimeRange,
  groupDstByTimeRange,
  groupServiceByTimeRange,
  groupSrcForDstsByTimeRange,
  groupSrcByTimeRange,
  listSourceDeviceKeys,
  summarizeByTimeRange,
  ...aiConversationStore,
  ...aiUsageStore,
  ...aiNotificationStore,
  getKnownMacs,
  upsertRouterMetadata,
  tombstoneRouterMetadata,
  recordPollWindow,
  monitoringGaps,
  prunePollWindows,
  logNotification,
  queryNotificationLog,
  queryNewNodes,
  setRetentionDays,
  closeDb,
  markCleanShutdown,
  getStartupCheck,
  checkObservationConsistency,
  // An agent has no router identity, so it contributes no router observation.
  // Without this it fell through to the legacy placeholder and a machine
  // appeared in the router list as "legacy-agent".
  observationIdsForSource: source =>
    (source === AGENT_SOURCE ? [] : expandSourceToRouterIds(source, sourceRouterMap)),
  HISTORY_TTL_MS,
  DEFAULT_HOT_MAX_ENTRIES,
  _initForTest,
  _appendAndLoad,
};
