'use strict';

// Connection rows an agent's opening report keyed on a local address it did
// not know yet (P3-185).
//
// A UDP socket that is not connected, or not bound to one interface, reports
// its local address as 0.0.0.0 or :: when the flow opens. The closing report
// often names the real address, and the Hub stores it on the observation --
// but the connection row was built from the opening report and keyed on the
// wildcard. On 2026-10-07 the Hub's log showed fifteen such flows from one Mac
// (mDNSResponder, Chrome, VMware's NAT) with 0.0.0.0 or :: as their source,
// so the log could not say which device sent them, and the startup
// consistency check counted them as rows with no observation behind them.
//
// Moving a row means: the row for the real address takes the placeholder's
// times (and is created from it if there is none), and the placeholder goes --
// unless something still accounts for it. A router that saw the wildcard key,
// or another agent observation that still has the wildcard as its local
// address, keeps it.
//
// Only as each closing report arrives, where every lookup is by key. Rows
// already stranded are left: finding their real address means searching the
// agent's observations by destination, which has no index -- a dry run on the
// Hub's 2.3 million observations had not finished after five minutes.

const UNSPECIFIED = new Set(['0.0.0.0', '::', '']);

const COLUMNS = [
  'src', 'dst', 'dport', 'proto', 'sport', 'ttl', 'srcMac', 'srcVendor', 'srcDnsName',
  'srcMdnsName', 'dstHost', 'country', 'org', 'lat', 'lon', 'city', 'firstSeen',
  'lastSeen', 'agentHost', 'process', 'pid',
];

function keyOf(src, dst, dport, proto) {
  return `${src}|${dst}|${dport}|${proto}`;
}

function hasTable(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/**
 * @param {{ getDb: () => import('better-sqlite3').Database|null, cache: Map<string, object> }} options
 */
function createAgentPlaceholderRows({ getDb, cache }) {
  /**
   * Moves the row for `fromSrc` to `toSrc`. Returns what happened, or null when
   * there was nothing to do.
   */
  function relocate({ fromSrc, toSrc, toSport = null, dst, dport, proto }) {
    const db = getDb();
    if (!db || !UNSPECIFIED.has(fromSrc) || UNSPECIFIED.has(toSrc) || !toSrc) return null;
    const fromKey = keyOf(fromSrc, dst, dport, proto);
    const toKey = keyOf(toSrc, dst, dport, proto);
    const cachedFrom = cache.get(fromKey);

    const outcome = db.transaction(() => {
      const stored = db.prepare(
        `SELECT ${COLUMNS.join(', ')} FROM connections WHERE src = ? AND dst = ? AND dport = ? AND proto = ?`
      ).get(fromSrc, dst, dport, proto);
      if (!stored && !cachedFrom) return null;
      const routerSaw = db.prepare(
        'SELECT 1 FROM connection_observations WHERE src = ? AND dst = ? AND dport = ? AND proto = ? LIMIT 1'
      ).get(fromSrc, dst, dport, proto);
      if (routerSaw) return null;
      const stillUsed = hasTable(db, 'agent_observations') && Boolean(db.prepare(`
        SELECT 1 FROM agent_observations
        WHERE localAddress = ? AND remoteAddress = ? AND remotePort = ?
          AND LOWER(networkProtocol) = LOWER(?)
        LIMIT 1
      `).get(fromSrc, dst, dport, proto));

      // What memory knows may be newer than the table: the periodic snapshot
      // writes plain lastSeen bumps later.
      const source = { ...(stored || {}), ...(cachedFrom || {}) };
      const firstSeen = Math.min(...[stored?.firstSeen, cachedFrom?.firstSeen].filter(Number.isFinite));
      const lastSeen = Math.max(...[stored?.lastSeen, cachedFrom?.lastSeen].filter(Number.isFinite));

      const existing = db.prepare(
        'SELECT 1 FROM connections WHERE src = ? AND dst = ? AND dport = ? AND proto = ?'
      ).get(toSrc, dst, dport, proto);
      if (existing) {
        db.prepare(`
          UPDATE connections SET
            firstSeen = MIN(firstSeen, @firstSeen), lastSeen = MAX(lastSeen, @lastSeen),
            sport = COALESCE(sport, @sport), agentHost = COALESCE(agentHost, @agentHost),
            process = COALESCE(process, @process), pid = COALESCE(pid, @pid)
          WHERE src = @src AND dst = @dst AND dport = @dport AND proto = @proto
        `).run({
          firstSeen, lastSeen, sport: toSport ?? source.sport ?? null,
          agentHost: source.agentHost ?? null, process: source.process ?? null, pid: source.pid ?? null,
          src: toSrc, dst, dport, proto,
        });
      } else {
        const row = {};
        for (const column of COLUMNS) row[column] = source[column] ?? null;
        Object.assign(row, { src: toSrc, sport: toSport ?? source.sport ?? null, firstSeen, lastSeen });
        db.prepare(
          `INSERT INTO connections (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(c => `@${c}`).join(', ')})`
        ).run(row);
      }
      if (!stillUsed) {
        if (hasTable(db, 'connection_agent_observations')) {
          db.prepare(`
            UPDATE OR IGNORE connection_agent_observations SET src = ?
            WHERE src = ? AND dst = ? AND dport = ? AND UPPER(proto) = UPPER(?)
          `).run(toSrc, fromSrc, dst, dport, proto);
        }
        db.prepare('DELETE FROM connections WHERE src = ? AND dst = ? AND dport = ? AND proto = ?')
          .run(fromSrc, dst, dport, proto);
      }
      return { firstSeen, lastSeen, merged: Boolean(existing), placeholderRemoved: !stillUsed };
    })();
    if (!outcome) return null;

    // Memory follows the table, or the next snapshot would write the
    // placeholder back.
    const cachedTo = cache.get(toKey);
    if (cachedTo) {
      cachedTo.firstSeen = Math.min(cachedTo.firstSeen ?? outcome.firstSeen, outcome.firstSeen);
      cachedTo.lastSeen = Math.max(cachedTo.lastSeen ?? outcome.lastSeen, outcome.lastSeen);
    } else if (cachedFrom) {
      cache.set(toKey, {
        ...cachedFrom,
        src: toSrc,
        sport: toSport ?? cachedFrom.sport ?? null,
        firstSeen: outcome.firstSeen,
        lastSeen: outcome.lastSeen,
      });
    }
    if (outcome.placeholderRemoved) cache.delete(fromKey);
    return outcome;
  }

  return { relocate };
}

module.exports = { createAgentPlaceholderRows, UNSPECIFIED };
