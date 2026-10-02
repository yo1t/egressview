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
  connections.add(new WeakRef(db));
  setAutoCheckpointOn(db, autoCheckpoint);
  return db;
}

// Who writes the log back into the database (P3-184).
//
// Left to SQLite, the write-back runs inside whichever commit pushes the log
// past its threshold. On the production Hub on 2026-10-02 that was an agent
// upload's commit, four times, for 1.8-7.6 s each -- lock wait 0, statements
// 0-10 ms, the rest the commit -- with the log at 90-145 MB. The main thread
// waited synchronously, and so did every request.
//
// The database thread now writes the log back a little at a time
// (checkpoint-owner.js), and the connections on this thread stop doing it
// themselves. Every connection opened through applyWalPragmas is remembered,
// so turning it off reaches the ones already open as well as later ones, and
// turning it back on -- when the thread is not there to do it -- does too.
const SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES = 1000;
const connections = new Set();
let autoCheckpoint = true;

function setAutoCheckpointOn(db, enabled) {
  if (!db.open) return;
  db.pragma(`wal_autocheckpoint = ${enabled ? SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES : 0}`);
}

/** Turns the automatic write-back on or off for every connection on this thread. */
function setAutoCheckpoint(enabled) {
  autoCheckpoint = enabled !== false;
  for (const ref of connections) {
    const db = ref.deref();
    if (!db || !db.open) { connections.delete(ref); continue; }
    try { setAutoCheckpointOn(db, autoCheckpoint); } catch { /* closing; the next open applies it */ }
  }
  return autoCheckpoint;
}

module.exports = {
  applyWalPragmas, setAutoCheckpoint, WAL_SIZE_LIMIT_BYTES, SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES,
};
