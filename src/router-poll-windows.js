// Which five-minute windows the routers actually answered in.
//
// The timeline draws one bar per window. Until now a window in which the
// router never answered -- rebooting, link down, or the Hub itself not
// running -- drew the same bar as a window in which nothing was sent, and
// those mean opposite things: "not known" and "nothing left the network".
//
// A user asked about exactly this on the Agent side: a machine had been down
// for three minutes and the chart showed the usual bars (P3-157). The Agents
// now draw those minutes; the Hub kept nothing to draw from, because poll
// failures went to the log and nowhere else.
//
// One row per router per window. The poll runs once a minute, so this is one
// write a minute per router, and the gaps are the complement of the windows
// that hold a success.
'use strict';

const { BUCKET_MS, RETENTION_MS } = require('./connection-buckets');

// Nothing is said about time before the first window recorded here. The
// record genuinely does not know, but hatching every day that predates this
// feature would report an outage where there was only no measurement -- a
// worse lie than the one being fixed.
function bucketOf(at) {
  return Math.floor(at / BUCKET_MS) * BUCKET_MS;
}

function recordPoll(db, routerId, at, { ok }) {
  if (!db || !routerId) return;
  db.prepare(`
    INSERT INTO router_poll_windows (routerId, bucketStart, polls, failures)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(routerId, bucketStart) DO UPDATE SET
      polls = polls + excluded.polls,
      failures = failures + excluded.failures
  `).run(routerId, bucketOf(at), ok ? 1 : 0, ok ? 0 : 1);
}

function recordedSpan(db) {
  try {
    const row = db.prepare(
      'SELECT MIN(bucketStart) AS first, MAX(bucketStart) AS last FROM router_poll_windows'
    ).get();
    if (!row || row.first == null) return null;
    return { first: row.first, last: row.last };
  } catch {
    return null;
  }
}

/**
 * The windows inside [from, to] that no router answered in, merged into
 * intervals.
 *
 * Bounded to the span this table covers at both ends. Before the first
 * recorded window there is no measurement, and the newest window is still
 * open -- a poll may yet land in it, so calling it a gap would put a hatched
 * band on the right edge of every chart.
 */
function pollGaps(db, { from, to, now = Date.now() } = {}) {
  if (!db || from == null || to == null) return [];
  const span = recordedSpan(db);
  if (!span) return [];
  const openWindow = bucketOf(now);
  const start = Math.max(bucketOf(from), span.first);
  const end = Math.min(bucketOf(to), span.last, openWindow - BUCKET_MS);
  if (end < start) return [];

  const answered = new Set();
  const rows = db.prepare(`
    SELECT bucketStart FROM router_poll_windows
    WHERE bucketStart >= ? AND bucketStart <= ? AND polls > 0
    GROUP BY bucketStart
  `).all(start, end);
  for (const row of rows) answered.add(row.bucketStart);

  const gaps = [];
  let open = null;
  for (let at = start; at <= end; at += BUCKET_MS) {
    if (answered.has(at)) {
      if (open) { gaps.push({ from: open, to: at }); open = null; }
    } else if (!open) {
      open = at;
    }
  }
  if (open) gaps.push({ from: open, to: end + BUCKET_MS });
  return gaps;
}

function prune(db, { now = Date.now(), retentionMs = RETENTION_MS } = {}) {
  if (!db) return 0;
  const info = db.prepare('DELETE FROM router_poll_windows WHERE bucketStart < ?')
    .run(bucketOf(now - retentionMs));
  return info.changes || 0;
}

module.exports = { recordPoll, pollGaps, prune, recordedSpan, bucketOf };
