// Worker thread entry for backup work that reads a whole database: making one
// backup copy, or checking a file before a restore. See backup-copy.js for why
// none of it may run on the main thread.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { copyAndVerify, verifyIntegrity } = require('./backup-copy');

try {
  if (workerData.mode === 'verify') {
    verifyIntegrity(Database, workerData.path);
    parentPort.postMessage({ ok: true });
  } else {
    parentPort.postMessage({ ok: true, ...copyAndVerify(Database, workerData) });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
