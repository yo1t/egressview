'use strict';

/**
 * Compare the v4 compatibility column with the observation junction table.
 * The caller owns the database connection; all reads share one snapshot.
 */
function checkObservationConsistency(db, checkedAt = Date.now()) {
  if (!db) return null;

  return db.transaction(() => {
    const missingObservations = db.prepare(`
      SELECT COUNT(*) AS n FROM connections c
      LEFT JOIN (
        SELECT src, dst, dport, proto, COUNT(*) AS obs
        FROM connection_observations GROUP BY src, dst, dport, proto
      ) o ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      WHERE COALESCE(o.obs, 0) < CASE WHEN c.source = 'yamaha+cisco' THEN 2 ELSE 1 END
    `).get().n;
    const orphanObservations = db.prepare(`
      SELECT COUNT(*) AS n FROM connection_observations o
      LEFT JOIN connections c
        ON c.src = o.src AND c.dst = o.dst AND c.dport = o.dport AND c.proto = o.proto
      WHERE c.src IS NULL
    `).get().n;
    const underMerged = db.prepare(`
      SELECT COUNT(*) AS n FROM connections c
      WHERE c.source = 'yamaha+cisco' AND (
        SELECT COUNT(*) FROM connection_observations o
        WHERE o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      ) < 2
    `).get().n;
    const kindMismatches = db.prepare(`
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
