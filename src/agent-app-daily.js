'use strict';

// Which app a flow belonged to, rolled up by day.
//
// The summary answers "which applications was this network talking to" by
// grouping `agent_app_hourly` down to one row per flow per app across the whole
// period. The grouping key does not match that table's primary key, so SQLite
// builds a temporary B-tree every time, over every hourly row in range.
// Measured on a Hub: reading the rows costs 113 ms and grouping them costs
// 1,275 ms -- 674,231 rows folded into 52,965 groups, on the event loop, every
// time the summary cache expires. A fourteen-day view froze the Hub for 1.6
// seconds (P3-150, P3-156).
//
// Folding the hours into days first makes the same answer cheap, because the
// set of distinct flow-and-app pairs does not change when the hours they were
// seen in are collapsed. Measured against the Hub's own data: 674,958 hourly
// rows become 154,696 daily ones, 97.6 MB becomes 22.4 MB, and the fourteen-day
// aggregation drops from 1,609 ms to 343 ms with byte-identical results -- the
// same 354 applications with the same counts, at every range from one hour to
// fourteen days.
//
// What it cannot do is answer for part of a day exactly. A flow seen at 09:00
// and again at 23:00 has one daily row spanning both, so a window from 14:00 to
// 16:00 matches it where the hourly rows would not. The reader picks: short
// periods keep using the hourly table, where the same query costs 23 to 496 ms
// and is exact.

const DAY_MS = 24 * 60 * 60 * 1000;
// One day per tick. A day is up to about 85,000 hourly rows, and folding one
// was measured at roughly 260 ms of the 2,081 ms it took to build all eight --
// too long to do several of at once on the loop that serves the UI (P3-139).
const DAYS_PER_TICK = 1;

function dayStartFor(at) {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/**
 * @param {{ getDb: () => object, logger?: object, now?: () => number }} deps
 */
function createAgentAppDaily({ getDb, logger = console, now = () => Date.now() }) {
  function hasTable(db, name) {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name);
  }

  function ready(db) {
    return !!db && hasTable(db, 'agent_app_daily') && hasTable(db, 'agent_app_hourly');
  }

  /** The newest day already folded, or null when none has been. */
  function foldedThrough() {
    const db = getDb();
    if (!ready(db)) return null;
    return db.prepare('SELECT MAX(dayStart) AS newest FROM agent_app_daily').get()?.newest ?? null;
  }

  /**
   * Fold one day of hourly rows, replacing whatever was there for it.
   *
   * Safe to run over the same day again: the hours it reads do not move, so a
   * recount only picks up what arrived late.
   */
  function foldDay(dayStart) {
    const db = getDb();
    if (!ready(db)) return 0;
    let rows = 0;
    db.transaction(() => {
      db.prepare('DELETE FROM agent_app_daily WHERE dayStart = ?').run(dayStart);
      rows = db.prepare(`
        INSERT INTO agent_app_daily (
          dayStart, agentId, appIdentity, processName,
          localAddress, remoteAddress, remotePort, networkProtocol,
          firstObservedAt, lastObservedAt
        )
        SELECT ?, agentId, appIdentity, MAX(processName),
               localAddress, remoteAddress, remotePort, UPPER(networkProtocol),
               MIN(firstObservedAt), MAX(lastObservedAt)
        FROM agent_app_hourly
        WHERE hourStart >= ? AND hourStart < ?
        GROUP BY agentId, appIdentity, localAddress, remoteAddress, remotePort, UPPER(networkProtocol)
      `).run(dayStart, dayStart, dayStart + DAY_MS).changes;
    })();
    return rows;
  }

  /**
   * Fold the days that have closed since the last pass, and today again.
   *
   * Today is folded again on every pass because it is still filling: the point
   * of the table is that a long view is cheap, and a long view that stops at
   * midnight would answer for everything except the part someone is most
   * likely looking at.
   */
  function fold({ daysPerTick = DAYS_PER_TICK } = {}) {
    const db = getDb();
    if (!ready(db)) return { folded: 0, rows: 0, pending: 0 };

    const today = dayStartFor(now());
    const oldestHour = db.prepare('SELECT MIN(hourStart) AS oldest FROM agent_app_hourly').get()?.oldest;
    if (oldestHour == null) return { folded: 0, rows: 0, pending: 0 };

    const from = dayStartFor(oldestHour);
    const done = new Set(
      db.prepare('SELECT dayStart FROM agent_app_daily GROUP BY dayStart').all().map(r => r.dayStart)
    );

    const outstanding = [];
    for (let day = from; day <= today; day += DAY_MS) {
      // Today is never "done": more hours land in it until midnight.
      if (day === today || !done.has(day)) outstanding.push(day);
    }

    let folded = 0;
    let rows = 0;
    for (const day of outstanding.slice(0, daysPerTick)) {
      rows += foldDay(day);
      folded += 1;
    }
    return { folded, rows, pending: Math.max(0, outstanding.length - folded) };
  }

  /** Drop days older than the hourly rows they were folded from. */
  function prune({ retentionMs }) {
    const db = getDb();
    if (!ready(db)) return 0;
    return db.prepare('DELETE FROM agent_app_daily WHERE dayStart < ?')
      .run(dayStartFor(now() - retentionMs)).changes;
  }

  return { fold, foldDay, foldedThrough, prune, dayStartFor, DAY_MS, logger };
}

module.exports = { createAgentAppDaily, dayStartFor, DAY_MS, DAYS_PER_TICK };
