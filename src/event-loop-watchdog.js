'use strict';

// Event-loop watchdog (P2-87 defense-in-depth).
//
// better-sqlite3 runs synchronously, so a single pathological query can block
// the Node.js event loop indefinitely — /healthz stops answering and the whole
// server appears frozen (ALB returns 504). The primary fix is to keep those
// queries indexed and bounded, but as a safety net a monitor thread watches a
// heartbeat that the main thread bumps each tick. If the heartbeat goes stale
// past the stall threshold, the main event loop is wedged and cannot exit on
// its own, so the monitor force-kills the process. systemd
// (Restart=on-failure, RestartSec=5) then brings it back within seconds.
//
// Everything here is unref'd: the watchdog never keeps an otherwise-idle
// process alive, and it adds only a 1s timer plus one lightweight thread.

const { Worker } = require('node:worker_threads');
const logger = require('./logger');

const DEFAULT_STALL_MS = 120_000; // 2 min — well above any legitimate sync op
const HEARTBEAT_MS = 1_000;
const CHECK_MS = 5_000;

// Runs inside the monitor thread. It reads the shared heartbeat without needing
// the (possibly blocked) main event loop and kills the process on a stall.
const MONITOR_SOURCE = `
  const { workerData } = require('node:worker_threads');
  const view = new BigInt64Array(workerData.shared);
  const { stallMs, checkMs } = workerData;
  setInterval(() => {
    const last = Number(Atomics.load(view, 0));
    const lag = Date.now() - last;
    if (lag > stallMs) {
      process.stderr.write(
        '[watchdog] FATAL: event loop stalled for ' + lag + 'ms (>' + stallMs +
        'ms); forcing restart\\n'
      );
      // The main thread is wedged in a synchronous call and cannot exit
      // gracefully, so signal the whole process. SIGKILL is unblockable.
      try { process.kill(process.pid, 'SIGKILL'); } catch (_e) {}
    }
  }, checkMs);
`;

/**
 * Start the event-loop watchdog. Returns a handle with stop(), or null when
 * disabled (EGRESSVIEW_WATCHDOG_STALL_MS <= 0).
 */
function startEventLoopWatchdog({
  stallMs = Number(process.env.EGRESSVIEW_WATCHDOG_STALL_MS ?? DEFAULT_STALL_MS),
  heartbeatMs = HEARTBEAT_MS,
  checkMs = CHECK_MS,
} = {}) {
  if (!Number.isFinite(stallMs) || stallMs <= 0) {
    logger.info('[watchdog] disabled (EGRESSVIEW_WATCHDOG_STALL_MS <= 0)');
    return null;
  }

  const shared = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const view = new BigInt64Array(shared);
  Atomics.store(view, 0, BigInt(Date.now()));

  const heartbeat = setInterval(() => {
    Atomics.store(view, 0, BigInt(Date.now()));
  }, heartbeatMs);
  heartbeat.unref();

  let worker;
  try {
    worker = new Worker(MONITOR_SOURCE, {
      eval: true,
      workerData: { shared, stallMs, checkMs },
    });
  } catch (err) {
    clearInterval(heartbeat);
    logger.error('[watchdog] failed to start monitor thread:', err.message);
    return null;
  }
  worker.unref();
  worker.on('error', (err) => logger.error('[watchdog] monitor thread error:', err.message));

  logger.info(`[watchdog] event-loop monitor active (stall > ${stallMs}ms -> forced restart)`);

  return {
    stop() {
      clearInterval(heartbeat);
      worker.terminate().catch(() => {});
    },
  };
}

module.exports = { startEventLoopWatchdog };
