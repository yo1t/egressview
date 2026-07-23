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
const {
  MIGRATED_IDS,
  expandSourceToRouterIds,
  routerKindForId,
} = require('./router-id');
const { checkObservationConsistency } = require('./observation-consistency');

const SCHEMA_VERSION = 8;

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
  {
    version: 4,
    description: 'routers table + connection_observations junction (P2-30, expand phase)',
    // Deliberately no FOREIGN KEY constraint: SQLite enforces PRAGMA
    // foreign_keys per connection and this file is opened by five modules.
    // history.js deletes junction rows in the same transaction as the
    // connections rows, and checkObservationConsistency() detects orphans.
    up(db, ctx = {}) {
      const map = ctx.sourceRouterMap || { yamaha: MIGRATED_IDS.yamaha, cisco: MIGRATED_IDS.cisco };
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

      const hasTbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`).get();
      if (!hasTbl) return; // fresh DB: nothing to backfill

      const now = Date.now();
      const ensureRouter = db.prepare(`
        INSERT INTO routers (id, kind, displayName, createdAt, deletedAt)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
      `);
      const insObs = db.prepare(`
        INSERT OR IGNORE INTO connection_observations
          (src, dst, dport, proto, routerId, firstObservedAt, lastObservedAt)
        SELECT src, dst, dport, proto, ?, firstSeen, lastSeen
        FROM connections WHERE source = ?
      `);

      // Routers whose config still exists get their deterministic migrated id
      // registered up front, even when they have no rows yet.
      for (const kind of ['yamaha', 'cisco']) {
        if (map[kind] === MIGRATED_IDS[kind]) {
          ensureRouter.run(map[kind], kind, map[kind], now, null);
        }
      }

      // Expand every legacy source value into observation rows.
      const sources = db.prepare(`SELECT source, COUNT(*) AS n FROM connections GROUP BY source`).all();
      const report = [];
      for (const { source, n } of sources) {
        const ids = expandSourceToRouterIds(source, map);
        for (const rid of ids) {
          const kind = routerKindForId(rid, map);
          // Legacy placeholders represent routers that no longer exist as
          // active config — mark them deleted so nothing tries to poll them.
          ensureRouter.run(rid, kind, rid, now, rid.startsWith('legacy-') ? now : null);
          insObs.run(rid, source);
        }
        report.push(`${source}→[${ids.join(',')}] (${n} rows)`);
      }
      logger.info(`[migrate] v4: source expansion: ${report.join('; ') || 'no rows'}`);

      // In-migration consistency gate: every connections row must now have at
      // least its expected number of observations. A mismatch rolls back the
      // whole migration (fail-closed, P2-33).
      const missing = db.prepare(`
        SELECT COUNT(*) AS n FROM connections c
        LEFT JOIN (
          SELECT src, dst, dport, proto, COUNT(*) AS obs
          FROM connection_observations GROUP BY src, dst, dport, proto
        ) o ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
        WHERE COALESCE(o.obs, 0) < CASE WHEN c.source = 'yamaha+cisco' THEN 2 ELSE 1 END
      `).get().n;
      if (missing > 0) {
        throw new Error(`v4 backfill left ${missing} connections without observations`);
      }
      logger.info('[migrate] v4: backfill consistency verified (0 missing observations)');
    },
  },
  {
    version: 5,
    description: 'remove legacy connections.source column (P2-30 contract phase)',
    up(db) {
      const hasTbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`).get();
      if (!hasTbl) return; // fresh DB: history.js creates the v5 schema after migrations

      const columns = db.prepare('PRAGMA table_info(connections)').all().map(row => row.name);
      if (!columns.includes('source')) return; // already contracted by an equivalent build

      const before = checkObservationConsistency(db);
      const mismatches = before.missingObservations + before.orphanObservations +
        before.underMerged + before.kindMismatches;
      if (mismatches > 0) {
        throw new Error(
          `v5 consistency gate failed (missing=${before.missingObservations}, ` +
          `orphans=${before.orphanObservations}, underMerged=${before.underMerged}, ` +
          `kindMismatches=${before.kindMismatches})`
        );
      }

      db.exec('ALTER TABLE connections DROP COLUMN source');

      const afterColumns = db.prepare('PRAGMA table_info(connections)').all().map(row => row.name);
      if (afterColumns.includes('source')) {
        throw new Error('v5 failed to remove connections.source');
      }
      const after = checkObservationConsistency(db);
      if (after.missingObservations || after.orphanObservations || after.kindMismatches) {
        throw new Error(
          `v5 post-contract consistency failed (missing=${after.missingObservations}, ` +
          `orphans=${after.orphanObservations}, kindMismatches=${after.kindMismatches})`
        );
      }
      logger.info('[migrate] v5: removed connections.source; junction consistency verified');
    },
  },
  {
    version: 6,
    description: 'append-only AI conversations and messages (P2-14)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_conversations (
          conversationId TEXT PRIMARY KEY,
          createdAt      INTEGER NOT NULL,
          provider       TEXT NOT NULL,
          model          TEXT NOT NULL,
          rangeFrom      INTEGER NOT NULL,
          rangeTo        INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_messages (
          messageId      TEXT PRIMARY KEY,
          conversationId TEXT NOT NULL,
          requestId      TEXT NOT NULL,
          role           TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          body           TEXT,
          createdAt      INTEGER NOT NULL,
          provider       TEXT NOT NULL,
          model          TEXT NOT NULL,
          rangeFrom      INTEGER NOT NULL,
          rangeTo        INTEGER NOT NULL,
          status         TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
          errorCode      TEXT,
          UNIQUE(requestId, role),
          FOREIGN KEY(conversationId) REFERENCES ai_conversations(conversationId) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
          ON ai_messages(conversationId, createdAt, messageId);
      `);
    },
  },
  {
    version: 7,
    description: 'append-only AI token usage and cost estimates',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_usage (
          usageId             TEXT PRIMARY KEY,
          requestId           TEXT NOT NULL UNIQUE,
          conversationId      TEXT,
          kind                TEXT NOT NULL CHECK(kind IN ('analysis', 'chat', 'test')),
          createdAt           INTEGER NOT NULL,
          provider            TEXT NOT NULL,
          model               TEXT NOT NULL,
          inputTokens         INTEGER NOT NULL CHECK(inputTokens >= 0),
          outputTokens        INTEGER NOT NULL CHECK(outputTokens >= 0),
          totalTokens         INTEGER NOT NULL CHECK(totalTokens >= 0),
          estimatedCostUsd    REAL,
          pricingVersion      TEXT,
          inputUsdPerMillion  REAL,
          outputUsdPerMillion REAL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_created
          ON ai_usage(createdAt);
      `);
    },
  },
  {
    version: 8,
    description: 'append-only AI event notification history (P2-57)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_notification_events (
          eventId          TEXT PRIMARY KEY,
          triggerType      TEXT NOT NULL CHECK(triggerType IN ('scheduled', 'threat', 'manual', 'test')),
          triggerKey       TEXT UNIQUE,
          cause            TEXT NOT NULL,
          createdAt        INTEGER NOT NULL,
          rangeFrom        INTEGER NOT NULL,
          rangeTo          INTEGER NOT NULL,
          status           TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
          provider         TEXT NOT NULL,
          model            TEXT NOT NULL,
          body             TEXT,
          slackSent        INTEGER NOT NULL DEFAULT 0,
          inputTokens      INTEGER NOT NULL DEFAULT 0 CHECK(inputTokens >= 0),
          outputTokens     INTEGER NOT NULL DEFAULT 0 CHECK(outputTokens >= 0),
          totalTokens      INTEGER NOT NULL DEFAULT 0 CHECK(totalTokens >= 0),
          estimatedCostUsd REAL,
          errorCode        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_notification_created
          ON ai_notification_events(createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_notification_cause
          ON ai_notification_events(triggerType, cause, createdAt DESC);
      `);
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
 * @param {{ sourceRouterMap?: { yamaha: string, cisco: string } }} [ctx]
 *        migration context; sourceRouterMap comes from sourceRouterIdMap()
 */
function runMigrations(db, dbPath, ctx = {}) {
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
        mig.up(db, ctx);
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
