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
//   Agent-observed flows do carry their times. `agent_app_hourly` keeps, for
//   every flow an Agent saw, the interval it was observed in, and those times
//   never move. That makes the agent half of a window countable at any point:
//   it can be filled in for the past, and it can be counted again later when a
//   batch uploaded late adds to a window that was already folded. Before this,
//   a window folded five seconds after closing held 22 flows where the Agent's
//   own record says 1,081 -- the upload simply had not arrived yet.
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
// How much of the past one backfill pass rebuilds. Measured at 6.6 ms per
// window on a Hub with 1.7 million agent observations, so this is about 160 ms
// of work -- under the event-loop budget P3-139 was fought for, and a week of
// history is filled in within the hour.
const AGENT_BACKFILL_WINDOWS_PER_PASS = 24;

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
   * Count the agent half of a range of windows, replacing whatever was there.
   *
   * Safe to run over the same window any number of times: the Agent's
   * observation times do not move, so the answer only improves as late uploads
   * land.
   */
  function foldAgentRange(fromBucket, toBucket, bucketMs = BUCKET_MS) {
    const db = getDb();
    if (!db || !hasTable(db) || !hasTable(db, 'agent_app_hourly')) return { folded: 0, rows: 0 };

    const clear = db.prepare('DELETE FROM connection_buckets WHERE bucketStart = ? AND source = ?');
    // An hour's rows can overlap the hour either side of their own -- 475 of
    // them did on one Hub -- so both are searched.
    const insert = db.prepare(`
      INSERT INTO connection_buckets (bucketStart, dst, source, flows)
      SELECT ?, remoteAddress, '${SOURCE_AGENT}',
             COUNT(DISTINCT localAddress || '|' || remotePort || '|' || networkProtocol)
      FROM agent_app_hourly
      WHERE hourStart >= ? AND hourStart <= ?
        AND firstObservedAt < ? AND lastObservedAt >= ?
      GROUP BY remoteAddress
    `);

    let folded = 0;
    let rows = 0;
    const run = db.transaction(() => {
      for (let start = fromBucket; start <= toBucket; start += bucketMs) {
        const end = start + bucketMs;
        const hour = Math.floor(start / 3600000) * 3600000;
        clear.run(start, SOURCE_AGENT);
        rows += insert.run(start, hour - 3600000, hour + 3600000, end, start).changes;
        folded += 1;
      }
    });
    run();
    return { folded, rows };
  }

  /**
   * Keep the agent half of the recent past current, including windows that
   * were already counted before a late upload arrived.
   */
  function foldAgent({ bucketMs = BUCKET_MS, refoldWindows = AGENT_REFOLD_WINDOWS } = {}) {
    const currentStart = bucketStartFor(now(), bucketMs);
    const from = currentStart - bucketMs * refoldWindows;
    return foldAgentRange(from, currentStart - bucketMs, bucketMs);
  }

  /**
   * Fill in the agent half of the past, a stretch at a time.
   *
   * Returns `{ done }` so the caller can stop scheduling once the Agent's own
   * history has been walked back to its beginning. Nothing here is an
   * estimate: every window is counted from the times the Agent recorded.
   */
  function backfillAgent({
    bucketMs = BUCKET_MS,
    retentionMs = RETENTION_MS,
    windowsPerPass = AGENT_BACKFILL_WINDOWS_PER_PASS,
  } = {}) {
    const db = getDb();
    if (!db || !hasTable(db) || !hasTable(db, 'agent_app_hourly')) return { folded: 0, rows: 0, done: true };

    const oldestAgentHour = db.prepare('SELECT MIN(hourStart) AS oldest FROM agent_app_hourly').get()?.oldest;
    if (oldestAgentHour == null) return { folded: 0, rows: 0, done: true };

    const floor = Math.max(bucketStartFor(oldestAgentHour, bucketMs), bucketStartFor(now() - retentionMs, bucketMs));
    if (agentBackfilledFrom == null) {
      const oldest = db.prepare('SELECT MIN(bucketStart) AS oldest FROM connection_buckets WHERE source = ?')
        .get(SOURCE_AGENT)?.oldest;
      agentBackfilledFrom = oldest ?? bucketStartFor(now(), bucketMs);
    }
    if (agentBackfilledFrom <= floor) return { folded: 0, rows: 0, done: true };

    const to = agentBackfilledFrom - bucketMs;
    const from = Math.max(floor, to - bucketMs * (windowsPerPass - 1));
    const result = foldAgentRange(from, to, bucketMs);
    agentBackfilledFrom = from;
    return { ...result, done: from <= floor };
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
  }

  return {
    foldRouter,
    foldAgent,
    backfillAgent,
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
  SOURCE_ROUTER,
  SOURCE_AGENT,
};
