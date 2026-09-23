// Worker thread entry for one backup copy. See backup-copy.js for why this
// must not run on the main thread.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const { copyAndVerify } = require('./backup-copy');

try {
  parentPort.postMessage({ ok: true, ...copyAndVerify(Database, workerData) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
