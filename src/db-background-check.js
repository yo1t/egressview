'use strict';

// The startup quick_check, run once the Hub is up instead of before it
// (db-startup-check.js, `deferred`). Only a start after an orderly stop with a
// recent full check takes this path; every other start is checked in full
// first, as before.
const path = require('node:path');
const { Worker } = require('node:worker_threads');

/**
 * @returns {Promise<{ result: 'ok'|'corrupt'|'error', ms: number, error?: string }>}
 */
function runQuickCheckOffThread(dbPath, { WorkerImpl = Worker } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let settled = false;
    const settle = value => { if (!settled) { settled = true; resolve(value); } };
    const worker = new WorkerImpl(path.join(__dirname, 'db-quick-check-worker.js'), { workerData: { dbPath } });
    worker.once('message', message => settle(message));
    worker.once('error', error => settle({ result: 'error', ms: Date.now() - startedAt, error: error.message }));
    worker.once('exit', code => {
      if (code !== 0) settle({ result: 'error', ms: Date.now() - startedAt, error: `the check thread exited with ${code}` });
    });
  });
}

module.exports = { runQuickCheckOffThread };
