'use strict';

// Hands the write-back of the log to the database thread, and takes it back
// when the thread cannot do it (P3-184, sqlite-wal.js).
//
// Every few seconds the thread copies what the log holds back into the
// database (a PASSIVE checkpoint, which waits for no one). While those
// succeed, the main thread's connections do not checkpoint on commit, so an
// upload's commit no longer pays for everyone's writes. When one fails --
// the thread closed for a restore, died, or timed out -- the main thread's
// automatic write-back is turned back on at once, so the log cannot grow
// without bound; the next success turns it off again.

const DEFAULT_INTERVAL_MS = 5000;
// A write-back this slow is worth a line: the point of doing it often is that
// each one stays small.
const SLOW_CHECKPOINT_MS = 1000;

function createCheckpointOwner({
  host, setAutoCheckpoint, logger = console, profiler = null,
  intervalMs = DEFAULT_INTERVAL_MS, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  if (!host?.run) throw new TypeError('host is required');
  if (typeof setAutoCheckpoint !== 'function') throw new TypeError('setAutoCheckpoint is required');
  let timer = null;
  let stopped = true;
  let threadOwns = false;
  let lastFailure = null;

  function own(byThread, reason, { expected = false } = {}) {
    if (threadOwns === byThread) return;
    threadOwns = byThread;
    setAutoCheckpoint(!byThread);
    if (byThread) {
      logger.info('[checkpoint] the database thread writes the log back; commits here no longer do');
    } else {
      // A warning when the thread failed; an orderly stop is not one.
      (expected ? logger.info : logger.warn).call(logger,
        `[checkpoint] commits here write the log back again: ${reason}`);
    }
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    try {
      const run = () => host.run('wal.checkpoint');
      const result = profiler ? await profiler.measureAsync('dbWorker.checkpoint', run) : await run();
      lastFailure = null;
      own(true);
      if (result?.ms > SLOW_CHECKPOINT_MS) {
        logger.warn(`[checkpoint] slow write-back ${JSON.stringify(result)}`);
      }
    } catch (error) {
      lastFailure = error?.code || error?.message || String(error);
      own(false, lastFailure);
    }
    if (!stopped) {
      timer = schedule(tick, intervalMs);
      timer?.unref?.();
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    timer = schedule(tick, 0);
    timer?.unref?.();
  }

  /** Stops the loop and gives the write-back back to this thread's connections. */
  function stop(reason = 'stopped') {
    stopped = true;
    if (timer) cancel(timer);
    timer = null;
    own(false, reason, { expected: true });
  }

  return { start, stop, state: () => ({ threadOwns, lastFailure }) };
}

module.exports = { createCheckpointOwner, DEFAULT_INTERVAL_MS };
