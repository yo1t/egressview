'use strict';

// When traffic happened, which `connections` cannot say.
//
// `connections` holds one row per flow and updates it every time the flow is
// seen again. Asking it "how many flows were there at 10am" returns the flows
// whose *last* sighting was at 10am -- everything still running has moved to
// now. On one Hub that made a six-hour chart rise from 156 to 1,115 with no
// change in traffic, and the shape could not be anything else.
//
// So the chart reads this table instead, and this table is built only from
// evidence that records a time. There are two kinds, and they behave very
// differently:
//
//   Router-observed flows have no record of time at all beyond firstSeen and
//   lastSeen. A window can be counted while the flows seen in it still carry a
//   lastSeen inside it -- which lasts until each one is seen again, and
//   polling is a minute. So a window is folded within seconds of closing, and
//   never afterwards: counting it later returns the flows that *stopped*
//   during it. Nothing can be recovered for the past, and a window missed
//   while the Hub was down stays missing. The estimate that would fill those
//   gaps -- counting a flow in every window between firstSeen and lastSeen --
//   was measured and rejected: it falls from 1,949 to 42 across six hours of
//   steady traffic, which is the original defect mirrored.
//
//   Agent-observed flows do carry their times. `agent_observations` keeps, for
//   every flow an Agent saw, the interval it was observed in, and those times
//   never move. That makes the agent half of a window countable at any point:
//   it can be filled in for the past, and it can be counted again later when a
//   batch uploaded late adds to a window that was already folded. Before this,
//   a window folded five seconds after closing held 22 flows where the Agent's
//   own record says 1,081 -- the upload simply had not arrived yet.
//
//   The rollup `agent_app_hourly` was used first and cannot be: its intervals
//   are cut at each clock hour, so an interval spread over five-minute windows
//   covers the middle of an hour more often than its edges. Measured over six
//   hours, that alone drew a triangle wave from 1,069 at :00 to 2,007 at :25
//   and back to 1,088 at :55, on traffic the raw observations show as flat
//   (1,075 / 1,103 / 1,095). An hourly rhythm that is not in the network.
//
// Each half is stored under its own `source`, so neither can overwrite the
// other and the chart can say which part of a period it actually has.
//
// Folding after the fact also means the poll loop is untouched. The loop is
// where P3-112 and P3-139 both went wrong, and it is not the place to add work.

const BUCKET_MS = 5 * 60 * 1000;
// Matches what `connections` itself keeps, so the chart cannot outlive its
// source or fall behind it.
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// One window of slack for the router fold, because the timer that folds is the
// same length as the window and may land either side of the boundary. Any
// older window closed unwatched and no longer holds its flows.
const MAX_FOLD_LAG_BUCKETS = 2;
// How far back the agent half is counted again on every pass. An Agent
// uploading a batch late adds observations to windows that have already been
// folded; recounting them makes late arrivals correct rather than lost. An
// hour, because a window measured on the Hub was still filling half an hour
// after it closed.
const AGENT_REFOLD_WINDOWS = 12;
// One window at a time, always. Counting a window and writing the result was
// measured at about 54 ms on a Hub with 1.7 million agent observations -- a
// read-only estimate of 6.6 ms left out the delete and the insert, and
// twenty-four of them in one transaction blocked the event loop for 1.3
// seconds, undoing P3-139 the day after it was verified. Whatever needs
// counting is queued and drained one window per tick, each in its own
// transaction, so the longest thing this can hold the loop for is one window.
const AGENT_WINDOWS_PER_TICK = 1;

const SOURCE_ROUTER = 'router';
const SOURCE_AGENT = 'agent';

function bucketStartFor(at, bucketMs = BUCKET_MS) {
  return Math.floor(at / bucketMs) * bucketMs;
}

/**
 * @param {{ getDb: () => object, logger?: object, now?: () => number }} deps
 */
function createConnectionBuckets({ getDb, logger = console, now = () => Date.now() }) {
  let lastFoldedThrough = null;
  let agentBackfilledFrom = null;
  // Windows waiting to be counted, oldest request first. Draining it one
  // window at a time is what keeps the event loop free.
  const agentQueue = [];

  function hasTable(db, name = 'connection_buckets') {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name);
  }

  /** The newest router window already folded, or null when there is none. */
  function foldedThrough() {
    const db = getDb();
    if (!db || !hasTable(db)) return null;
    if (lastFoldedThrough != null) return lastFoldedThrough;
    const row = db.prepare('SELECT MAX(bucketStart) AS newest FROM connection_buckets WHERE source = ?')
      .get(SOURCE_ROUTER);
    lastFoldedThrough = row?.newest ?? null;
    return lastFoldedThrough;
  }

  /**
   * Count the router half of every window that has closed since the last fold.
   *
   * Flows an Agent also saw are left out: they are counted from the Agent's own
   * record, which knows when they happened, and counting them here as well
   * would report the same flow twice.
   */
  function foldRouter({ bucketMs = BUCKET_MS, maxLagBuckets = MAX_FOLD_LAG_BUCKETS } = {}) {
    const db = getDb();
    if (!db || !hasTable(db)) return { folded: 0, rows: 0, skipped: 0 };

    const currentStart = bucketStartFor(now(), bucketMs);
    const oldestFoldable = currentStart - bucketMs * maxLagBuckets;

    let from = foldedThrough();
    // First run: nothing is folded for the past. A Hub that starts today can
    // describe today from here on, and the agent half fills in what it can.
    if (from == null) from = oldestFoldable - bucketMs;

    let skipped = 0;
    if (from + bucketMs < oldestFoldable) {
      skipped = Math.round((oldestFoldable - (from + bucketMs)) / bucketMs);
      from = oldestFoldable - bucketMs;
    }

    const hasAgentObservations = hasTable(db, 'connection_agent_observations');
    const insert = db.prepare(`
      INSERT INTO connection_buckets (bucketStart, dst, source, flows)
      SELECT ?, c.dst, '${SOURCE_ROUTER}', COUNT(*)
      FROM connections c
      WHERE c.lastSeen >= ? AND c.lastSeen < ?
      ${hasAgentObservations ? `AND NOT EXISTS (
        SELECT 1 FROM connection_agent_observations a
        WHERE a.src = c.src AND a.dst = c.dst AND a.dport = c.dport AND a.proto = c.proto
      )` : ''}
      GROUP BY c.dst
      ON CONFLICT(bucketStart, dst, source) DO UPDATE SET flows = excluded.flows
    `);

    let folded = 0;
    let rows = 0;
    const run = db.transaction(() => {
      for (let start = from + bucketMs; start < currentStart; start += bucketMs) {
        rows += insert.run(start, start, start + bucketMs).changes;
        folded += 1;
        lastFoldedThrough = start;
      }
    });
    run();
    return { folded, rows, skipped };
  }

  /**
   * Count the agent half of one window, replacing whatever was there.
   *
   * Safe to run over the same window any number of times: the Agent's
   * observation times do not move, so the answer only improves as late uploads
   * land. One window, one transaction -- see AGENT_WINDOWS_PER_TICK.
   */
  function foldAgentWindow(bucketStart, bucketMs = BUCKET_MS) {
    const db = getDb();
    if (!db || !hasTable(db) || !hasTable(db, 'agent_observations')) return 0;

    const clear = db.prepare('DELETE FROM connection_buckets WHERE bucketStart = ? AND source = ?');
    // A flow counts in every window its observation covers. The raw
    // observations are used rather than the hourly rollup because the rollup's
    // intervals stop at each clock hour, which puts an hourly rhythm into the
    // chart that is not in the network.
    const insert = db.prepare(`
      INSERT INTO connection_buckets (bucketStart, dst, source, flows)
      SELECT ?, remoteAddress, '${SOURCE_AGENT}',
             COUNT(DISTINCT localAddress || '|' || remotePort || '|' || networkProtocol)
      FROM agent_observations
      WHERE firstObservedAt < ? AND lastObservedAt >= ?
      GROUP BY remoteAddress
    `);

    let rows = 0;
    db.transaction(() => {
      clear.run(bucketStart, SOURCE_AGENT);
      rows = insert.run(bucketStart, bucketStart + bucketMs, bucketStart).changes;
    })();
    return rows;
  }

  /**
   * Queue the recent past for counting again, including windows already
   * counted before a late upload arrived.
   */
  function queueRecentAgentWindows({ bucketMs = BUCKET_MS, refoldWindows = AGENT_REFOLD_WINDOWS } = {}) {
    const currentStart = bucketStartFor(now(), bucketMs);
    let queued = 0;
    for (let i = refoldWindows; i >= 1; i -= 1) {
      const start = currentStart - bucketMs * i;
      if (!agentQueue.includes(start)) { agentQueue.push(start); queued += 1; }
    }
    return queued;
  }

  /**
   * Take the next window of the past that has never been counted, so the
   * backfill walks backwards without ever holding the loop for more than one
   * window. Returns null once the Agents' own history has been walked to its
   * beginning -- nothing here is an estimate, so there is nothing to invent
   * beyond it.
   */
  function queueNextPastAgentWindow({ bucketMs = BUCKET_MS, retentionMs = RETENTION_MS } = {}) {
    const db = getDb();
    if (!db || !hasTable(db) || !hasTable(db, 'agent_observations')) return null;

    const oldestAgentAt = db.prepare('SELECT MIN(firstObservedAt) AS oldest FROM agent_observations').get()?.oldest;
    if (oldestAgentAt == null) return null;

    const floor = Math.max(
      bucketStartFor(oldestAgentAt, bucketMs),
      bucketStartFor(now() - retentionMs, bucketMs)
    );
    if (agentBackfilledFrom == null) {
      const oldest = db.prepare('SELECT MIN(bucketStart) AS oldest FROM connection_buckets WHERE source = ?')
        .get(SOURCE_AGENT)?.oldest;
      agentBackfilledFrom = oldest ?? bucketStartFor(now(), bucketMs);
    }
    if (agentBackfilledFrom <= floor) return null;

    agentBackfilledFrom -= bucketMs;
    agentQueue.push(agentBackfilledFrom);
    return agentBackfilledFrom;
  }

  /**
   * Count whatever is queued, one window per call.
   *
   * Returns `{ folded, rows, pending }` so the caller can log progress and
   * know whether to come back.
   */
  function drainAgentQueue({ bucketMs = BUCKET_MS, windows = AGENT_WINDOWS_PER_TICK } = {}) {
    let folded = 0;
    let rows = 0;
    for (let i = 0; i < windows && agentQueue.length; i += 1) {
      rows += foldAgentWindow(agentQueue.shift(), bucketMs);
      folded += 1;
    }
    return { folded, rows, pending: agentQueue.length };
  }

  /** Drop buckets older than the window `connections` itself keeps. */
  function prune({ retentionMs = RETENTION_MS } = {}) {
    const db = getDb();
    if (!db || !hasTable(db)) return 0;
    return db.prepare('DELETE FROM connection_buckets WHERE bucketStart < ?')
      .run(now() - retentionMs).changes;
  }

  /**
   * The oldest window the chart can describe, and the oldest it can describe
   * in full.
   *
   * Before `routerFrom` only the Agents' own record exists, so the line there
   * is the traffic they saw and not everything that went out. The screen has
   * to say so; a period drawn without that caveat reads as a measurement of
   * the whole network, which it is not.
   */
  function coverage() {
    const db = getDb();
    if (!db || !hasTable(db)) return { from: null, routerFrom: null };
    const row = db.prepare(`
      SELECT MIN(bucketStart) AS oldest,
             MIN(CASE WHEN source = ? THEN bucketStart END) AS oldestRouter
      FROM connection_buckets
    `).get(SOURCE_ROUTER);
    return { from: row?.oldest ?? null, routerFrom: row?.oldestRouter ?? null };
  }

  /** The oldest window the chart can describe at all. */
  function earliestBucket() {
    return coverage().from;
  }

  function _resetForTest() {
    lastFoldedThrough = null;
    agentBackfilledFrom = null;
    agentQueue.length = 0;
  }

  return {
    foldRouter,
    foldAgentWindow,
    queueRecentAgentWindows,
    queueNextPastAgentWindow,
    drainAgentQueue,
    prune,
    foldedThrough,
    coverage,
    earliestBucket,
    bucketStartFor,
    BUCKET_MS,
    _resetForTest,
    logger,
  };
}

module.exports = {
  createConnectionBuckets,
  bucketStartFor,
  BUCKET_MS,
  RETENTION_MS,
  MAX_FOLD_LAG_BUCKETS,
  AGENT_WINDOWS_PER_TICK,
  SOURCE_ROUTER,
  SOURCE_AGENT,
};
