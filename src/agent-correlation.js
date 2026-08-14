'use strict';

const DEFAULT_CORRELATION_WINDOW_MS = 90_000;
const DEFAULT_RECONCILE_LIMIT = 5_000;

function intervalDeltaMs(leftStart, leftEnd, rightStart, rightEnd) {
  if (leftEnd < rightStart) return rightStart - leftEnd;
  if (rightEnd < leftStart) return leftStart - rightEnd;
  return 0;
}

function connectionKey(row) {
  return `${row.src}|${row.dst}|${row.dport}|${String(row.proto || row.protocol).toLowerCase()}`;
}

function buildUnifiedReadModel(routerConnections, agentObservations) {
  const routerRows = (routerConnections || []).map(connection => ({
    ...connection,
    sourceKind: 'router',
    sourceIds: [...(connection.observedBy || [])],
    sourceId: connection.observedBy?.length === 1 ? connection.observedBy[0] : null,
    agentAttributions: [],
    agentOnly: false,
  }));
  const byConnection = new Map(routerRows.map(row => [connectionKey(row), row]));
  const agentOnlyRows = [];

  for (const observation of agentObservations || []) {
    if (!observation.agentOnly) {
      const router = byConnection.get(connectionKey({
        src: observation.connectionSrc,
        dst: observation.connectionDst,
        dport: observation.connectionDport,
        proto: observation.connectionProto,
      }));
      if (router) {
        router.agentAttributions.push({
          sourceId: observation.sourceId,
          sourceName: observation.sourceName,
          observationId: observation.observationId,
          processId: observation.processId,
          processName: observation.processName,
          bundleId: observation.bundleId,
          firstObservedAt: observation.firstObservedAt,
          lastObservedAt: observation.lastObservedAt,
          matchKind: observation.matchKind,
          timeDeltaMs: observation.timeDeltaMs,
        });
      }
      continue;
    }
    agentOnlyRows.push({
      src: observation.src,
      dst: observation.dst,
      dport: observation.dport,
      proto: observation.protocol,
      sport: observation.sport,
      firstSeen: observation.firstObservedAt,
      lastSeen: observation.lastObservedAt,
      sourceKind: 'agent',
      sourceId: observation.sourceId,
      sourceName: observation.sourceName,
      processId: observation.processId,
      processName: observation.processName,
      bundleId: observation.bundleId,
      bytesIn: observation.bytesIn,
      bytesOut: observation.bytesOut,
      collector: observation.collector,
      confidence: observation.confidence,
      agentOnly: true,
    });
  }
  return [...routerRows, ...agentOnlyRows];
}

function createAgentCorrelation({ getDb, windowMs = DEFAULT_CORRELATION_WINDOW_MS } = {}) {
  if (typeof getDb !== 'function') throw new TypeError('getDb is required');
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new TypeError('windowMs must be non-negative');

  function database() {
    const db = getDb();
    if (!db) throw new Error('Agent correlation store is not initialized');
    return db;
  }

  function candidatesFor(observation) {
    return database().prepare(`
      SELECT src, dst, dport, proto, sport, firstSeen, lastSeen
      FROM connections
      WHERE src = ? AND dst = ? AND dport = ?
        AND LOWER(proto) = ?
        AND lastSeen >= ? AND firstSeen <= ?
    `).all(
      observation.localAddress,
      observation.remoteAddress,
      observation.remotePort,
      observation.networkProtocol.toLowerCase(),
      observation.firstObservedAt - windowMs,
      observation.lastObservedAt + windowMs
    );
  }

  function classify(observation) {
    const candidates = candidatesFor(observation);
    const localPortKnown = observation.localPort > 0;
    const exact = candidates.filter(candidate =>
      localPortKnown
      && candidate.sport === observation.localPort
      && intervalDeltaMs(
        candidate.firstSeen, candidate.lastSeen,
        observation.firstObservedAt, observation.lastObservedAt
      ) === 0
    );
    if (exact.length === 1) return { candidate: exact[0], matchKind: 'exact-5tuple' };
    if (exact.length > 1) return { reason: 'ambiguous' };

    // A pass-only Network Extension can observe a flow before macOS assigns
    // its ephemeral local port. Correlate that weaker observation only when a
    // single four-tuple candidate overlaps in time; never guess among multiple
    // router sessions.
    if (!localPortKnown) {
      const overlapping = candidates.filter(candidate => intervalDeltaMs(
        candidate.firstSeen, candidate.lastSeen,
        observation.firstObservedAt, observation.lastObservedAt
      ) === 0);
      if (overlapping.length === 1) {
        return { candidate: overlapping[0], matchKind: 'unique-4tuple-time' };
      }
      if (overlapping.length > 1) return { reason: 'ambiguous' };
      return { reason: 'unmatched' };
    }

    // A known, different source port is evidence against a match. The weaker
    // fallback is allowed only when exactly one candidate lacks router sport.
    const unknownSport = candidates.filter(candidate => candidate.sport == null);
    if (unknownSport.length === 1 && candidates.length === 1) {
      return { candidate: unknownSport[0], matchKind: 'unique-4tuple-time' };
    }
    if (candidates.length > 1) return { reason: 'ambiguous' };
    return { reason: 'unmatched' };
  }

  function reconcile({ agentId = null, since = null, limit = DEFAULT_RECONCILE_LIMIT, now = Date.now() } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    if (since != null && !Number.isFinite(since)) throw new TypeError('since must be finite');
    const db = database();
    const params = [];
    const agentFilter = agentId ? 'AND o.agentId = ?' : '';
    if (agentId) params.push(agentId);
    const timeFilter = since != null ? 'AND o.lastObservedAt >= ?' : '';
    if (since != null) params.push(since);
    params.push(limit);
    const observations = db.prepare(`
      SELECT o.*
      FROM agent_observations o
      WHERE NOT EXISTS (
        SELECT 1 FROM connection_agent_observations link
        WHERE link.agentId = o.agentId AND link.observationId = o.observationId
      )
      ${agentFilter}
      ${timeFilter}
      ORDER BY o.lastObservedAt DESC
      LIMIT ?
    `).all(...params);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO connection_agent_observations (
        src, dst, dport, proto, agentId, observationId,
        matchKind, matchedAt, timeDeltaMs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = { examined: observations.length, exact: 0, unique: 0, ambiguous: 0, unmatched: 0 };
    const run = db.transaction(() => {
      for (const observation of observations) {
        const match = classify(observation);
        if (!match.candidate) {
          result[match.reason] += 1;
          continue;
        }
        const candidate = match.candidate;
        const inserted = insert.run(
          candidate.src, candidate.dst, candidate.dport, candidate.proto,
          observation.agentId, observation.observationId, match.matchKind, now,
          intervalDeltaMs(
            candidate.firstSeen, candidate.lastSeen,
            observation.firstObservedAt, observation.lastObservedAt
          )
        ).changes;
        if (inserted) result[match.matchKind === 'exact-5tuple' ? 'exact' : 'unique'] += 1;
      }
    });
    run.immediate();
    return { ...result, linked: result.exact + result.unique };
  }

  function diagnostics() {
    const db = database();
    const stored = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_observations) AS observations,
        COUNT(DISTINCT link.agentId || ':' || link.observationId) AS correlated,
        COALESCE(SUM(link.matchKind = 'exact-5tuple'), 0) AS exact,
        COALESCE(SUM(link.matchKind = 'unique-4tuple-time'), 0) AS uniqueMatch
      FROM connection_agent_observations link
      JOIN agent_observations o
        ON o.agentId = link.agentId AND o.observationId = link.observationId
    `).get();
    const pending = db.prepare(`
      SELECT o.* FROM agent_observations o
      WHERE NOT EXISTS (
        SELECT 1 FROM connection_agent_observations link
        WHERE link.agentId = o.agentId AND link.observationId = o.observationId
      )
    `).all();
    let ambiguous = 0;
    let unmatched = 0;
    for (const observation of pending) {
      const match = classify(observation);
      if (match.reason === 'ambiguous') ambiguous += 1;
      else if (!match.candidate) unmatched += 1;
    }
    return { ...stored, ambiguous, unmatched };
  }

  function queryReadModel({ from = null, to = null, agentId = null, limit = 1_000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    const conditions = [];
    const params = [];
    if (from != null) { conditions.push('o.lastObservedAt >= ?'); params.push(from); }
    if (to != null) { conditions.push('o.firstObservedAt <= ?'); params.push(to); }
    if (agentId) { conditions.push('o.agentId = ?'); params.push(agentId); }
    params.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return database().prepare(`
      SELECT
        o.agentId AS sourceId, a.hostName AS sourceName, 'agent' AS sourceKind,
        o.observationId, o.networkProtocol AS protocol,
        o.localAddress AS src, NULLIF(o.localPort, 0) AS sport,
        o.remoteAddress AS dst, o.remotePort AS dport,
        o.processId, o.processName, o.bundleId,
        o.firstObservedAt, o.lastObservedAt, o.bytesIn, o.bytesOut,
        o.collector, o.confidence,
        link.src AS connectionSrc, link.dst AS connectionDst,
        link.dport AS connectionDport, link.proto AS connectionProto,
        link.matchKind, link.timeDeltaMs,
        CASE WHEN link.observationId IS NULL THEN 1 ELSE 0 END AS agentOnly
      FROM agent_observations o
      JOIN agents a ON a.agentId = o.agentId
      LEFT JOIN connection_agent_observations link
        ON link.agentId = o.agentId AND link.observationId = o.observationId
      ${where}
      ORDER BY o.lastObservedAt DESC
      LIMIT ?
    `).all(...params).map(row => ({ ...row, agentOnly: row.agentOnly === 1 }));
  }

  return { classify, diagnostics, queryReadModel, reconcile };
}

module.exports = {
  buildUnifiedReadModel,
  createAgentCorrelation,
  DEFAULT_CORRELATION_WINDOW_MS,
  DEFAULT_RECONCILE_LIMIT,
  intervalDeltaMs,
};
