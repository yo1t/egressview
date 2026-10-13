'use strict';

// Runs the deferred startup quick_check on a thread of its own and exits
// (db-background-check.js). Its own thread, because the check reads the whole
// database -- over a minute on production when the page cache is cold -- and
// on the read or maintenance thread every request queued behind it would wait.
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { checkLiveDatabase } = require('./db-restore');

const startedAt = Date.now();
let message;
try {
  const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    message = { result: checkLiveDatabase(db, { mode: 'quick' }) };
  } finally {
    db.close();
  }
} catch (error) {
  message = { result: 'error', error: error?.message || String(error) };
}
parentPort.postMessage({ ...message, ms: Date.now() - startedAt });
