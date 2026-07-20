'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_RETAINED_JOBS = 10;
const ACTIVE_STATUSES = new Set(['running', 'cancelling', 'timing_out']);

function cloneJob(job) {
  if (!job) return null;
  const { internalError: _internalError, ...publicJob } = job;
  return JSON.parse(JSON.stringify(publicJob));
}

class BackupPruneRunner {
  constructor({
    timeoutMs = DEFAULT_TIMEOUT_MS,
    workerFactory,
    onSettled,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.workerFactory = workerFactory || (workerData => new Worker(
      path.join(__dirname, 'backup-prune-worker.js'),
      { workerData }
    ));
    this.onSettled = onSettled;
    this.jobs = new Map();
    this.activeId = null;
    this.workers = new Map();
    this.timers = new Map();
  }

  start({ operation, options, source = 'manual' }) {
    const active = this.getActive();
    if (active) {
      const error = new Error('A backup cleanup job is already running');
      error.code = 'BACKUP_PRUNE_BUSY';
      error.job = active;
      throw error;
    }
    if (!['preview', 'execute'].includes(operation)) {
      throw new Error(`Unsupported backup cleanup operation: ${operation}`);
    }

    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      operation,
      source,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      progress: { phase: 'queued', completed: 0, total: 0, verifiedBytes: 0, totalBytes: 0 },
    };
    this.jobs.set(job.id, job);
    this.activeId = job.id;

    let worker;
    try {
      worker = this.workerFactory({ operation, options });
    } catch (error) {
      this._settle(job.id, 'failed', { error: error.message });
      throw error;
    }
    this.workers.set(job.id, worker);

    worker.on('message', message => {
      if (message?.type === 'progress') {
        const current = this.jobs.get(job.id);
        if (!current || current.status !== 'running') return;
        current.progress = message.progress;
        current.updatedAt = new Date().toISOString();
      } else if (message?.type === 'result') {
        this._settle(job.id, 'completed', { result: message.result });
      } else if (message?.type === 'error') {
        this._settle(job.id, 'failed', {
          error: 'Backup cleanup failed safely',
          internalError: message.error || 'Backup cleanup failed',
        });
      }
    });
    worker.on('error', error => this._settle(job.id, 'failed', {
      error: 'Backup cleanup worker failed safely',
      internalError: error.message,
    }));
    worker.on('exit', code => {
      const current = this.jobs.get(job.id);
      if (current?.status === 'running') {
        this._settle(job.id, 'failed', {
          error: 'Backup cleanup worker exited unexpectedly',
          internalError: `Backup cleanup worker exited with code ${code}`,
        });
      }
    });

    const timer = setTimeout(() => {
      const current = this.jobs.get(job.id);
      if (current?.status !== 'running') return;
      current.status = 'timing_out';
      current.updatedAt = new Date().toISOString();
      worker.terminate()
        .then(() => this._settle(job.id, 'timed_out', { error: 'Backup cleanup timed out safely' }))
        .catch(error => this._settle(job.id, 'failed', {
          error: 'Backup cleanup worker could not be stopped cleanly',
          internalError: error.message,
        }));
    }, this.timeoutMs);
    timer.unref?.();
    this.timers.set(job.id, timer);
    return cloneJob(job);
  }

  get(id) {
    return cloneJob(this.jobs.get(id));
  }

  getActive() {
    if (!this.activeId) return null;
    const job = this.jobs.get(this.activeId);
    return ACTIVE_STATUSES.has(job?.status) ? cloneJob(job) : null;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.status = 'cancelling';
    job.updatedAt = new Date().toISOString();
    this.workers.get(id)?.terminate()
      .then(() => this._settle(id, 'cancelled', { error: 'Backup cleanup cancelled safely' }))
      .catch(error => this._settle(id, 'failed', {
        error: 'Backup cleanup worker could not be cancelled cleanly',
        internalError: error.message,
      }));
    return true;
  }

  reset() {
    for (const [id, worker] of this.workers) {
      worker.terminate().catch(() => {});
      clearTimeout(this.timers.get(id));
    }
    this.jobs.clear();
    this.workers.clear();
    this.timers.clear();
    this.activeId = null;
  }

  _settle(id, status, extra = {}) {
    const job = this.jobs.get(id);
    if (!job || !ACTIVE_STATUSES.has(job.status)) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.workers.delete(id);
    job.status = status;
    job.updatedAt = new Date().toISOString();
    job.finishedAt = job.updatedAt;
    Object.assign(job, extra);
    if (this.activeId === id) this.activeId = null;
    this._trimJobs();
    this.onSettled?.(cloneJob(job), job.internalError);
  }

  _trimJobs() {
    const completed = [...this.jobs.values()]
      .filter(job => job.status !== 'running')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    while (completed.length > MAX_RETAINED_JOBS) {
      this.jobs.delete(completed.shift().id);
    }
  }
}

module.exports = {
  BackupPruneRunner,
  DEFAULT_TIMEOUT_MS,
};
