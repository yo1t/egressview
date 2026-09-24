// Making and checking one backup copy. Runs on a worker thread
// (backup-copy-worker.js); nothing here may run on the main thread in
// production, because every step reads the whole database.
//
// Two things went wrong with the previous way, both measured:
//
//   - The online backup API, run on its own connection, starts again from
//     the first page whenever another connection writes. The Hub has eleven
//     modules each with its own connection to the same file, so there is
//     always one writing. On a copy of the production database with 100 rows
//     a second being written, it restarted 7,142 times in 12 minutes and never
//     finished -- which is what the production backup directory showed on
//     2026-09-23: a copy stuck at 2.5 GB while the disk was written at up to
//     128 MB/s.
//   - The copy was then checked with integrity_check on the main thread. On
//     the production database that takes 171-283 s, and the watchdog kills
//     the process at 120 s. The backup of 2026-09-23 19:32 was complete and
//     sound, and was killed while being checked.
//
// VACUUM INTO reads one consistent snapshot, however many connections write
// meanwhile, and always finishes: 24 s on the same copy under the same
// writes. It works from a read-only connection, so the backup never holds a
// write handle on the live database. And it writes the copy in rollback-journal
// mode, so opening the copy to check it leaves no -wal or -shm beside it.
'use strict';

const fs = require('fs');

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
}

/**
 * Whether a copy is the whole of its source.
 *
 * `integrity_check` alone is not enough: an empty file passes it as an empty
 * database. So the copy must also be as long as the pages it declares, on the
 * source's schema version, and hold every table the source holds -- which also
 * rules out an empty copy, since it has none.
 *
 * @throws {Error} naming what is wrong.
 */
function verifyCopy(Database, copyPath, { sourceVersion, sourceTables }) {
  const size = fs.statSync(copyPath).size;
  const copy = new Database(copyPath, { readonly: true, fileMustExist: true });
  try {
    const declared = copy.pragma('page_size', { simple: true }) * copy.pragma('page_count', { simple: true });
    if (declared !== size) throw new Error(`the copy is ${size} bytes but declares ${declared}`);
    const version = copy.pragma('user_version', { simple: true });
    if (version !== sourceVersion) {
      throw new Error(`the copy is schema v${version}, the source v${sourceVersion}`);
    }
    const have = new Set(tableNames(copy));
    const missing = sourceTables.filter(name => !have.has(name));
    if (missing.length) throw new Error(`the copy is missing ${missing.join(', ')}`);
    const rows = copy.pragma('integrity_check');
    if (!(rows.length === 1 && rows[0]?.integrity_check === 'ok')) {
      throw new Error(`integrity_check: ${JSON.stringify(rows[0])}`);
    }
  } finally {
    copy.close();
  }
  // Nothing should have been created beside the copy by reading it. If
  // something was, the copy is not what was checked.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(copyPath + suffix)) throw new Error(`reading the copy left a ${suffix} beside it`);
  }
  return size;
}

/**
 * Copies `source` to `destination` and checks the copy.
 *
 * @returns {{ bytes: number, copiedMs: number, verifiedMs: number }}
 * @throws {Error} with the reason; the caller removes the destination.
 */
function copyAndVerify(Database, { source, destination, now = Date.now }) {
  const started = now();
  const src = new Database(source, { readonly: true, fileMustExist: true });
  let sourceVersion;
  let sourceTables;
  try {
    sourceVersion = src.pragma('user_version', { simple: true });
    sourceTables = tableNames(src);
    src.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  const copied = now();
  const bytes = verifyCopy(Database, destination, { sourceVersion, sourceTables });
  return { bytes, copiedMs: copied - started, verifiedMs: now() - copied };
}

/**
 * Whether a file is a whole, sound SQLite database, for a restore.
 *
 * Less than `verifyCopy` asks, on purpose: a file being restored may come from
 * an older schema, so its version and tables are not compared with anything.
 * What is kept is the full integrity_check -- a restore replaces the live
 * database, so the cheaper quick_check is not enough -- and the length check,
 * which catches a file cut short in transfer before integrity_check has to.
 *
 * @throws {Error} naming what is wrong.
 */
function verifyIntegrity(Database, filePath) {
  const size = fs.statSync(filePath).size;
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const declared = db.pragma('page_size', { simple: true }) * db.pragma('page_count', { simple: true });
    if (declared !== size) throw new Error(`the file is ${size} bytes but declares ${declared}`);
    const rows = db.pragma('integrity_check');
    if (!(rows.length === 1 && rows[0]?.integrity_check === 'ok')) {
      throw new Error(`integrity_check returned '${rows[0]?.integrity_check}'`);
    }
  } finally {
    db.close();
  }
}

module.exports = { verifyCopy, copyAndVerify, verifyIntegrity };
