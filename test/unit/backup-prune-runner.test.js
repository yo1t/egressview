'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { BackupPruneRunner } = require('../../src/backup-prune-runner');

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.terminated = false;
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

describe('BackupPruneRunner', () => {
  it('returns immediately while progress and result arrive asynchronously', async () => {
    const worker = new FakeWorker();
    const runner = new BackupPruneRunner({ workerFactory: () => worker, timeoutMs: 1000 });
    let eventLoopAdvanced = false;

    const job = runner.start({ operation: 'preview', options: {}, source: 'manual' });
    setImmediate(() => { eventLoopAdvanced = true; });
    worker.emit('message', { type: 'progress', progress: { phase: 'planning', completed: 1, total: 2 } });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(eventLoopAdvanced, true);
    assert.deepEqual(runner.get(job.id).progress, { phase: 'planning', completed: 1, total: 2 });
    worker.emit('message', { type: 'result', result: { candidates: [] } });
    assert.equal(runner.get(job.id).status, 'completed');
    assert.deepEqual(runner.get(job.id).result, { candidates: [] });
    assert.equal(runner.getActive(), null);
  });

  it('keeps the main event loop responsive while a worker performs blocking work', async () => {
    const workerFile = path.join(__dirname, '..', 'fixtures', 'blocking-prune-worker.js');
    const runner = new BackupPruneRunner({
      workerFactory: workerData => new Worker(workerFile, { workerData }),
      timeoutMs: 1000,
    });
    const job = runner.start({ operation: 'preview', options: {} });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);

    // Wait for the worker rather than for a fixed number of turns. The budget
    // used to be 50 x 10ms, and a CI runner under load took 510ms to start a
    // worker and block for 100 -- so the assertion below fired on a job that
    // was still perfectly healthy. A gate that goes red for being slow teaches
    // people that red means nothing.
    const deadline = Date.now() + 5000;
    while (runner.get(job.id).status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    clearInterval(timer);

    assert.equal(runner.get(job.id).status, 'completed');
    // The subject: the loop kept turning while the worker blocked. The worker
    // blocks for 100ms, so a main thread that was blocked with it could not
    // have accumulated these.
    assert.ok(ticks >= 3, `expected the main event loop to advance, got ${ticks} ticks`);
  });

  it('rejects a second job while one is running', () => {
    const worker = new FakeWorker();
    const runner = new BackupPruneRunner({ workerFactory: () => worker, timeoutMs: 1000 });
    const first = runner.start({ operation: 'preview', options: {} });

    assert.throws(
      () => runner.start({ operation: 'execute', options: {} }),
      error => error.code === 'BACKUP_PRUNE_BUSY' && error.job.id === first.id
    );
    runner.reset();
  });

  it('keeps a cancelling job active until worker termination is confirmed', async () => {
    const worker = new FakeWorker();
    const runner = new BackupPruneRunner({ workerFactory: () => worker, timeoutMs: 1000 });
    const job = runner.start({ operation: 'preview', options: {} });

    assert.equal(runner.cancel(job.id), true);
    assert.equal(worker.terminated, true);
    assert.equal(runner.get(job.id).status, 'cancelling');
    assert.equal(runner.getActive().id, job.id);
    assert.throws(() => runner.start({ operation: 'preview', options: {} }), /already running/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runner.get(job.id).status, 'cancelled');
    assert.equal(runner.getActive(), null);
    assert.equal(runner.cancel(job.id), false);
  });

  it('terminates a worker after the configured timeout', async () => {
    const worker = new FakeWorker();
    const runner = new BackupPruneRunner({ workerFactory: () => worker, timeoutMs: 10 });
    const job = runner.start({ operation: 'preview', options: {} });

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(worker.terminated, true);
    assert.equal(runner.get(job.id).status, 'timed_out');
  });
});
