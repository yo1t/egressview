'use strict';

/**
 * Validate the observation junction table. While the v4 compatibility column
 * exists, also compare its expected router kinds and merge cardinality. After
 * v5 removes that column, validate the junction's structural invariants.
 * The caller owns the database connection; all reads share one snapshot.
 */
function checkObservationConsistency(db, checkedAt = Date.now()) {
  if (!db) return null;

  return db.transaction(() => {
    const hasSource = db.prepare('PRAGMA table_info(connections)').all()
      .some(column => column.name === 'source');
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
    const missingObservations = db.prepare(`
      SELECT COUNT(*) AS n FROM connections c
      WHERE NOT EXISTS (
        SELECT 1 FROM connection_observations o
        WHERE o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      )${agentObserved}
    `).get().n;
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
