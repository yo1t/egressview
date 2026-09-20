'use strict';

// SQLite never shrinks the write-ahead log on its own.
//
// After a checkpoint the log's contents are spent, but the file keeps whatever
// size it reached, because `journal_size_limit` defaults to -1: no limit, never
// truncate. On the production Hub that high-water mark was set by one night of
// bulk deletes and stayed: 530 MB of a 32 GB disk held by a file whose useful
// contents were a few megabytes.
//
// The limit is a property of a connection, not of the database file, and it is
// applied by whichever connection completes a checkpoint. Several modules here
// open the same file, so every one of them has to set it or the truncation
// happens only sometimes -- which is the same as not at all, for anyone trying
// to predict how much disk the Hub needs.
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Put a database into WAL mode with a bounded log.
 *
 * Callers still set their own `busy_timeout` and the rest: this is only the
 * pair that has to agree across every connection to the same file.
 */
function applyWalPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  return db;
}

module.exports = { applyWalPragmas, WAL_SIZE_LIMIT_BYTES };
