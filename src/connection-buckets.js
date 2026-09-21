'use strict';

// When traffic happened, which `connections` cannot say.
//
// `connections` holds one row per flow and updates it every time the flow is
// seen again. Asking it "how many flows were there at 10am" returns the flows
// whose *last* sighting was at 10am -- everything still running has moved to
// now. On one Hub that made a six-hour chart rise from 156 to 1,115 with no
// change in traffic, and the shape could not be anything else.
//
// A closed five-minute window can be counted correctly, though, and only then:
// a flow seen during the window has a lastSeen inside it until the next
// sighting moves it. So each window is folded once, just after it closes, and
// the fold is what the chart reads. This is the same thing the macOS Agent
// does with `chart_hourly`; the Hub simply never did it.
//
// Folding after the fact also means the poll loop is untouched. The loop is
// where P3-112 and P3-139 both went wrong, and it is not the place to add work.

const BUCKET_MS = 5 * 60 * 1000;
// Matches what `connections` itself keeps, so the chart cannot outlive its
// source or fall behind it.
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// A fold that has fallen a long way behind -- a Hub that was off for a week --
// must not try to catch up in one pass and stall the loop doing it.
// A window can only be counted while the flows seen in it still carry a
// lastSeen inside it. Once a flow is seen again, its row moves, and the window
// it used to belong to is gone -- counting it then returns the flows that
// *stopped* during it, which is the distortion this table exists to remove. So
// a window is folded once, just after it closes, and never afterwards. If the
// Hub was down when it closed, that window has no record and the screen says
// so; inventing a number for it would be worse than admitting the gap.
//
// One window of slack, because the timer that folds is the same length as the
// window and may land either side of the boundary.
const MAX_FOLD_LAG_BUCKETS = 2;

function bucketStartFor(at, bucketMs = BUCKET_MS) {
  return Math.floor(at / bucketMs) * bucketMs;
}

/**
 * @param {{ getDb: () => object, logger?: object, now?: () => number }} deps
 */
function createConnectionBuckets({ getDb, logger = console, now = () => Date.now() }) {
  let lastFoldedThrough = null;

  function hasTable(db) {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connection_buckets'"
    ).get();
  }

  /** The newest bucket already folded, or null when nothing has been. */
  function foldedThrough() {
    const db = getDb();
    if (!db || !hasTable(db)) return null;
    if (lastFoldedThrough != null) return lastFoldedThrough;
    const row = db.prepare('SELECT MAX(bucketStart) AS newest FROM connection_buckets').get();
    lastFoldedThrough = row?.newest ?? null;
    return lastFoldedThrough;
  }

  /**
   * Fold every window that has closed since the last fold.
   *
   * Returns what it did, so a caller can log it and a test can assert it.
   */
  function fold({ bucketMs = BUCKET_MS, maxLagBuckets = MAX_FOLD_LAG_BUCKETS } = {}) {
    const db = getDb();
    if (!db || !hasTable(db)) return { folded: 0, rows: 0, skipped: 0 };

    const currentStart = bucketStartFor(now(), bucketMs);
    // The oldest window still countable. Anything older closed while we were
    // not looking, and no longer has its flows.
    const oldestFoldable = currentStart - bucketMs * maxLagBuckets;

    let from = foldedThrough();
    // First run: nothing is folded for the past. A Hub that starts today can
    // describe today, and `earliestBucket()` tells the screen where the record
    // begins so it can say what it has no answer for.
    if (from == null) from = oldestFoldable - bucketMs;

    let skipped = 0;
    if (from + bucketMs < oldestFoldable) {
      skipped = Math.round((oldestFoldable - (from + bucketMs)) / bucketMs);
      from = oldestFoldable - bucketMs;
    }

    const insert = db.prepare(`
      INSERT INTO connection_buckets (bucketStart, dst, flows)
      SELECT ?, dst, COUNT(*) FROM connections
      WHERE lastSeen >= ? AND lastSeen < ?
      GROUP BY dst
      ON CONFLICT(bucketStart, dst) DO UPDATE SET flows = excluded.flows
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

  /** Drop buckets older than the window `connections` itself keeps. */
  function prune({ retentionMs = RETENTION_MS } = {}) {
    const db = getDb();
    if (!db || !hasTable(db)) return 0;
    return db.prepare('DELETE FROM connection_buckets WHERE bucketStart < ?')
      .run(now() - retentionMs).changes;
  }

  /**
   * The oldest window the chart can describe.
   *
   * A range that starts before this has no record, and the screen has to say
   * so rather than draw a line through it. Folding begins when this table
   * does, so every Hub has a stretch of history it cannot answer for.
   */
  function earliestBucket() {
    const db = getDb();
    if (!db || !hasTable(db)) return null;
    return db.prepare('SELECT MIN(bucketStart) AS oldest FROM connection_buckets').get()?.oldest ?? null;
  }

  function _resetForTest() {
    lastFoldedThrough = null;
  }

  return { fold, prune, foldedThrough, earliestBucket, bucketStartFor, BUCKET_MS, _resetForTest, logger };
}

module.exports = { createConnectionBuckets, bucketStartFor, BUCKET_MS, RETENTION_MS, MAX_FOLD_LAG_BUCKETS };
