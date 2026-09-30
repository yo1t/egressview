'use strict';

// Where the connection log's heavy reads go: to the read thread when it is
// there, and to the history module on this thread when it is not (P3-184).
//
// Asked this way, a 3-second summary keeps the person who asked for it waiting
// and nobody else: the dashboard, agent uploads and /healthz go on. Before, the
// same read held the thread that answers every request.
//
// Only a thread that is not there falls back: closed for a restore or during
// shutdown, or gone because it died. A read that failed or ran out of time on
// the thread is an error for the caller, not a reason to run the same slow
// query again on the one thread that must not stop.

const FALLBACK_CODES = new Set(['DB_WORKER_CLOSED', 'DB_WORKER_GONE']);

function createHistoryReader({ history, host = null, logger = console, profiler = null } = {}) {
  if (!history) throw new TypeError('history is required');

  function onThisThread(fn, args) {
    return history[fn](...args);
  }

  async function read(fn, ...args) {
    if (!host) return onThisThread(fn, args);
    const run = () => host.run('history.read', { fn, args });
    try {
      return profiler
        ? await profiler.measureAsync(`dbRead.${fn}`, run)
        : await run();
    } catch (error) {
      if (!FALLBACK_CODES.has(error?.code)) throw error;
      logger.warn(`[history-reader] ${fn} ran on the request thread: ${error.message}`);
      return onThisThread(fn, args);
    }
  }

  return { read };
}

module.exports = { createHistoryReader, FALLBACK_CODES };
