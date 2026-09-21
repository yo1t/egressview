// Read/query side of connection history. The caller retains DB ownership.
'use strict';

const { BUCKET_MS: FOLDED_WINDOW_MS } = require('./connection-buckets');

const SORT_COL_SQL = {
  lastSeen: 'lastSeen',
  src: 'src',
  dst: 'dstHost, dst',
  dport: 'dport',
  proto: 'proto',
  country: 'country',
  org: 'org',
};

function escapeLikeValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function makeLikePat(mode, value) {
  const escaped = escapeLikeValue(value);
  if (mode === 'startsWith') return escaped + '%';
  if (mode === 'endsWith') return '%' + escaped;
  return '%' + escaped + '%';
}

function buildFilterConditions(filters) {
  const conditions = [];
  const params = [];
  if (filters.src?.value) {
    if (filters.src.mode === 'exact') {
      conditions.push('src = ?');
      params.push(filters.src.value);
    } else {
      const pattern = makeLikePat(filters.src.mode, filters.src.value);
      conditions.push("(src LIKE ? ESCAPE '\\' OR srcDnsName LIKE ? ESCAPE '\\' OR srcMdnsName LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
  }
  for (const column of ['dst', 'dport', 'proto', 'country', 'org']) {
    if (!filters[column]?.value) continue;
    const pattern = makeLikePat(filters[column].mode, filters[column].value);
    if (column === 'dst') conditions.push("(dst LIKE ? ESCAPE '\\' OR dstHost LIKE ? ESCAPE '\\')");
    else if (column === 'dport') conditions.push("CAST(dport AS TEXT) LIKE ? ESCAPE '\\'");
    else conditions.push(`${column} LIKE ? ESCAPE '\\'`);
    params.push(pattern);
    if (column === 'dst') params.push(pattern);
  }
  if (filters.srcMac?.value) {
    conditions.push('srcMac = ?');
    params.push(filters.srcMac.value);
  }
  return { conditions, params };
}

function sourceScopeCondition(scope, alias = 'connections') {
  if (!scope) return { condition: null, params: [] };
  if (scope.sourceKind === 'router') {
    return {
      condition: `EXISTS (
        SELECT 1 FROM connection_observations scoped_o
        WHERE scoped_o.src = ${alias}.src AND scoped_o.dst = ${alias}.dst
          AND scoped_o.dport = ${alias}.dport AND scoped_o.proto = ${alias}.proto
          AND scoped_o.routerId = ?
      )`,
      params: [scope.sourceId],
    };
  }
  if (scope.sourceKind === 'agent') return { condition: null, params: [] };
  throw new TypeError('Unsupported source scope');
}

// `connection_buckets` arrives with schema 25. A Hub that has not migrated yet
// still has to draw something, so its absence is a fact to check rather than
// an error to throw.
//
// Asked every time on purpose. The answer was cached in a module variable
// first, which is wrong the moment the process opens a different database --
// a restore from backup does exactly that, and so does every test after the
// first. One lookup in sqlite_master beside the eight queries this summary
// already runs is not the thing to save.
function hasConnectionBuckets(db) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connection_buckets'"
  ).get();
}

// Where the record begins, and where it begins covering everything.
//
// Before `routerFrom` only the Agents' own observations exist -- they carry
// their times, so they can be counted for the past, while router-observed
// flows cannot. A line drawn there is the traffic the Agents saw, not
// everything that left the network, and the screen has to say so.
function connectionBucketCoverage(db) {
  try {
    const row = db.prepare(`
      SELECT MIN(bucketStart) AS oldest,
             MIN(CASE WHEN source = 'router' THEN bucketStart END) AS oldestRouter
      FROM connection_buckets
    `).get();
    return { from: row?.oldest ?? null, routerFrom: row?.oldestRouter ?? null };
  } catch {
    return { from: null, routerFrom: null };
  }
}

function connectionSource(scope, alias = 'c', { from = null, to = null } = {}) {
  if (scope?.sourceKind !== 'agent') {
    return { cte: '', from: `connections ${alias}`, params: [] };
  }
  // Bound Agent-only rows before GROUP BY so short views use the time index
  // instead of rebuilding the Agent's complete retained history per query.
  const observationRange = [];
  const observationRangeParams = [];
  if (from != null) {
    observationRange.push('o.lastObservedAt >= ?');
    observationRangeParams.push(from);
  }
  if (to != null) {
    observationRange.push('o.lastObservedAt <= ?');
    observationRangeParams.push(to);
  }
  const observationRangeSql = observationRange.length
    ? ` AND ${observationRange.join(' AND ')}`
    : '';
  return {
    cte: `WITH scoped_connections AS (
      SELECT c.*
      FROM connections c
      WHERE EXISTS (
        SELECT 1 FROM connection_agent_observations scoped_a
        WHERE scoped_a.src = c.src AND scoped_a.dst = c.dst
          AND scoped_a.dport = c.dport AND scoped_a.proto = c.proto
          AND scoped_a.agentId = ?
      )
      UNION ALL
      SELECT
        o.localAddress AS src, o.remoteAddress AS dst, o.remotePort AS dport,
        LOWER(o.networkProtocol) AS proto, NULLIF(o.localPort, 0) AS sport,
        NULL AS ttl, NULL AS srcMac, NULL AS srcVendor,
        NULL AS srcDnsName, NULL AS srcMdnsName, MAX(ac.dstHost) AS dstHost,
        MAX(ac.country) AS country, MAX(ac.org) AS org,
        MAX(ac.lat) AS lat, MAX(ac.lon) AS lon, MAX(ac.city) AS city,
        MIN(o.firstObservedAt) AS firstSeen, MAX(o.lastObservedAt) AS lastSeen,
        MAX(a.hostName) AS agentHost, MAX(o.processName) AS process,
        MAX(o.processId) AS pid
      FROM agent_observations o
      JOIN agents a ON a.agentId = o.agentId
      LEFT JOIN connections ac
        ON ac.src = o.localAddress AND ac.dst = o.remoteAddress
          AND ac.dport = o.remotePort AND ac.proto = UPPER(o.networkProtocol)
      WHERE o.agentId = ?
        ${observationRangeSql}
        AND NOT EXISTS (
          SELECT 1 FROM connection_agent_observations link
          WHERE link.agentId = o.agentId AND link.observationId = o.observationId
        )
      GROUP BY o.localAddress, o.remoteAddress, o.remotePort, LOWER(o.networkProtocol)
    )`,
    from: `scoped_connections ${alias}`,
    params: [scope.sourceId, scope.sourceId, ...observationRangeParams],
  };
}

// The browser never sends an upper bound: every rolling range is `from = now -
// N` with `to` left null. That makes the time filter one-sided, and SQLite
// then drops the time index and drives from whichever index serves the GROUP
// BY instead -- scanning the whole table to answer a question about the last
// hour.
//
// Measured on the production Hub 2026-09-20, a one-hour summary:
//
//   SCAN connections USING INDEX idx_dst              746.1 ms
//   SEARCH connections USING INDEX idx_lastSeen        19.0 ms
//
// and the cost did not move with the range -- 750 ms for an hour, 765 ms for a
// day -- which is what "not filtering by time" looks like from outside.
//
// The bound below cannot exclude a row: no lastSeen can exceed the largest
// integer JavaScript can represent, and the row counts are identical with and
// without it. It exists only so the planner sees a range it can search.
const OPEN_ENDED_LAST_SEEN = Number.MAX_SAFE_INTEGER;

/**
 * The time conditions for a query, always two-sided when there is a lower
 * bound. Same rows as before; a plan that can use the time index.
 */
function timeRangeConditions(from, to) {
  const conditions = [];
  const params = [];
  if (from != null) {
    conditions.push('lastSeen >= ?');
    params.push(from);
    conditions.push('lastSeen <= ?');
    params.push(to != null ? to : OPEN_ENDED_LAST_SEEN);
  } else if (to != null) {
    conditions.push('lastSeen <= ?');
    params.push(to);
  }
  return { conditions, params };
}

function buildWhereAndParams(from, to, filterConditions, sourceScope = null, alias = 'connections') {
  const conditions = [];
  const params = [];
  const timeRange = timeRangeConditions(from, to);
  conditions.push(...timeRange.conditions);
  params.push(...timeRange.params);
  conditions.push(...filterConditions.conditions);
  params.push(...filterConditions.params);
  const scoped = sourceScopeCondition(sourceScope, alias);
  if (scoped.condition) conditions.push(scoped.condition);
  params.push(...scoped.params);
  return {
    where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

function createHistoryQueries({
  getDb,
  getDbPath,
  Database,
  connectionReadColumns,
  hydrateConnectionRows,
  normalizeObservedBy,
  compatibilitySource,
  summarizeAppGroups,
  onSummaryTiming = null,
}) {
  function queryByTimeRange(from, to, { sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return [];
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] }, sourceScope, 'c');
    const source = connectionSource(sourceScope, 'c', { from, to });
    return hydrateConnectionRows(db.prepare(
      `${source.cte} SELECT ${connectionReadColumns('c')} FROM ${source.from}${where} ORDER BY c.lastSeen DESC`
    ).all(...source.params, ...params));
  }

  function queryByTimeRangePaged(from, to, limit, offset, { sort = 'lastSeen', sortDir = 'desc', filters = {}, sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return [];
    const sortSql = SORT_COL_SQL[sort] || 'lastSeen';
    const direction = sortDir === 'asc' ? 'ASC' : 'DESC';
    const { where, params } = buildWhereAndParams(from, to, buildFilterConditions(filters), sourceScope, 'c');
    const orderClause = sortSql.split(',').map(column => `${column.trim()} ${direction}`).join(', ');
    const source = connectionSource(sourceScope, 'c', { from, to });
    const sql = `${source.cte} SELECT ${connectionReadColumns('c')} FROM ${source.from}${where} ORDER BY ${orderClause}`;
    if (limit == null) return hydrateConnectionRows(db.prepare(sql).all(...source.params, ...params));
    return hydrateConnectionRows(db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...source.params, ...params, limit, offset));
  }

  function countByTimeRange(from, to, { filters = {}, sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return 0;
    const { where, params } = buildWhereAndParams(from, to, buildFilterConditions(filters), sourceScope, 'c');
    const source = connectionSource(sourceScope, 'c', { from, to });
    return db.prepare(`${source.cte} SELECT COUNT(*) AS cnt FROM ${source.from}${where}`)
      .get(...source.params, ...params)?.cnt || 0;
  }

  function countFactsByTimeRange(from, to, { sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return { connections: 0, devices: 0, destinations: 0 };
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] }, sourceScope, 'c');
    const source = connectionSource(sourceScope, 'c', { from, to });
    const row = db.prepare(`${source.cte}
      SELECT COUNT(*) AS connections,
             COUNT(DISTINCT COALESCE(NULLIF(srcMac, ''), src)) AS devices,
             COUNT(DISTINCT dst) AS destinations
      FROM ${source.from}${where}
    `).get(...source.params, ...params) || {};
    return {
      connections: row.connections || 0,
      devices: row.devices || 0,
      destinations: row.destinations || 0,
    };
  }

  function createConnectionExportReader(from, to, { sourceScope = null } = {}) {
    const db = getDb();
    const dbPath = getDbPath();
    if (!db || dbPath === ':memory:') {
      return {
        countByTimeRange: () => countByTimeRange(from, to, { sourceScope }),
        queryByTimeRangePaged: (_from, _to, limit, offset, opts) =>
          queryByTimeRangePaged(from, to, limit, offset, { ...opts, sourceScope }),
        close() {},
      };
    }

    const snapshotDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      snapshotDb.pragma('query_only = ON');
      snapshotDb.exec('BEGIN');
      const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] }, sourceScope, 'c');
      const source = connectionSource(sourceScope, 'c', { from, to });
      const count = snapshotDb.prepare(`${source.cte} SELECT COUNT(*) AS cnt FROM ${source.from}${where}`)
        .get(...source.params, ...params)?.cnt || 0;
      const pageStatement = snapshotDb.prepare(
        `${source.cte} SELECT ${connectionReadColumns('c')} FROM ${source.from}${where}
         ORDER BY c.lastSeen DESC LIMIT ? OFFSET ?`
      );
      let closed = false;
      return {
        countByTimeRange: () => count,
        queryByTimeRangePaged: (_from, _to, limit, offset) =>
          hydrateConnectionRows(pageStatement.all(...source.params, ...params, limit, offset)),
        close() {
          if (closed) return;
          closed = true;
          try { snapshotDb.exec('ROLLBACK'); } catch {}
          try { snapshotDb.close(); } catch {}
        },
      };
    } catch (error) {
      try { snapshotDb.exec('ROLLBACK'); } catch {}
      try { snapshotDb.close(); } catch {}
      throw error;
    }
  }

  /**
   * Destinations only an Agent saw, which no unscoped query reaches.
   *
   * `connectionSource()` unions Agent observations in only when a caller asks
   * for one Agent by id. Everything unscoped reads `connections` alone -- and
   * threat notification is unscoped, so the one path by which a person learns
   * a destination matched a feed has never looked at Agent-only traffic.
   *
   * Measured on the Hub 2026-08-26: 229,826 of 408,301 observations had no
   * correlated `connections` row, on a Hub that has a router. With no router
   * it is all of them.
   *
   * Bounded by time, like the scoped union beside it: this is asked on a
   * schedule over a recent window, not over the whole retained history.
   */
  function groupAgentOnlyDstByTimeRange(from, to) {
    const db = getDb();
    if (!db) return [];
    // No `dstHost`: the Agent keeps destination names on the Mac and never
    // sends one (P3-14, fixed by a test). The Hub can match these by address
    // only, and saying so here is better than a column that is always null.
    return db.prepare(`
      SELECT o.remoteAddress AS dst, COUNT(*) AS cnt
      FROM agents a
      CROSS JOIN agent_observations AS o INDEXED BY idx_agent_observations_time
      WHERE o.agentId = a.agentId
        AND o.lastObservedAt >= ? AND o.lastObservedAt <= ?
        AND NOT EXISTS (
          SELECT 1 FROM connection_agent_observations link
          WHERE link.agentId = o.agentId AND link.observationId = o.observationId
        )
      GROUP BY o.remoteAddress
    `).all(from, to).map((row) => ({ ...row, dstHost: null }));
  }

  function groupDstByTimeRange(from, to, { filters = {}, sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return [];
    const { where, params } = buildWhereAndParams(from, to, buildFilterConditions(filters), sourceScope, 'c');
    const source = connectionSource(sourceScope, 'c', { from, to });
    return db.prepare(
      `${source.cte} SELECT dst, MAX(dstHost) AS dstHost, COUNT(*) AS cnt FROM ${source.from}${where} GROUP BY dst`
    ).all(...source.params, ...params);
  }

  function groupServiceByTimeRange(from, to, { sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return [];
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] }, sourceScope, 'c');
    const source = connectionSource(sourceScope, 'c', { from, to });
    return db.prepare(
      `${source.cte} SELECT dport, proto, COUNT(*) AS count FROM ${source.from}${where}
       GROUP BY dport, proto ORDER BY count DESC LIMIT 20`
    ).all(...source.params, ...params);
  }

  // Which source devices contacted a given (small) set of destination IPs.
  // Used by the AI context to link devices to threat destinations. Bounded by
  // both the destination list size and a hard row cap so it never scans wide.
  function groupSrcForDstsByTimeRange(from, to, dsts, { sourceScope = null } = {}) {
    const db = getDb();
    if (!db || !Array.isArray(dsts) || dsts.length === 0) return [];
    const capped = dsts.slice(0, 50);
    const placeholders = capped.map(() => '?').join(',');
    const conditions = [];
    const params = [];
    const timeRange = timeRangeConditions(from, to);
    conditions.push(...timeRange.conditions);
    params.push(...timeRange.params);
    conditions.push(`dst IN (${placeholders})`);
    params.push(...capped);
    const scoped = sourceScopeCondition(sourceScope, 'c');
    if (scoped.condition) conditions.push(scoped.condition);
    params.push(...scoped.params);
    const where = ' WHERE ' + conditions.join(' AND ');
    const source = connectionSource(sourceScope, 'c', { from, to });
    return db.prepare(
      `${source.cte} SELECT dst, src,
              MAX(srcDnsName) AS srcDnsName,
              MAX(srcMdnsName) AS srcMdnsName,
              MAX(srcMac) AS srcMac,
              COUNT(*) AS cnt
       FROM ${source.from}${where}
       GROUP BY dst, src ORDER BY cnt DESC LIMIT 200`
    ).all(...source.params, ...params);
  }

  // Bounded source-device summary for AI context. Keep this separate from the
  // full graph summary so a manual AI request does not run its heavier queries.
  function groupSrcByTimeRange(from, to, limit = 30, { sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return [];
    const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] }, sourceScope, 'c');
    const source = connectionSource(sourceScope, 'c', { from, to });
    return db.prepare(
      `${source.cte} SELECT src,
              MAX(srcMac) AS srcMac,
              MAX(srcVendor) AS srcVendor,
              MAX(srcDnsName) AS srcDnsName,
              MAX(srcMdnsName) AS srcMdnsName,
              COUNT(*) AS count,
              MIN(firstSeen) AS firstSeen,
              MAX(lastSeen) AS lastSeen
       FROM ${source.from}${where}
       GROUP BY src ORDER BY count DESC LIMIT ?`
    ).all(...source.params, ...params, cappedLimit);
  }

  function listSourceDeviceKeys(sourceScope) {
    const db = getDb();
    if (!db || !sourceScope) return [];
    // The device list wants two columns: which addresses this source has seen,
    // and the MAC if a router also saw the flow. Asking connectionSource() for
    // them made an Agent scope rebuild the Agent's entire retained history --
    // the UNION branch synthesises a connection row per uncorrelated flow,
    // with six aggregates and a LEFT JOIN over 1.3 million observations -- and
    // it cannot use the time index, because this question has no time range.
    //
    // Measured on the production Hub 2026-09-20: 10,123 ms, for 32 pairs.
    // GET /api/devices runs it whenever the scope changes, and better-sqlite3
    // is synchronous, so choosing an Agent froze the Hub for everyone. Asked
    // directly, the same 32 pairs come back in 517 ms.
    if (sourceScope.sourceKind === 'agent') {
      return db.prepare(`
        SELECT DISTINCT c.src, c.srcMac
        FROM connections c
        WHERE EXISTS (
          SELECT 1 FROM connection_agent_observations link
          WHERE link.src = c.src AND link.dst = c.dst
            AND link.dport = c.dport AND link.proto = c.proto
            AND link.agentId = ?
        )
        UNION
        -- Flows only the Agent saw. No router observed them, so no MAC, which
        -- is what the synthesised rows carried for these anyway.
        SELECT DISTINCT o.localAddress AS src, NULL AS srcMac
        FROM agent_observations o
        WHERE o.agentId = ?
      `).all(sourceScope.sourceId, sourceScope.sourceId);
    }
    const source = connectionSource(sourceScope);
    const scoped = sourceScopeCondition(sourceScope, 'c');
    const where = scoped.condition ? ` WHERE ${scoped.condition}` : '';
    return db.prepare(
      `${source.cte} SELECT DISTINCT c.src, c.srcMac FROM ${source.from}${where}`
    ).all(...source.params, ...scoped.params);
  }

  function summarizeByTimeRange(from, to, { src = null, buckets = 60, sourceScope = null, timelineSource = 'observed' } = {}) {
    const startedAt = process.hrtime.bigint();
    const timings = {};
    const timed = (name, operation) => {
      const start = process.hrtime.bigint();
      const result = operation();
      timings[name] = Number(process.hrtime.bigint() - start) / 1e6;
      return result;
    };
    const db = getDb();
    if (!db) return { byDst: [], byDevice: [] };
    const source = connectionSource(sourceScope, 'connections', { from, to });
    const conditions = [];
    const params = [];
    const timeRange = timeRangeConditions(from, to);
    conditions.push(...timeRange.conditions);
    params.push(...timeRange.params);
    if (src != null) { conditions.push('src = ?'); params.push(src); }
    const scoped = sourceScopeCondition(sourceScope, 'connections');
    if (scoped.condition) conditions.push(scoped.condition);
    params.push(...scoped.params);
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const targetExpr = "COALESCE(NULLIF(org, ''), NULLIF(dstHost, ''), dst)";
    const countRow = timed('range', () => db.prepare(
      `${source.cte} SELECT COUNT(*) AS total, MIN(lastSeen) AS minLastSeen, MAX(lastSeen) AS maxLastSeen
       FROM ${source.from}${where}`
    ).get(...source.params, ...params) || {});
    const total = countRow.total || 0;
    const rangeFrom = from ?? countRow.minLastSeen ?? Date.now();
    const rangeTo = to ?? countRow.maxLastSeen ?? Date.now();
    // Drawn from the folded windows when nothing narrows the question -- see
    // the timeline query below for why the scoped path cannot use them.
    const useBuckets = timelineSource !== 'lastSeen'
      && !sourceScope && src == null && hasConnectionBuckets(db);

    // The chart covers what the record covers, which is not always what was
    // asked for.
    //
    // It ends at the last window that closed: the one in progress is still
    // collecting, and drawn anyway it is a bar at nearly nothing on the
    // right-hand edge of every chart, which reads as traffic having just
    // stopped. A five-minute view asks for a period shorter than one window,
    // so it is widened to that window rather than left empty.
    //
    // It starts where the record starts. Asked for fourteen days with seven
    // days recorded, drawing the whole period put 29 empty bars of 60 on the
    // left -- a flat line at zero for half the chart, which says there was no
    // traffic rather than that nobody was looking. The screen says what is
    // missing in words instead, and the bars show the part that was measured.
    const lastClosedWindow = Math.floor(Date.now() / FOLDED_WINDOW_MS) * FOLDED_WINDOW_MS - FOLDED_WINDOW_MS;
    const oldestRecorded = useBuckets ? connectionBucketCoverage(db).from : null;
    const timelineTo = useBuckets ? Math.min(rangeTo, lastClosedWindow) : rangeTo;
    const timelineFrom = useBuckets
      ? Math.min(Math.max(rangeFrom, oldestRecorded ?? rangeFrom), timelineTo)
      : rangeFrom;

    let bucketCount = Math.max(1, Math.min(240, Number(buckets) || 60));
    let bucketMs = Math.max(1, (Math.max(timelineTo, timelineFrom + 1) - timelineFrom) / bucketCount);

    // Never finer than the record. Traffic is folded into five-minute windows,
    // so asking for a two-and-a-half-minute bar means every second bar has
    // nothing to hold -- measured on a Hub, 31 of 60 bars came back empty and
    // the chart drew a row of spikes with zero between each pair. The values
    // were right; the shape was a lie about when traffic stopped.
    //
    // Always a whole number of windows, at every zoom. A bar that is not one
    // holds four windows sometimes and five others: measured over a day, that
    // alone swung neighbouring bars between 7,270 and 11,130 with no change in
    // traffic. The ripple is the bar width beating against the window width,
    // and it reads exactly like a rhythm in the network.
    if (useBuckets) {
      bucketMs = Math.max(FOLDED_WINDOW_MS, Math.ceil(bucketMs / FOLDED_WINDOW_MS) * FOLDED_WINDOW_MS);
      // One bar per window, inclusive of the newest: `rangeTo` is a window's
      // start, and that window occupies a whole bar of its own.
      bucketCount = Math.max(1,
        Math.floor((Math.max(timelineTo, timelineFrom) - timelineFrom) / bucketMs) + 1);
    }

    const byDst = timed('destinations', () => db.prepare(
      `${source.cte} SELECT dst, dstHost, country, org,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM ${source.from}${where}
       GROUP BY dst ORDER BY count DESC LIMIT 500`
    ).all(...source.params, ...params));
    const byDevice = timed('devices', () => db.prepare(
      `${source.cte} SELECT src, MAX(srcMac) AS srcMac, MAX(srcVendor) AS srcVendor,
              MAX(srcDnsName) AS srcDnsName, MAX(srcMdnsName) AS srcMdnsName,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM ${source.from}${where}
       GROUP BY src ORDER BY count DESC LIMIT 200`
    ).all(...source.params, ...params));
    const deviceObservations = timed('observations', () => db.prepare(`
      ${source.cte}${source.cte ? ',' : 'WITH'} filtered_connections AS (SELECT * FROM ${source.from}${where})
      SELECT c.src, GROUP_CONCAT(DISTINCT o.routerId) AS observedByCsv
      FROM filtered_connections c
      JOIN connection_observations o
        ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      GROUP BY c.src
    `).all(...source.params, ...params));
    const observationsByDevice = new Map(deviceObservations.map(row => [row.src, normalizeObservedBy(row.observedByCsv)]));
    for (const row of byDevice) {
      row.observedBy = observationsByDevice.get(row.src) || [];
      row.sources = compatibilitySource(row.observedBy);
    }
    const byTarget = timed('targets', () => db.prepare(
      `${source.cte} SELECT ${targetExpr} AS key, ${targetExpr} AS label,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM ${source.from}${where}
       GROUP BY key ORDER BY count DESC LIMIT 1000`
    ).all(...source.params, ...params));
    const byEdge = timed('edges', () => db.prepare(
      `${source.cte} SELECT src, ${targetExpr} AS key,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM ${source.from}${where}
       GROUP BY src, key ORDER BY count DESC LIMIT 3000`
    ).all(...source.params, ...params));
    const locationLimit = 500;
    const locationFilter = `${where}${where ? ' AND' : ' WHERE'} lat IS NOT NULL AND lon IS NOT NULL`;
    const byLocation = timed('locations', () => db.prepare(
      `${source.cte} SELECT ${targetExpr} AS key, ${targetExpr} AS org,
              country, city, lat, lon,
              COUNT(*) AS totalSessions, COUNT(DISTINCT src) AS srcCount,
              MAX(ttl) AS maxTtl, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen,
              COUNT(*) OVER () AS totalGroups,
              SUM(COUNT(*)) OVER () AS allLocationSessions
       FROM ${source.from}${locationFilter}
       GROUP BY key, lat, lon ORDER BY totalSessions DESC LIMIT ?`
    ).all(...source.params, ...params, locationLimit));
    const locationTotalSessions = byLocation[0]?.allLocationSessions || 0;
    const locationShownSessions = byLocation.reduce((sum, row) => sum + (row.totalSessions || 0), 0);
    const locationTotalGroups = byLocation[0]?.totalGroups || 0;
    for (const row of byLocation) {
      delete row.totalGroups;
      delete row.allLocationSessions;
    }
    const appRows = timed('applications', () => {
      const hourFrom = Math.floor(rangeFrom / 3_600_000) * 3_600_000;
      const hourTo = Math.floor(rangeTo / 3_600_000) * 3_600_000;
      if (sourceScope?.sourceKind === 'router') {
        return db.prepare(`
          ${source.cte}${source.cte ? ',' : 'WITH'} filtered_connections AS (
            SELECT src, dst, dport, proto, dstHost
            FROM ${source.from}${where}
          ), identified_apps AS (
            SELECT fc.src, fc.dst, fc.dport, UPPER(fc.proto) AS proto,
              o.agentId, COALESCE(NULLIF(o.bundleId, ''), o.processName) AS appIdentity,
              MAX(o.processName) AS app
            FROM filtered_connections fc
            JOIN connection_agent_observations link
              ON link.src = fc.src AND link.dst = fc.dst
                AND link.dport = fc.dport AND link.proto = UPPER(fc.proto)
            JOIN agent_observations o
              ON o.agentId = link.agentId AND o.observationId = link.observationId
            WHERE o.lastObservedAt >= ? AND o.firstObservedAt <= ?
            GROUP BY fc.src, fc.dst, fc.dport, UPPER(fc.proto),
              o.agentId, COALESCE(NULLIF(o.bundleId, ''), o.processName)
          ), identified_connections AS (
            SELECT src, dst, dport, proto FROM identified_apps
            GROUP BY src, dst, dport, proto
          ), app_groups AS (
            SELECT app, 'agent' AS attribution,
              NULL AS dport, NULL AS proto, NULL AS dstHost, COUNT(*) AS count
            FROM identified_apps GROUP BY app
            UNION ALL
            SELECT NULL, 'inferred', fc.dport, fc.proto,
              COALESCE(NULLIF(fc.dstHost, ''), fc.dst), COUNT(*)
            FROM filtered_connections fc
            LEFT JOIN identified_connections ia
              ON ia.src = fc.src AND ia.dst = fc.dst
                AND ia.dport = fc.dport AND ia.proto = UPPER(fc.proto)
            WHERE ia.src IS NULL
            GROUP BY fc.dport, fc.proto, COALESCE(NULLIF(fc.dstHost, ''), fc.dst)
          ) SELECT * FROM app_groups ORDER BY count DESC
        `).all(...source.params, ...params, rangeFrom, rangeTo);
      }

      const rollupFilters = [
        'h.hourStart >= ?', 'h.hourStart <= ?',
        'h.lastObservedAt >= ?', 'h.firstObservedAt <= ?',
      ];
      const rollupParams = [hourFrom, hourTo, rangeFrom, rangeTo];
      if (sourceScope?.sourceKind === 'agent') {
        rollupFilters.push('h.agentId = ?');
        rollupParams.push(sourceScope.sourceId);
      }
      if (src != null) {
        rollupFilters.push('h.localAddress = ?');
        rollupParams.push(src);
      }
      const fallback = sourceScope?.sourceKind === 'agent' ? '' : `
        UNION ALL
        SELECT NULL, 'inferred', fc.dport, fc.proto,
          COALESCE(NULLIF(fc.dstHost, ''), fc.dst), COUNT(*)
        FROM filtered_connections fc
        LEFT JOIN identified_connections ia
          ON ia.src = fc.src AND ia.dst = fc.dst
            AND ia.dport = fc.dport AND ia.proto = UPPER(fc.proto)
        WHERE ia.src IS NULL
        GROUP BY fc.dport, fc.proto, COALESCE(NULLIF(fc.dstHost, ''), fc.dst)`;
      const filteredCte = sourceScope?.sourceKind === 'agent' ? '' : `
        filtered_connections AS (
          SELECT src, dst, dport, proto, dstHost FROM ${source.from}${where}
        ),`;
      const prefix = sourceScope?.sourceKind === 'agent' ? 'WITH' : `${source.cte}${source.cte ? ',' : 'WITH'}`;
      const statement = db.prepare(`
        ${prefix} ${filteredCte} identified_apps AS (
          SELECT h.localAddress AS src, h.remoteAddress AS dst,
            h.remotePort AS dport, UPPER(h.networkProtocol) AS proto,
            h.agentId, h.appIdentity, MAX(h.processName) AS app
          FROM agent_app_hourly h
          WHERE ${rollupFilters.join(' AND ')}
          GROUP BY h.localAddress, h.remoteAddress, h.remotePort,
            UPPER(h.networkProtocol), h.agentId, h.appIdentity
        ), identified_connections AS (
          SELECT src, dst, dport, proto FROM identified_apps
          GROUP BY src, dst, dport, proto
        ), app_groups AS (
          SELECT app, 'agent' AS attribution,
            NULL AS dport, NULL AS proto, NULL AS dstHost, COUNT(*) AS count
          FROM identified_apps GROUP BY app
          ${fallback}
        ) SELECT * FROM app_groups ORDER BY count DESC
      `);
      const selectedParams = sourceScope?.sourceKind === 'agent'
        ? []
        : [...source.params, ...params];
      return statement.all(...selectedParams, ...rollupParams);
    });
    // What the chart used to do was bucket `connections` by lastSeen. That
    // table keeps one row per flow and moves lastSeen every time the flow is
    // seen again, so the answer was "when did each flow stop" -- everything
    // still running piles into the newest bucket and the curve can only slope
    // upward. Measured on one Hub, six hours rose from 156 to 1,115 with no
    // change in traffic (P3-155).
    //
    // `connection_buckets` holds each window counted from evidence that records
    // a time: the router half folded in the seconds after the window closed,
    // the agent half from the observation times the Agents keep. The two are
    // stored separately and summed here. The label is resolved here rather
    // than at fold time because `org` and `dstHost` arrive later from
    // enrichment.
    //
    // The scoped path is left on the old query on purpose: the fold is not
    // per-source, so it cannot answer "this Agent only". A wrong answer to a
    // narrower question is worse than the same answer as before.
    // `lastSeen` restores the original chart on request: it buckets flows by
    // their last sighting, which slopes upward on its own, but it reaches back
    // as far as `connections` does. A Hub whose observed record has only just
    // started may prefer the familiar shape to a short one (P3-155).
    const timeline = timed('timeline', () => (useBuckets
      ? db.prepare(
        `SELECT COALESCE(NULLIF(c.org, ''), NULLIF(c.dstHost, ''), b.dst) AS key,
                MIN(?, MAX(0, CAST((b.bucketStart - ?) / ? AS INTEGER))) AS bucket,
                SUM(b.flows) AS count
         FROM connection_buckets b
         LEFT JOIN (
           SELECT dst, MAX(NULLIF(org, '')) AS org, MAX(NULLIF(dstHost, '')) AS dstHost
           FROM connections GROUP BY dst
         ) AS c ON c.dst = b.dst
         -- Inclusive at the top: a bucket covers [start, start + width), and
         -- rangeTo is often exactly the newest bucket's start (it defaults to
         -- the newest lastSeen). Excluding it dropped the most recent window,
         -- which is the one being looked at.
         WHERE b.bucketStart >= ? AND b.bucketStart <= ?
         GROUP BY key, bucket ORDER BY bucket ASC, count DESC`
      ).all(bucketCount - 1, timelineFrom, bucketMs, timelineFrom, timelineTo)
      : db.prepare(
        `${source.cte} SELECT ${targetExpr} AS key,
                CASE
                  WHEN lastSeen < ? THEN 0
                  WHEN lastSeen >= ? THEN ?
                  ELSE CAST((lastSeen - ?) / ? AS INTEGER)
                END AS bucket,
                COUNT(*) AS count
         FROM ${source.from}${where}
         GROUP BY key, bucket ORDER BY bucket ASC, count DESC`
      ).all(...source.params, rangeFrom, rangeTo, bucketCount - 1, rangeFrom, bucketMs, ...params)));

    // Where the record begins, and where it begins covering everything. A
    // range reaching past either has to say so rather than let the reader take
    // a partial record for a complete one.
    const coverage = useBuckets ? connectionBucketCoverage(db) : { from: null, routerFrom: null };
    const recordedFrom = coverage.from;
    const timelineFullFrom = coverage.routerFrom;
    const result = {
      byDst,
      byDevice,
      byTarget,
      byEdge,
      byLocation,
      mapCoverage: {
        limit: locationLimit,
        totalGroups: locationTotalGroups,
        shownGroups: byLocation.length,
        totalSessions: locationTotalSessions,
        shownSessions: locationShownSessions,
        percent: locationTotalSessions ? (locationShownSessions / locationTotalSessions) * 100 : 0,
        capped: locationTotalGroups > byLocation.length,
      },
      appGroups: summarizeAppGroups(appRows),
      timelineFrom: recordedFrom,
      timelineFullFrom,
      // What the bars actually span, which the chart draws its axis from.
      timelineRange: { from: timelineFrom, to: timelineTo },
      timeline,
      total,
      buckets: bucketCount,
      from: rangeFrom,
      to: rangeTo,
    };
    timings.total = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (onSummaryTiming) onSummaryTiming({ ...timings });
    return result;
  }

  return {
    queryByTimeRange,
    queryByTimeRangePaged,
    countByTimeRange,
    countFactsByTimeRange,
    createConnectionExportReader,
    groupAgentOnlyDstByTimeRange,
    groupDstByTimeRange,
    groupServiceByTimeRange,
    groupSrcForDstsByTimeRange,
    groupSrcByTimeRange,
    listSourceDeviceKeys,
    summarizeByTimeRange,
  };
}

module.exports = {
  createHistoryQueries,
  buildFilterConditions,
  buildWhereAndParams,
  escapeLikeValue,
  makeLikePat,
  connectionSource,
  sourceScopeCondition,
};
