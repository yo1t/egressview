// What the Hub does when its database does not pass the startup check.
//
// It used to delete the database first and then copy the newest file in the
// backup directory over it, unchecked. Three things made that dangerous, and
// all three were true on the production Hub on 2026-09-23:
//
//   - The check treated *any* exception as corruption. A lock held by another
//     process, or a read error, was enough to delete a healthy database.
//   - The newest "backup" was not necessarily a backup. The directory held
//     2,761 files that day, almost all of them 0 bytes, left by a backup job
//     that never finished. The name is written before the content.
//   - A 0-byte file opens as an empty SQLite database and passes
//     `integrity_check` -- with no tables in it. So the restore would have
//     "succeeded", the schema would have been created afresh, and months of
//     history would have been replaced by nothing, without a single error.
//
// So this fails closed. The live database is never touched until a candidate
// has been copied beside it and verified in full, and even then it is kept
// under a second name rather than deleted. Anything that cannot be decided -- an exception
// from the check, a copy that fails, a rename that fails, no candidate that
// verifies -- stops the start and leaves every file where it was. A Hub that
// does not start is an outage; a Hub that starts on an empty database is data
// loss that looks like success.
'use strict';

const fs = require('fs');
const path = require('path');

/** Raised when the start must stop without touching the database. */
class DbRestoreFailClosedError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'DbRestoreFailClosedError';
    if (cause) this.cause = cause;
  }
}

// Only these mean the file itself is damaged. Everything else -- busy, locked,
// I/O errors, permissions -- says something about the moment, not the data,
// and deleting a database over it is the mistake this module exists to stop.
function isCorruptionError(error) {
  const code = String(error?.code || '');
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT');
}

/**
 * Checks the live database.
 *
 * `mode` is 'full' for `integrity_check` or 'quick' for `quick_check`
 * (db-startup-check.js decides which). Either way, only a check that ran and
 * found damage says "corrupt"; a check that could not run stops the start.
 *
 * @returns {'ok'|'corrupt'}
 * @throws {DbRestoreFailClosedError} when the check itself could not run.
 */
function checkLiveDatabase(db, { mode = 'full' } = {}) {
  const pragma = mode === 'quick' ? 'quick_check' : 'integrity_check';
  let rows;
  try {
    rows = db.pragma(pragma);
  } catch (error) {
    if (isCorruptionError(error)) return 'corrupt';
    throw new DbRestoreFailClosedError(
      `The database check could not run (${error.code || error.message}). `
      + 'The database has not been touched. Stopping rather than guessing.',
      { cause: error }
    );
  }
  return rows.length === 1 && rows[0]?.[pragma] === 'ok' ? 'ok' : 'corrupt';
}

/**
 * Whether a file is a database worth restoring from.
 *
 * `integrity_check` alone is not enough: an empty file passes it. So the
 * candidate must also have content, a schema version this Hub understands,
 * and the tables a Hub database is made of.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyCandidate(filePath, { Database, maxSchemaVersion, requiredTables }) {
  let size;
  try { size = fs.statSync(filePath).size; } catch (error) {
    return { ok: false, reason: `unreadable: ${error.message}` };
  }
  if (size === 0) return { ok: false, reason: 'empty file' };
  let db = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const pageSize = db.pragma('page_size', { simple: true });
    const pageCount = db.pragma('page_count', { simple: true });
    if (pageSize * pageCount !== size) {
      return { ok: false, reason: `size ${size} does not match ${pageCount} pages of ${pageSize}` };
    }
    // Older is fine -- the migrations bring it forward. Newer is not: this Hub
    // cannot read what a later version wrote. The empty-file case is caught by
    // the size and the required tables, not here.
    const version = db.pragma('user_version', { simple: true });
    if (!(version >= 0 && version <= maxSchemaVersion)) {
      return { ok: false, reason: `schema version ${version} is newer than this Hub (${maxSchemaVersion})` };
    }
    const tables = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    const missing = requiredTables.filter(name => !tables.has(name));
    if (missing.length) return { ok: false, reason: `missing tables: ${missing.join(', ')}` };
    const rows = db.pragma('integrity_check');
    if (!(rows.length === 1 && rows[0]?.integrity_check === 'ok')) {
      return { ok: false, reason: `integrity_check: ${JSON.stringify(rows[0])}` };
    }
    return { ok: true, reason: `schema v${version}, ${size} bytes` };
  } catch (error) {
    return { ok: false, reason: `could not be read as a database: ${error.code || error.message}` };
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
}

const SIDECARS = ['', '-wal', '-shm'];

/**
 * Replaces a damaged live database with the newest candidate that verifies.
 *
 * The damaged files are kept by hard link, not moved. Their names stay where
 * they are until the verified copy is renamed over the main file in one atomic
 * step, so a failure anywhere before that point leaves the live database
 * exactly as it was -- nothing has to be put back, and so nothing can fail to
 * be put back. (An earlier draft moved the file aside first and renamed it
 * back on failure; the test for a refused rename showed that the rename back
 * fails for the same reason, stranding the original under another name.)
 *
 * The damaged database's -wal and -shm are removed before the swap, so the
 * restored file is never beside them, however the start stops: SQLite would
 * otherwise replay the damaged database's pages into it. They survive under
 * the preserved name, and are put back if the swap fails.
 *
 * @param {{
 *   targetPath: string,
 *   candidates: string[],        // newest first
 *   Database: Function,
 *   maxSchemaVersion: number,
 *   requiredTables: string[],
 *   logger?: object,
 *   fsImpl?: { copyFileSync, renameSync, unlinkSync, existsSync, linkSync },
 *   now?: () => number,
 * }} options
 * @returns {{ restoredFrom: string, preservedAs: string }}
 * @throws {DbRestoreFailClosedError}
 */
function restoreFromCandidates({
  targetPath, candidates, Database, maxSchemaVersion, requiredTables,
  logger = console, fsImpl = fs, now = Date.now,
}) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const temporary = `${targetPath}.restore-${stamp}.tmp`;
  const preserved = `${targetPath}.damaged-${stamp}`;
  const rejected = [];
  const discard = file => { try { fsImpl.unlinkSync(file); } catch { /* best effort */ } };

  for (const candidate of candidates) {
    discard(temporary);
    try {
      fsImpl.copyFileSync(candidate, temporary);
    } catch (error) {
      rejected.push(`${path.basename(candidate)}: copy failed (${error.message})`);
      discard(temporary);
      continue;
    }
    const verdict = verifyCandidate(temporary, { Database, maxSchemaVersion, requiredTables });
    if (!verdict.ok) {
      rejected.push(`${path.basename(candidate)}: ${verdict.reason}`);
      discard(temporary);
      continue;
    }

    // Keep the damaged files under a second name. Nothing is moved yet.
    const linked = [];
    try {
      for (const suffix of SIDECARS) {
        if (!fsImpl.existsSync(targetPath + suffix)) continue;
        fsImpl.linkSync(targetPath + suffix, preserved + suffix);
        linked.push(suffix);
      }
    } catch (error) {
      linked.forEach(suffix => discard(preserved + suffix));
      discard(temporary);
      throw new DbRestoreFailClosedError(
        `Could not keep a copy of the damaged database before restoring (${error.message}). `
        + 'Nothing has been changed.',
        { cause: error }
      );
    }

    // The damaged database's -wal and -shm leave before the swap, not after.
    // Removing them afterwards left a window, found in review: if the removal
    // failed and the process stopped, the restart found the restored file
    // with the damaged database's -wal beside it, and SQLite replays a -wal
    // into whatever main file it sits next to. Their content is kept under
    // the preserved name by the hard links above.
    const removed = [];
    const putBack = () => {
      const unrestored = [];
      for (const suffix of removed) {
        try { fsImpl.linkSync(preserved + suffix, targetPath + suffix); } catch {
          unrestored.push(preserved + suffix);
        }
      }
      return unrestored;
    };
    try {
      for (const suffix of ['-wal', '-shm']) {
        if (!fsImpl.existsSync(targetPath + suffix)) continue;
        fsImpl.unlinkSync(targetPath + suffix);
        removed.push(suffix);
      }
    } catch (error) {
      const unrestored = putBack();
      linked.forEach(suffix => { if (!unrestored.includes(preserved + suffix)) discard(preserved + suffix); });
      discard(temporary);
      throw new DbRestoreFailClosedError(
        `Could not move the damaged database's -wal/-shm out of the way (${error.message}). `
        + (unrestored.length
          ? `Its files are kept at: ${unrestored.join(', ')}.`
          : 'The original database has been left where it was.'),
        { cause: error }
      );
    }

    // The one step that changes the live database, and it is atomic.
    try {
      fsImpl.renameSync(temporary, targetPath);
    } catch (error) {
      const unrestored = putBack();
      linked.forEach(suffix => { if (!unrestored.includes(preserved + suffix)) discard(preserved + suffix); });
      discard(temporary);
      throw new DbRestoreFailClosedError(
        `Could not swap in the verified backup ${path.basename(candidate)} (${error.message}). `
        + (unrestored.length
          ? `The original database's -wal/-shm could not be put back and are kept at: ${unrestored.join(', ')}.`
          : 'The original database has been left where it was.'),
        { cause: error }
      );
    }

    logger.info?.(`[history] Restored from ${path.basename(candidate)} (${verdict.reason}); `
      + `the damaged database is kept at ${path.basename(preserved)}`);
    return { restoredFrom: candidate, preservedAs: preserved };
  }

  // Says what to do next, because the reader is an operator looking at a Hub
  // that will not start: the damaged file is theirs to recover or to set aside.
  throw new DbRestoreFailClosedError(
    `The database ${path.basename(targetPath)} is damaged and no backup verified, `
    + 'so nothing has been changed. '
    + (rejected.length ? `Rejected: ${rejected.join('; ')}. ` : 'There are no backups. ')
    + 'To start with an empty database instead, move the damaged file (and any -wal/-shm '
    + 'beside it) out of the way and start again.'
  );
}

module.exports = {
  DbRestoreFailClosedError,
  isCorruptionError,
  checkLiveDatabase,
  verifyCandidate,
  restoreFromCandidates,
};
