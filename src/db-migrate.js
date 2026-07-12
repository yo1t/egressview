// Schema migration runner with fail-closed pre-migration backup (P2-33).
//
// Usage: call runMigrations(db, dbPath) immediately after opening the DB and
// before executing any CREATE TABLE / ALTER TABLE statements.
//
// Version tracking uses PRAGMA user_version (built-in SQLite integer, starts at 0).
// Each migration is idempotent so databases upgraded ad-hoc before this system
// was introduced are handled safely.
//
// Fail-closed policy: when pending migrations exist on a non-empty on-disk DB,
// a verified backup is REQUIRED before any change. Insufficient disk space, a
// busy WAL checkpoint, a failed copy, or a corrupt backup copy all abort the
// migration by throwing — the caller (history.js startup) lets the error
// propagate so the process stops with the DB unmodified.
//
// Scope: connections table and notification_log (history.js tables).
// devices.js manages its own ad-hoc ALTER TABLE checks independently because
// it opens the same DB file in a separate connection after history.js has
// already advanced user_version.
'use strict';

const logger   = require('./logger');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 3;

// Backup copy (1x DB size) plus WAL growth and migration workspace headroom.
const MIN_FREE_DISK_FACTOR = 2;

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

// ─── Fail-closed backup helpers ───────────────────────────────────────────────

/**
 * Throw when the filesystem holding the DB lacks room for the backup copy
 * plus migration workspace.
 */
function _assertDiskSpace(dbPath, requiredBytes) {
  const st   = fs.statfsSync(path.dirname(dbPath));
  const free = st.bsize * st.bavail;
  if (free < requiredBytes) {
    throw new Error(`[migrate] Not enough free disk space for pre-migration backup: ` +
                    `need ${requiredBytes} bytes, have ${free} bytes free`);
  }
}

/**
 * Open a backup copy read-only and verify it is a complete, healthy SQLite DB.
 * Throws when the copy cannot be opened or integrity_check is not 'ok'.
 */
function _verifyDbCopy(bakPath) {
  let d = null;
  try {
    d = new Database(bakPath, { readonly: true, fileMustExist: true });
    const result = d.pragma('integrity_check')[0]?.integrity_check;
    if (result !== 'ok') {
      throw new Error(`integrity_check returned '${result}'`);
    }
  } finally {
    if (d) { try { d.close(); } catch {} }
    // Opening a WAL-mode DB creates empty -wal/-shm sidecars even read-only;
    // remove them so the backup stays a single self-contained file.
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(bakPath + suffix); } catch {}
    }
  }
}

/**
 * Create a verified pre-migration backup, or throw without touching the DB.
 * Steps (each one fail-closed): disk-space check → strict WAL checkpoint →
 * file copy → integrity_check on the copy.
 * @returns {string} path of the verified backup
 */
function _createVerifiedBackup(db, dbPath, fromVersion, toVersion) {
  const dbSize = fs.statSync(dbPath).size;
  _assertDiskSpace(dbPath, dbSize * MIN_FREE_DISK_FACTOR);

  // Strict checkpoint: a busy result means another connection blocked the
  // truncate and the -wal file may still hold unmerged pages, so a plain file
  // copy would be incomplete. Abort instead of copying a torn snapshot.
  const ck = db.pragma('wal_checkpoint(TRUNCATE)')[0];
  if (!ck || ck.busy !== 0) {
    throw new Error(`[migrate] WAL checkpoint did not complete (busy=${ck ? ck.busy : 'unknown'}); ` +
                    'refusing to copy a potentially incomplete database');
  }

  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bakName = `${path.basename(dbPath)}.pre-migration.v${fromVersion}-to-v${toVersion}.${ts}.bak`;
  const bakPath = path.join(path.dirname(dbPath), bakName);

  fs.copyFileSync(dbPath, bakPath);
  try { fs.chmodSync(bakPath, 0o600); } catch {}

  try {
    _verifyDbCopy(bakPath);
  } catch (e) {
    try { fs.unlinkSync(bakPath); } catch {}
    throw new Error(`[migrate] Backup verification failed (${e.message}); ` +
                    'migration aborted with the database unmodified', { cause: e });
  }

  logger.info(`[migrate] Verified pre-migration backup saved: ${bakName}`);
  return bakPath;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run any pending schema migrations against `db`.
 *
 * Throws (aborting startup) when the pre-migration backup cannot be created
 * and verified, when a migration fails, or when the post-migration
 * integrity check fails. Recovery: restore the backup file named in the log
 * over the DB path, then start the previous binary.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} dbPath  Absolute path to the DB file, or ':memory:'
 */
function runMigrations(db, dbPath) {
  const currentVersion = db.pragma('user_version', { simple: true }) || 0;
  const pending = MIGRATIONS.filter(m => m.version > currentVersion);

  if (pending.length === 0) return;

  const isOnDisk = dbPath && dbPath !== ':memory:';

  // Take a verified pre-migration backup when there is an existing DB file
  // with tables (skip for fresh databases — nothing to protect yet).
  // Any backup failure throws and leaves the DB unmodified.
  let bakPath = null;
  if (isOnDisk && fs.existsSync(dbPath)) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get().n;
    if (n > 0) {
      bakPath = _createVerifiedBackup(db, dbPath, currentVersion, SCHEMA_VERSION);
    }
  }

  const recoveryHint = bakPath
    ? ` Recovery: restore ${bakPath} over ${dbPath}, then start the previous binary.`
    : '';

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
      logger.error(`[migrate] v${mig.version} FAILED: ${e.message}.${recoveryHint}`);
      throw e;
    }
  }

  // Post-migration verification: the DB must be healthy and fully upgraded
  // before normal startup continues.
  const ic = db.pragma('integrity_check')[0]?.integrity_check;
  if (ic !== 'ok') {
    const msg = `[migrate] Post-migration integrity_check returned '${ic}'.${recoveryHint}`;
    logger.error(msg);
    throw new Error(msg);
  }
  const v = db.pragma('user_version', { simple: true });
  if (v !== SCHEMA_VERSION) {
    const msg = `[migrate] Post-migration user_version is ${v}, expected ${SCHEMA_VERSION}.${recoveryHint}`;
    logger.error(msg);
    throw new Error(msg);
  }
}

module.exports = {
  runMigrations,
  SCHEMA_VERSION,
  // exposed for unit tests
  _assertDiskSpace,
  _verifyDbCopy,
  _MIGRATIONS: MIGRATIONS,
};
