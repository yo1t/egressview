'use strict';

const { AGENT_INGEST_DEFAULT_RETENTION_MS } = require('./agent-ingest-schema');

/**
 * Validate the observation junction table. While the v4 compatibility column
 * exists, also compare its expected router kinds and merge cardinality. After
 * v5 removes that column, validate the junction's structural invariants.
 * The caller owns the database connection; all reads share one snapshot.
 */
function checkObservationConsistency(db, checkedAt = Date.now()) {
  if (!db) return null;

  return db.transaction(() => {
    const connectionColumns = new Set(
      db.prepare('PRAGMA table_info(connections)').all().map(column => column.name)
    );
    const hasSource = connectionColumns.has('source');
    // "Every connection was observed by a router" stopped being true when an
    // endpoint agent became a collection source of its own: an agent has no
    // router identity, so its flows deliberately record no router observation.
    // Counting those as missing raised an ERROR on every start describing an
    // inconsistency that did not exist -- and the deploy gate counts ERRORs, so
    // an expected one would have hidden a real one.
    const hasAgentObservations = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_observations'`
    ).get();
    const agentObserved = hasAgentObservations ? `
      AND NOT EXISTS (
        SELECT 1 FROM agent_observations a
        WHERE a.localAddress = c.src AND a.remoteAddress = c.dst
          AND a.remotePort = c.dport AND LOWER(a.networkProtocol) = LOWER(c.proto)
      )` : '';
    // An agent's observations are kept for seven days and the connection rows
    // built from them for two years, so once an agent-only flow ages out its
    // row has nothing left to account for it. That is retention working, not
    // a missing record: on 2026-09-30 it was 903 of the 920 rows this check
    // reported, and an expected ERROR that size would hide a real one.
    const agentRowsKnown = hasAgentObservations
      && connectionColumns.has('agentHost') && connectionColumns.has('lastSeen');
    // The row's lastSeen is when the Hub received the observation, while the
    // observation is pruned by when the agent saw it. A backlog that arrives
    // late leaves rows newer than the observations they came from: on
    // 2026-10-07, sixteen rows first seen 09-29 and received 10-03 had lost
    // their observations by 10-06. The agent's own first-seen time is the one
    // retention can be judged by. It also retires rows an opening report keyed
    // on 0.0.0.0 or :: before the Hub learned to move them (P3-185).
    const firstSeenKnown = connectionColumns.has('firstSeen');
    const pastAgentRetention = agentRowsKnown
      ? ` AND NOT (c.agentHost IS NOT NULL AND (c.lastSeen < @agentRetentionStart${
        firstSeenKnown ? ' OR c.firstSeen < @agentRetentionStart' : ''}))`
      : '';
    const missingObservations = db.prepare(`
      SELECT COUNT(*) AS n FROM connections c
      WHERE NOT EXISTS (
        SELECT 1 FROM connection_observations o
        WHERE o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      )${agentObserved}${pastAgentRetention}
    `).get(agentRowsKnown
      ? { agentRetentionStart: checkedAt - AGENT_INGEST_DEFAULT_RETENTION_MS }
      : {}).n;
    const orphanObservations = db.prepare(`
      SELECT COUNT(*) AS n FROM connection_observations o
      LEFT JOIN connections c
        ON c.src = o.src AND c.dst = o.dst AND c.dport = o.dport AND c.proto = o.proto
      WHERE c.src IS NULL
    `).get().n;
    const underMerged = hasSource ? db.prepare(`
        SELECT COUNT(*) AS n FROM connections c
        WHERE c.source = 'yamaha+cisco' AND (
          SELECT COUNT(*) FROM connection_observations o
          WHERE o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
        ) < 2
      `).get().n : 0;
    const kindMismatches = hasSource ? db.prepare(`
        SELECT COUNT(*) AS n FROM connections c
        WHERE
          (c.source IN ('yamaha', 'yamaha+cisco') AND NOT EXISTS (
            SELECT 1 FROM connection_observations o
            JOIN routers r ON r.id = o.routerId
            WHERE o.src = c.src AND o.dst = c.dst AND o.dport = c.dport
              AND o.proto = c.proto AND r.kind = 'yamaha'
          ))
          OR
          (c.source IN ('cisco', 'yamaha+cisco') AND NOT EXISTS (
            SELECT 1 FROM connection_observations o
            JOIN routers r ON r.id = o.routerId
            WHERE o.src = c.src AND o.dst = c.dst AND o.dport = c.dport
              AND o.proto = c.proto AND r.kind = 'cisco'
          ))
      `).get().n : db.prepare(`
        SELECT COUNT(*) AS n FROM connection_observations o
        LEFT JOIN routers r ON r.id = o.routerId
        WHERE r.id IS NULL OR r.kind IS NULL OR TRIM(r.kind) = ''
      `).get().n;

    return {
      missingObservations,
      orphanObservations,
      underMerged,
      kindMismatches,
      checkedAt,
    };
  })();
}

module.exports = { checkObservationConsistency };
