// Connection history: SQLite-backed storage (better-sqlite3 — native, WAL mode)
'use strict';
const logger = require('./logger');
const { summarizeAppGroups } = require('./app-classifier');

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = process.env.EGRESSVIEW_DB_PATH
  ? path.resolve(process.env.EGRESSVIEW_DB_PATH)
  : path.join(__dirname, '..', '.egressview.db');
const JSONL_PATH = path.join(__dirname, '..', '.egressview.connections.jsonl');
const HISTORY_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years (default)
let historyTtlMs = HISTORY_TTL_MS;

let db = null;
let stmtUpsert = null;
let stmtSelectAll = null;
let stmtDeleteOld = null;
let stmtInsertNotifLog = null;
let currentDbPath = DEFAULT_DB_PATH;

// In-memory cache (same interface as before for Socket.IO emissions)
const connectionHistory = new Map();

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

function initDb(dbPath) {
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
      PRIMARY KEY (src, dst, dport, proto)
    );
    CREATE INDEX IF NOT EXISTS idx_lastSeen ON connections(lastSeen);
    CREATE INDEX IF NOT EXISTS idx_src ON connections(src);
    CREATE INDEX IF NOT EXISTS idx_dst ON connections(dst);
  `);

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

  stmtSelectAll = db.prepare(`SELECT * FROM connections WHERE lastSeen >= ?`);
  stmtDeleteOld = db.prepare(`DELETE FROM connections WHERE lastSeen < ?`);

  logger.info('[history] SQLite database initialized (WAL mode)');
}

function upsertEntry(entry) {
  stmtUpsert.run({
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
  });
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
  const rows = stmtSelectAll.all(cutoff);
  connectionHistory.clear();
  for (const row of rows) {
    const key = `${row.src}|${row.dst}|${row.dport}|${row.proto}`;
    connectionHistory.set(key, row);
  }
  logger.info(`[history] Loaded ${connectionHistory.size} sessions from SQLite`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function loadConnectionHistory(dbPath) {
  if (db) { try { db.close(); } catch {} db = null; }  // close stale connection before reopening
  initDb(dbPath);
  migrateFromJsonl();
  loadIntoMemory();
}

function appendHistoryLog(entry) {
  try {
    upsertEntry(entry);
  } catch (err) {
    logger.error('[history] upsert error:', err.message);
  }
}

// Batch sync: write all current in-memory entries to SQLite
function snapshotHistory() {
  if (!db || connectionHistory.size === 0) return;
  const upsertMany = db.transaction(() => {
    for (const entry of connectionHistory.values()) {
      upsertEntry(entry);
    }
  });
  upsertMany();
  logger.info(`[history] Snapshot ${connectionHistory.size} entries to SQLite`);
}

// Delete old entries from SQLite
function compactHistoryLog() {
  if (!db) return;
  const cutoff = Date.now() - historyTtlMs;
  const info = stmtDeleteOld.run(cutoff);
  if (info.changes > 0) {
    logger.info(`[history] Pruned ${info.changes} old entries from SQLite`);
  }
}

// Prune memory cache
function pruneHistory() {
  const cutoff = Date.now() - historyTtlMs;
  for (const [k, v] of connectionHistory) {
    if (v.lastSeen < cutoff) connectionHistory.delete(k);
  }
}

function getConnectionHistory() { return connectionHistory; }

function queryByTimeRange(from, to) {
  if (!db) return [];
  const conditions = [];
  const params = [];
  if (from != null) { conditions.push('lastSeen >= ?'); params.push(from); }
  if (to   != null) { conditions.push('lastSeen <= ?'); params.push(to); }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM connections${where} ORDER BY lastSeen DESC`).all(...params);
}

// Safe whitelist for ORDER BY column names
const SORT_COL_SQL = {
  lastSeen: 'lastSeen',
  src:      'src',
  dst:      'dstHost, dst',
  dport:    'dport',
  proto:    'proto',
  country:  'country',
  org:      'org',
};

function escapeLikeValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function makeLikePat(mode, value) {
  const v = escapeLikeValue(value);
  if (mode === 'startsWith') return v + '%';
  if (mode === 'endsWith')   return '%' + v;
  return '%' + v + '%'; // contains (default)
}

function buildFilterConditions(filters) {
  const conditions = [];
  const params = [];
  if (filters.src?.value) {
    if (filters.src.mode === 'exact') {
      conditions.push('src = ?');
      params.push(filters.src.value);
    } else {
      const p = makeLikePat(filters.src.mode, filters.src.value);
      conditions.push("(src LIKE ? ESCAPE '\\' OR srcDnsName LIKE ? ESCAPE '\\' OR srcMdnsName LIKE ? ESCAPE '\\')");
      params.push(p, p, p);
    }
  }
  if (filters.dst?.value) {
    const p = makeLikePat(filters.dst.mode, filters.dst.value);
    conditions.push("(dst LIKE ? ESCAPE '\\' OR dstHost LIKE ? ESCAPE '\\')");
    params.push(p, p);
  }
  if (filters.dport?.value) {
    const p = makeLikePat(filters.dport.mode, filters.dport.value);
    conditions.push("CAST(dport AS TEXT) LIKE ? ESCAPE '\\'");
    params.push(p);
  }
  if (filters.proto?.value) {
    const p = makeLikePat(filters.proto.mode, filters.proto.value);
    conditions.push("proto LIKE ? ESCAPE '\\'");
    params.push(p);
  }
  if (filters.country?.value) {
    const p = makeLikePat(filters.country.mode, filters.country.value);
    conditions.push("country LIKE ? ESCAPE '\\'");
    params.push(p);
  }
  if (filters.org?.value) {
    const p = makeLikePat(filters.org.mode, filters.org.value);
    conditions.push("org LIKE ? ESCAPE '\\'");
    params.push(p);
  }
  if (filters.srcMac?.value) {
    // MAC is always exact match (no LIKE — colons and case must match stored value)
    conditions.push('srcMac = ?');
    params.push(filters.srcMac.value);
  }
  return { conditions, params };
}

function buildWhereAndParams(from, to, filterConditions) {
  const conditions = [];
  const params = [];
  if (from != null) { conditions.push('lastSeen >= ?'); params.push(from); }
  if (to   != null) { conditions.push('lastSeen <= ?'); params.push(to); }
  conditions.push(...filterConditions.conditions);
  params.push(...filterConditions.params);
  return {
    where:  conditions.length ? ' WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

function queryByTimeRangePaged(from, to, limit, offset, { sort = 'lastSeen', sortDir = 'desc', filters = {} } = {}) {
  if (!db) return [];
  const sortSql = SORT_COL_SQL[sort] || 'lastSeen';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const fc = buildFilterConditions(filters);
  const { where, params } = buildWhereAndParams(from, to, fc);
  // Apply direction to each comma-separated sort column (e.g. 'dstHost, dst')
  const orderClause = sortSql.split(',').map(c => c.trim() + ' ' + dir).join(', ');
  if (limit == null) {
    return db.prepare(
      `SELECT * FROM connections${where} ORDER BY ${orderClause}`
    ).all(...params);
  }
  return db.prepare(
    `SELECT * FROM connections${where} ORDER BY ${orderClause} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
}

function countByTimeRange(from, to, { filters = {} } = {}) {
  if (!db) return 0;
  const fc = buildFilterConditions(filters);
  const { where, params } = buildWhereAndParams(from, to, fc);
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM connections${where}`).get(...params);
  return row ? row.cnt : 0;
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

// Returns unique (dst, dstHost) pairs with connection counts for the time range.
// Used by the threat-counts endpoint to apply JS-side threat matching without
// fetching every row — only unique destinations need to be checked.
function groupDstByTimeRange(from, to, { filters = {} } = {}) {
  if (!db) return [];
  const fc = buildFilterConditions(filters);
  const { where, params } = buildWhereAndParams(from, to, fc);
  return db.prepare(
    `SELECT dst, MAX(dstHost) AS dstHost, COUNT(*) AS cnt FROM connections${where} GROUP BY dst`
  ).all(...params);
}

function summarizeByTimeRange(from, to, { src = null, buckets = 60 } = {}) {
  if (!db) return { byDst: [], byDevice: [] };
  const conditions = [];
  const params = [];
  if (from != null) { conditions.push('lastSeen >= ?'); params.push(from); }
  if (to   != null) { conditions.push('lastSeen <= ?'); params.push(to); }
  if (src  != null) { conditions.push('src = ?');       params.push(src); }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const targetExpr = "COALESCE(NULLIF(org, ''), NULLIF(dstHost, ''), dst)";
  const countRow = db.prepare(
    `SELECT COUNT(*) as total, MIN(lastSeen) as minLastSeen, MAX(lastSeen) as maxLastSeen
     FROM connections${where}`
  ).get(...params) || {};
  const total = countRow.total || 0;
  const rangeFrom = from ?? countRow.minLastSeen ?? Date.now();
  const rangeTo = to ?? countRow.maxLastSeen ?? Date.now();
  const bucketCount = Math.max(1, Math.min(240, Number(buckets) || 60));
  const bucketMs = Math.max(1, (Math.max(rangeTo, rangeFrom + 1) - rangeFrom) / bucketCount);

  const byDst = db.prepare(
    `SELECT dst, dstHost, country, org,
            COUNT(*) as count, MIN(firstSeen) as firstSeen, MAX(lastSeen) as lastSeen
     FROM connections${where}
     GROUP BY dst ORDER BY count DESC LIMIT 500`
  ).all(...params);
  const byDevice = db.prepare(
    `SELECT src, srcMac, srcVendor,
            COUNT(*) as count, MIN(firstSeen) as firstSeen, MAX(lastSeen) as lastSeen
     FROM connections${where}
     GROUP BY src ORDER BY count DESC LIMIT 200`
  ).all(...params);
  const byTarget = db.prepare(
    `SELECT ${targetExpr} as key, ${targetExpr} as label,
            COUNT(*) as count, MIN(firstSeen) as firstSeen, MAX(lastSeen) as lastSeen
     FROM connections${where}
     GROUP BY key ORDER BY count DESC LIMIT 1000`
  ).all(...params);
  const byEdge = db.prepare(
    `SELECT src, ${targetExpr} as key,
            COUNT(*) as count, MIN(firstSeen) as firstSeen, MAX(lastSeen) as lastSeen
     FROM connections${where}
     GROUP BY src, key ORDER BY count DESC LIMIT 3000`
  ).all(...params);
  const LOCATION_LIMIT = 500;
  const byLocation = db.prepare(
    `SELECT ${targetExpr} as key, ${targetExpr} as org,
            country, city, lat, lon,
            COUNT(*) as totalSessions, COUNT(DISTINCT src) as srcCount,
            MAX(ttl) as maxTtl, MIN(firstSeen) as firstSeen, MAX(lastSeen) as lastSeen
     FROM connections${where}${where ? ' AND' : ' WHERE'} lat IS NOT NULL AND lon IS NOT NULL
     GROUP BY key, lat, lon ORDER BY totalSessions DESC LIMIT ?`
  ).all(...params, LOCATION_LIMIT);
  const locationStats = db.prepare(
    `SELECT COUNT(*) as totalGroups, COALESCE(SUM(totalSessions), 0) as totalSessions
     FROM (
       SELECT COUNT(*) as totalSessions
       FROM connections${where}${where ? ' AND' : ' WHERE'} lat IS NOT NULL AND lon IS NOT NULL
       GROUP BY ${targetExpr}, lat, lon
     )`
  ).get(...params) || {};
  const locationTotalSessions = locationStats.totalSessions || 0;
  const locationShownSessions = byLocation.reduce((sum, r) => sum + (r.totalSessions || 0), 0);
  const locationTotalGroups = locationStats.totalGroups || 0;
  const appRows = db.prepare(
    `SELECT dport, proto, COALESCE(NULLIF(dstHost, ''), dst) as dstHost,
            COUNT(*) as count
     FROM connections${where}
     GROUP BY dport, proto, dstHost ORDER BY count DESC`
  ).all(...params);
  const appGroups = summarizeAppGroups(appRows);
  const timeline = db.prepare(
    `SELECT ${targetExpr} as key,
            CASE
              WHEN lastSeen < ? THEN 0
              WHEN lastSeen >= ? THEN ?
              ELSE CAST((lastSeen - ?) / ? AS INTEGER)
            END as bucket,
            COUNT(*) as count
     FROM connections${where}
     GROUP BY key, bucket ORDER BY bucket ASC, count DESC`
  ).all(rangeFrom, rangeTo, bucketCount - 1, rangeFrom, bucketMs, ...params);
  return {
    byDst,
    byDevice,
    byTarget,
    byEdge,
    byLocation,
    mapCoverage: {
      limit: LOCATION_LIMIT,
      totalGroups: locationTotalGroups,
      shownGroups: byLocation.length,
      totalSessions: locationTotalSessions,
      shownSessions: locationShownSessions,
      percent: locationTotalSessions ? (locationShownSessions / locationTotalSessions) * 100 : 0,
      capped: locationTotalGroups > byLocation.length,
    },
    appGroups,
    timeline,
    total,
    buckets: bucketCount,
    from: rangeFrom,
    to: rangeTo,
  };
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
function _initForTest(dbPath) {
  if (db) { try { db.close(); } catch {} db = null; }
  connectionHistory.clear();
  initDb(dbPath || ':memory:');
}

/** Insert into DB AND sync to in-memory Map (for WebSocket filter tests). */
function _appendAndLoad(entry) {
  appendHistoryLog(entry);
  const key = `${entry.src}|${entry.dst}|${entry.dport ?? 0}|${entry.proto || 'TCP'}`;
  connectionHistory.set(key, { ...entry, dport: entry.dport ?? 0, proto: entry.proto || 'TCP' });
}

module.exports = {
  loadConnectionHistory,
  appendHistoryLog,
  snapshotHistory,
  compactHistoryLog,
  pruneHistory,
  getConnectionHistory,
  queryByTimeRange,
  queryByTimeRangePaged,
  countByTimeRange,
  seedConnections,
  groupDstByTimeRange,
  summarizeByTimeRange,
  getKnownMacs,
  logNotification,
  queryNotificationLog,
  queryNewNodes,
  setRetentionDays,
  closeDb,
  HISTORY_TTL_MS,
  _initForTest,
  _appendAndLoad,
};
