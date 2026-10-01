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

/**
 * A reader that answers the same read once for everyone who asks within a
 * minute, and makes a read asked for while it is running wait for it.
 *
 * Opening the AI panel sent the same facts request three times at once on
 * 2026-10-01; each one queued four reads on the read thread, and the last
 * answered after 13.2 s. The connection log has had this sharing since P3-67
 * (cachedReadAsync); the facts had none.
 *
 * A rolling window's `from` moves every millisecond, so the key rounds it:
 * requests that differ only in their arrival share an answer, which is the
 * staleness the TTL already allows. The read itself runs with the arguments
 * of the request that started it. Reads are expected to look like
 * (from, to, options); `to` is rounded the same way when present.
 *
 * The rounding is a thousandth of the window, at most `quantumMs` (a minute
 * for anything over about seventeen hours). A fixed minute merged the current
 * and previous periods of a window shorter than that into one key -- the
 * previous period was answered with the current one's numbers.
 */
function createSharedReader({
  reader, ttlMs = 60_000, quantumMs = 60_000, maxEntries = 64, now = Date.now,
} = {}) {
  if (!reader?.read) throw new TypeError('reader is required');
  const answers = new Map();
  const running = new Map();
  const stats = { hits: 0, joined: 0, misses: 0 };
  async function read(fn, from, to, options) {
    const at = now();
    const span = Number.isFinite(from) ? (to ?? at) - from : 0;
    const step = Math.max(1, Math.min(quantumMs, Math.floor(span / 1000)));
    const round = value => (Number.isFinite(value) ? Math.floor(value / step) * step : value ?? null);
    const key = JSON.stringify([fn, round(from), round(to), step, options ?? null]);
    const answer = answers.get(key);
    if (answer && at - answer.at < ttlMs) {
      stats.hits += 1;
      return answer.value;
    }
    const pending = running.get(key);
    if (pending) {
      stats.joined += 1;
      return pending;
    }
    stats.misses += 1;
    const started = reader.read(fn, from, to, options);
    running.set(key, started);
    try {
      const value = await started;
      answers.delete(key);
      answers.set(key, { value, at: now() });
      while (answers.size > maxEntries) answers.delete(answers.keys().next().value);
      return value;
    } finally {
      if (running.get(key) === started) running.delete(key);
    }
  }

  return { read, stats: () => ({ ...stats, cached: answers.size }) };
}

module.exports = { createHistoryReader, createSharedReader, FALLBACK_CODES };
