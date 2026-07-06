// Schema migration runner with pre-migration backup.
//
// Usage: call runMigrations(db, dbPath) immediately after opening the DB and
// before executing any CREATE TABLE / ALTER TABLE statements.
//
// Version tracking uses PRAGMA user_version (built-in SQLite integer, starts at 0).
// Each migration is idempotent so databases upgraded ad-hoc before this system
// was introduced are handled safely.
//
// Scope: connections table and notification_log (history.js tables).
// devices.js manages its own ad-hoc ALTER TABLE checks independently because
// it opens the same DB file in a separate connection after history.js has
// already advanced user_version.
'use strict';

const logger = require('./logger');
const fs     = require('fs');
const path   = require('path');

const SCHEMA_VERSION = 3;

// ─── Migration definitions ────────────────────────────────────────────────────

const MIGRATIONS = [
  {
    version: 1,
    description: 'connections table + notification_log (initial schema)',
    // CREATE TABLE IF NOT EXISTS in history.js handles fresh databases.
    // This migration covers the baseline so user_version advances on existing DBs.
    up(_db) {},
  },
  {
    version: 2,
    description: 'connections.source column (yamaha / cisco / …)',
    up(db) {
      // Fresh DB: CREATE TABLE IF NOT EXISTS (called after migrations) will
      // include all columns — no ALTER needed.
      const hasTbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`).get();
      if (!hasTbl) return;
      const cols = db.prepare('PRAGMA table_info(connections)').all().map(r => r.name);
      if (!cols.includes('source')) {
        db.exec(`ALTER TABLE connections ADD COLUMN source TEXT NOT NULL DEFAULT 'yamaha'`);
        logger.info('[migrate] v2: added connections.source');
      }
    },
  },
  {
    version: 3,
    description: 'connections.agentHost / .process / .pid columns',
    up(db) {
      const hasTbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`).get();
      if (!hasTbl) return;
      const cols = db.prepare('PRAGMA table_info(connections)').all().map(r => r.name);
      if (!cols.includes('agentHost')) db.exec('ALTER TABLE connections ADD COLUMN agentHost TEXT');
      if (!cols.includes('process'))   db.exec('ALTER TABLE connections ADD COLUMN process   TEXT');
      if (!cols.includes('pid'))       db.exec('ALTER TABLE connections ADD COLUMN pid       INTEGER');
      logger.info('[migrate] v3: added connections.agentHost/process/pid');
    },
  },
];

// ─── Backup helper ────────────────────────────────────────────────────────────

/**
 * Create a timestamped copy of the DB file before running migrations.
 * Checkpoints WAL first so the backup is a complete, self-contained snapshot.
 */
function _backupBeforeMigration(db, dbPath, fromVersion, toVersion) {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}

  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bakName = `${path.basename(dbPath)}.pre-migration.v${fromVersion}-to-v${toVersion}.${ts}.bak`;
  const bakPath = path.join(path.dirname(dbPath), bakName);

  try {
    fs.copyFileSync(dbPath, bakPath);
    try { fs.chmodSync(bakPath, 0o600); } catch {}
    logger.info(`[migrate] Pre-migration backup saved: ${bakName}`);
    return bakPath;
  } catch (e) {
    logger.warn(`[migrate] Could not write pre-migration backup (${bakPath}): ${e.message}`);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run any pending schema migrations against `db`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dbPath  Absolute path to the DB file, or ':memory:'
 */
function runMigrations(db, dbPath) {
  const currentVersion = db.pragma('user_version', { simple: true }) || 0;
  const pending = MIGRATIONS.filter(m => m.version > currentVersion);

  if (pending.length === 0) return;

  const isOnDisk = dbPath && dbPath !== ':memory:';

  // Take a pre-migration backup when there is an existing DB file with tables
  // (skip for fresh databases — nothing to protect yet).
  if (isOnDisk && fs.existsSync(dbPath)) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get().n;
    if (n > 0) {
      _backupBeforeMigration(db, dbPath, currentVersion, SCHEMA_VERSION);
    }
  }

  // Apply each pending migration in its own transaction
  for (const mig of pending) {
    logger.info(`[migrate] Applying v${mig.version}: ${mig.description}`);
    try {
      db.transaction(() => {
        mig.up(db);
        db.pragma(`user_version = ${mig.version}`);
      })();
      logger.info(`[migrate] v${mig.version} OK`);
    } catch (e) {
      logger.error(`[migrate] v${mig.version} FAILED: ${e.message}`);
      throw e;
    }
  }
}

module.exports = { runMigrations, SCHEMA_VERSION };
