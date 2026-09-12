'use strict';

// Correlating an agent observation with a router session is bookkeeping, not
// part of accepting an upload. It used to run inline on every ingest, which put
// an unbounded scan on the request path and stalled the whole server -- see the
// comment in agent-ingest-store.storeBatch. This owns that work instead, on a
// schedule, in bounded slices.
//
// Two things keep a slice from becoming the next stall:
//
//   * a `limit` far below the 5,000 default, so one tick cannot outrun the
//     event-loop watchdog and turn a slow pass into a restart loop, and
//   * a narrow `since` window on most ticks. A router session can appear later
//     than the agent observation it belongs to, so a wider sweep still has to
//     happen -- just rarely, and still bounded.
//
// An observation that matches nothing keeps coming back: there is no column
// recording that it was already judged, so an agent-only flow is re-examined on
// every sweep. That is why the sweep is occasional rather than continuous, and
// why retention matters more here than throughput.

const runtimeProfiler = require('./runtime-profiler');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 500;
// Every Nth tick widens the window to catch a router session that arrived after
// the observation it belongs to.
const SWEEP_EVERY_TICKS = 12;
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

let _agentIngest = null;
let _logger = console;
let timer = null;
let ticks = 0;

function init({ agentIngest, logger = console } = {}) {
  if (!agentIngest || typeof agentIngest.reconcileCorrelations !== 'function') {
    throw new TypeError('agentIngest with reconcileCorrelations is required');
  }
  _agentIngest = agentIngest;
  _logger = logger || console;
  ticks = 0;
}

/**
 * Reconcile one bounded slice.
 *
 * Errors are swallowed on purpose. The database may be closed underneath a
 * pending tick during shutdown, and a failed pass must never take down a
 * process whose actual job is collection.
 */
function runReconcile({
  windowMs = DEFAULT_WINDOW_MS,
  limit = DEFAULT_LIMIT,
  now = Date.now(),
} = {}) {
  if (!_agentIngest) return null;
  try {
    const result = runtimeProfiler.measureSync('agentCorrelation.reconcile', () => (
      _agentIngest.reconcileCorrelations({ since: now - windowMs, limit })
    ));
    if (result && (result.linked > 0 || result.ambiguous > 0)) {
      _logger.info(`[agent-correlation] reconcile ${JSON.stringify(result)}`);
    }
    return result;
  } catch (error) {
    _logger.error('[agent-correlation] periodic reconcile failed:', error.message);
    return null;
  }
}

function tick() {
  ticks += 1;
  const sweeping = ticks % SWEEP_EVERY_TICKS === 0;
  return runReconcile(sweeping ? { windowMs: SWEEP_WINDOW_MS } : {});
}

function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  stop();
  timer = setInterval(tick, intervalMs);
  // Never hold the event loop open just to wait for the next pass.
  timer.unref?.();
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_WINDOW_MS,
  DEFAULT_LIMIT,
  SWEEP_EVERY_TICKS,
  SWEEP_WINDOW_MS,
  init,
  runReconcile,
  start,
  stop,
  _resetForTest() {
    stop();
    _agentIngest = null;
    _logger = console;
    ticks = 0;
  },
};
