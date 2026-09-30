'use strict';

// The main thread's side of the database thread (db-worker.js).
//
// The Hub's database work used to run on the thread that answers every
// request, so a slow statement froze the dashboard, the agents' uploads and
// /healthz together (P3-182, P3-156, P3-150, P3-168). This moves the heavy
// jobs to a thread with its own connection. The main thread sends a request
// and gets a promise; nothing it does waits for the answer.
//
// The thread's connection is a handle to the database file like any other,
// so it has to be closed wherever the others are: before a restore replaces
// the file, and before shutdown records a clean stop (which refuses while any
// handle is still open).

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

class DbWorkerHost {
  constructor({
    workerFactory,
    logger = console,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  } = {}) {
    this.workerFactory = workerFactory || (workerData => new Worker(
      path.join(__dirname, 'db-worker.js'),
      { workerData }
    ));
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.dbPath = null;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = true;
  }

  /** Starts the thread against `dbPath`. Requests are refused until then. */
  open(dbPath) {
    if (!dbPath) throw new TypeError('dbPath is required');
    this.dbPath = dbPath;
    this.closed = false;
    this._spawn();
  }

  /**
   * Runs `op` on the database thread. Rejects if the thread is closed, fails,
   * exits, or does not answer within the request timeout.
   */
  run(op, args = {}) {
    if (this.closed) {
      const error = new Error('The database thread is closed');
      error.code = 'DB_WORKER_CLOSED';
      return Promise.reject(error);
    }
    // A thread that died between requests is started again for the next one,
    // rather than leaving every later job to fail until a restart.
    if (!this.worker) this._spawn();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const error = new Error(`The database thread did not answer ${op} in time`);
        error.code = 'DB_WORKER_TIMEOUT';
        reject(error);
        // Its connection may be stuck mid-statement; a new thread starts clean.
        this._discard('timed out');
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { op, resolve, reject, timer });
      this.worker.postMessage({ id, op, args });
    });
  }

  /**
   * Closes the thread's connection and stops the thread. Resolves once its
   * handle to the database is gone, or once the thread has been terminated
   * when it does not answer within the close timeout.
   */
  async close() {
    if (this.closed && !this.worker) return;
    this.closed = true;
    const worker = this.worker;
    if (!worker) return;
    const id = this.nextId++;
    const answered = new Promise(resolve => {
      this.pending.set(id, { op: 'close', resolve, reject: resolve, timer: null });
      worker.postMessage({ id, op: 'close' });
    });
    let timer;
    const late = new Promise(resolve => {
      timer = setTimeout(resolve, this.closeTimeoutMs);
      timer.unref?.();
    });
    await Promise.race([answered, late]);
    clearTimeout(timer);
    // Terminating a thread closes what it still holds, so even a thread stuck
    // in a statement leaves no handle behind.
    this._discard('closed');
    await worker.terminate().catch(() => {});
  }

  /** Opens again on the file it last had, if it was ever opened. */
  resume() {
    if (this.dbPath && this.closed) this.open(this.dbPath);
  }

  /** Closes, then opens again on the same (or a new) file. */
  async reopen(dbPath = this.dbPath) {
    await this.close();
    this.open(dbPath);
  }

  _spawn() {
    const worker = this.workerFactory({ dbPath: this.dbPath });
    this.worker = worker;
    worker.unref?.();
    worker.on('message', message => this._settle(message));
    worker.on('error', error => {
      if (this.worker !== worker) return;
      this.logger.error('[db-worker] database thread failed:', error?.message || String(error));
      this._discard('failed');
    });
    worker.on('exit', code => {
      if (this.worker !== worker) return;
      if (!this.closed) this.logger.warn(`[db-worker] database thread exited with code ${code}`);
      this._discard('exited');
    });
  }

  _settle(message) {
    const entry = this.pending.get(message?.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      const error = new Error(message.error || `Database operation ${entry.op} failed`);
      if (message.code) error.code = message.code;
      entry.reject(error);
    }
  }

  // Forgets the current thread and fails what was waiting on it.
  _discard(reason) {
    const worker = this.worker;
    this.worker = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      const error = new Error(`The database thread ${reason} before answering ${entry.op}`);
      error.code = 'DB_WORKER_GONE';
      if (entry.op === 'close') entry.resolve(); else entry.reject(error);
      this.pending.delete(id);
    }
    if (worker && reason !== 'closed') worker.terminate?.().catch(() => {});
  }
}

module.exports = { DbWorkerHost, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_CLOSE_TIMEOUT_MS };
