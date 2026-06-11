// Connection history: SQLite-backed storage (better-sqlite3 — native, WAL mode)
'use strict';
const logger = require('./logger');

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.widemap.db');
const JSONL_PATH = path.join(__dirname, '..', '.widemap.connections.jsonl');
const HISTORY_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years (default)
let historyTtlMs = HISTORY_TTL_MS;

let db = null;
let stmtUpsert = null;
let stmtSelectAll = null;
let stmtDeleteOld = null;

// In-memory cache (same interface as before for Socket.IO emissions)
const connectionHistory = new Map();

function _secureDbFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.chmodSync(DB_PATH + suffix, 0o600); } catch {}
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
  const actualPath = dbPath || DB_PATH;
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
    firstSeen: entry.firstSeen || Date.now(),
    lastSeen: entry.lastSeen || Date.now(),
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

function loadConnectionHistory() {
  if (db) { try { db.close(); } catch {} db = null; }  // close stale connection before reopening
  initDb();
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
  getKnownMacs,
  setRetentionDays,
  closeDb,
  HISTORY_TTL_MS,
  _initForTest,
  _appendAndLoad,
};
