'use strict';

const DEFAULT_MAX_APPLICATIONS = 8;
const MAX_PAGE_ROWS = 1_000;
const CORRELATION_WINDOW_MS = 90_000;

function identityKey(row) {
  return `${row.agentId}\u0000${row.bundleId || row.processName}`;
}

function addDecimalBytes(current, value) {
  return value == null ? current : current + BigInt(value);
}

function byteCompleteness(application) {
  const known = application.bytesInObservationCount + application.bytesOutObservationCount;
  if (known === 0) return 'unavailable';
  return application.bytesInObservationCount === application.byteObservationCount
    && application.bytesOutObservationCount === application.byteObservationCount
    ? 'complete'
    : 'partial';
}

function createAgentAttribution({ getDb, maxApplications = DEFAULT_MAX_APPLICATIONS } = {}) {
  if (typeof getDb !== 'function') throw new TypeError('getDb is required');
  if (!Number.isInteger(maxApplications) || maxApplications < 1) {
    throw new TypeError('maxApplications must be a positive integer');
  }

  function attach(rows, { sourceScope = null, from = null, to = null } = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return rows || [];
    if (rows.length > MAX_PAGE_ROWS) {
      throw new RangeError(`Agent attribution is limited to ${MAX_PAGE_ROWS} connection rows`);
    }

    // The window each row is judged against, shared by both branches.
    const windowFor = row => [
      Math.max(row.firstSeen || 0, Number.isFinite(from) ? from : 0),
      Math.min(
        row.lastSeen || Number.MAX_SAFE_INTEGER,
        Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER
      ),
    ];

    const values = [];
    const params = [];
    // Rows no router observed. They go in a CTE of their own -- see below.
    const agentOnlyValues = [];
    const agentOnlyParams = [];
    rows.forEach((row, rowIndex) => {
      const [windowStart, windowEnd] = windowFor(row);
      const proto = String(row.proto || '').toUpperCase();
      values.push('(?, ?, ?, ?, ?, ?, ?)');
      params.push(rowIndex, row.src, row.dst, row.dport, proto, windowStart, windowEnd);
      if (Array.isArray(row.observedBy) && row.observedBy.length === 0) {
        agentOnlyValues.push('(?, ?, ?, ?, ?, ?, ?)');
        agentOnlyParams.push(rowIndex, row.src, row.dst, row.dport, proto, windowStart, windowEnd);
      }
    });

    const agentFilter = sourceScope?.sourceKind === 'agent' ? 'AND o.agentId = ?' : '';
    const agentParams = sourceScope?.sourceKind === 'agent' ? [sourceScope.sourceId] : [];

    // The agent-only rows used to ride along in the same CTE, selected by an
    // `r.agentOnly = 1` condition inside the join. SQLite answered that by
    // scanning agent_observations -- all 1,536,341 rows on the Hub this was
    // measured against -- and only then checking which of the 200 constant rows
    // qualified. It spent 3,759 ms per page to return nothing at all, because
    // on a typical page nothing is agent-only, and 31,461 ms when everything
    // was. An index hint did not move it; the planner has to be given rows it
    // can drive from.
    //
    // Passing only the qualifying rows does that: 4 of 200 answered in 0.5 ms,
    // all 200 in 107 ms, and a page with none skips the branch entirely.
    const agentOnlyBranch = agentOnlyValues.length ? `
        UNION ALL

        SELECT r.rowIndex, o.agentId, a.hostName AS agentHost,
          o.processId, o.processName, o.bundleId,
          o.firstObservedAt, o.lastObservedAt, o.bytesIn, o.bytesOut,
          'agent-only' AS matchKind
        FROM agentOnlyRows r
        JOIN agent_observations o
          ON o.localAddress = r.src AND o.remoteAddress = r.dst
            AND o.remotePort = r.dport AND o.networkProtocol = LOWER(r.proto)
            AND o.lastObservedAt >= r.firstSeen - ${CORRELATION_WINDOW_MS}
            AND o.firstObservedAt <= r.lastSeen + ${CORRELATION_WINDOW_MS}
        JOIN agents a ON a.agentId = o.agentId
        WHERE NOT EXISTS (
          SELECT 1 FROM connection_agent_observations link
          WHERE link.agentId = o.agentId AND link.observationId = o.observationId
        ) ${agentFilter}` : '';

    const agentOnlyCte = agentOnlyValues.length ? `,
      agentOnlyRows(rowIndex, src, dst, dport, proto, firstSeen, lastSeen) AS (
        VALUES ${agentOnlyValues.join(', ')}
      )` : '';

    const sql = `
      WITH requested(rowIndex, src, dst, dport, proto, firstSeen, lastSeen) AS (
        VALUES ${values.join(', ')}
      )${agentOnlyCte}, attributions AS (
        SELECT r.rowIndex, o.agentId, a.hostName AS agentHost,
          o.processId, o.processName, o.bundleId,
          o.firstObservedAt, o.lastObservedAt, o.bytesIn, o.bytesOut,
          link.matchKind
        FROM requested r
        -- Forced, because the planner gets this backwards as soon as the caller
        -- scopes to one agent. With an equality on o.agentId present it prefers
        -- entering through link's (agentId, observationId) index -- selecting every
        -- correlation that agent ever had, 1.46M rows on the Hub -- and then
        -- rescans these 200 constant rows for each one. The join it should do is
        -- the other way round: 200 flows, each looked up by its own address
        -- tuple. Measured on production data: 34,651ms without this hint, 15ms
        -- with it, same 475 rows out. The tuple index exists for exactly this
        -- lookup, so naming it costs nothing when the plan was already right.
        JOIN connection_agent_observations AS link
          INDEXED BY idx_connection_agent_connection
          ON link.src = r.src AND link.dst = r.dst
            AND link.dport = r.dport AND link.proto = r.proto
        JOIN agent_observations o
          ON o.agentId = link.agentId AND o.observationId = link.observationId
        JOIN agents a ON a.agentId = o.agentId
        WHERE o.lastObservedAt >= r.firstSeen - ${CORRELATION_WINDOW_MS}
          AND o.firstObservedAt <= r.lastSeen + ${CORRELATION_WINDOW_MS}
          ${agentFilter}${agentOnlyBranch}
      )
      SELECT * FROM attributions ORDER BY rowIndex, lastObservedAt DESC
    `;
    const bindings = agentOnlyValues.length
      ? [...params, ...agentOnlyParams, ...agentParams, ...agentParams]
      : [...params, ...agentParams];
    const found = getDb().prepare(sql).all(...bindings);
    const byRow = new Map();
    for (const attribution of found) {
      let identities = byRow.get(attribution.rowIndex);
      if (!identities) {
        identities = new Map();
        byRow.set(attribution.rowIndex, identities);
      }
      const key = identityKey(attribution);
      const existing = identities.get(key);
      if (!existing) {
        identities.set(key, {
          agentId: attribution.agentId,
          agentHost: attribution.agentHost,
          processName: attribution.processName,
          bundleId: attribution.bundleId,
          processIds: [attribution.processId],
          firstObservedAt: attribution.firstObservedAt,
          lastObservedAt: attribution.lastObservedAt,
          matchKind: attribution.matchKind,
          byteObservationCount: 1,
          bytesInObservationCount: attribution.bytesIn == null ? 0 : 1,
          bytesOutObservationCount: attribution.bytesOut == null ? 0 : 1,
          bytesInValue: addDecimalBytes(0n, attribution.bytesIn),
          bytesOutValue: addDecimalBytes(0n, attribution.bytesOut),
        });
        continue;
      }
      if (!existing.processIds.includes(attribution.processId)) existing.processIds.push(attribution.processId);
      existing.firstObservedAt = Math.min(existing.firstObservedAt, attribution.firstObservedAt);
      existing.lastObservedAt = Math.max(existing.lastObservedAt, attribution.lastObservedAt);
      if (existing.matchKind !== 'exact-5tuple') existing.matchKind = attribution.matchKind;
      existing.byteObservationCount++;
      if (attribution.bytesIn != null) existing.bytesInObservationCount++;
      if (attribution.bytesOut != null) existing.bytesOutObservationCount++;
      existing.bytesInValue = addDecimalBytes(existing.bytesInValue, attribution.bytesIn);
      existing.bytesOutValue = addDecimalBytes(existing.bytesOutValue, attribution.bytesOut);
    }

    return rows.map((row, rowIndex) => {
      const applications = [...(byRow.get(rowIndex)?.values() || [])]
        .sort((left, right) => right.lastObservedAt - left.lastObservedAt)
        .map(application => ({
          agentId: application.agentId,
          agentHost: application.agentHost,
          processName: application.processName,
          bundleId: application.bundleId,
          processIds: application.processIds,
          firstObservedAt: application.firstObservedAt,
          lastObservedAt: application.lastObservedAt,
          matchKind: application.matchKind,
          bytesIn: application.bytesInObservationCount > 0
            ? application.bytesInValue.toString()
            : null,
          bytesOut: application.bytesOutObservationCount > 0
            ? application.bytesOutValue.toString()
            : null,
          byteObservationCount: application.byteObservationCount,
          byteCompleteness: byteCompleteness(application),
        }));
      return {
        ...row,
        applications: applications.slice(0, maxApplications),
        applicationCount: applications.length,
        omittedApplicationCount: Math.max(0, applications.length - maxApplications),
      };
    });
  }

  return { attach };
}

module.exports = {
  CORRELATION_WINDOW_MS,
  DEFAULT_MAX_APPLICATIONS,
  MAX_PAGE_ROWS,
  createAgentAttribution,
};
