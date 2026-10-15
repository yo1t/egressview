'use strict';

// Runs one database check in a process of its own and prints the outcome as a
// JSON line (db-background-check.js). A process, not a thread, so the
// operating system can be asked to give it the lowest CPU and disk priority:
// the full check reads all of a 5.1 GB database, 269 s on production, and it
// must not slow the Hub that keeps collecting meanwhile.
const Database = require('better-sqlite3');
const { checkLiveDatabase } = require('./db-restore');

const [dbPath, mode] = process.argv.slice(2);
const startedAt = Date.now();
let outcome;
try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    outcome = { result: checkLiveDatabase(db, { mode: mode === 'full' ? 'full' : 'quick' }) };
  } finally {
    db.close();
  }
} catch (error) {
  outcome = { result: 'error', error: error?.message || String(error) };
}
process.stdout.write(`${JSON.stringify({ ...outcome, ms: Date.now() - startedAt })}\n`);
