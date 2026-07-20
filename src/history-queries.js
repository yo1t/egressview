// Read/query side of connection history. The caller retains DB ownership.
'use strict';

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

function buildWhereAndParams(from, to, filterConditions) {
  const conditions = [];
  const params = [];
  if (from != null) { conditions.push('lastSeen >= ?'); params.push(from); }
  if (to != null) { conditions.push('lastSeen <= ?'); params.push(to); }
  conditions.push(...filterConditions.conditions);
  params.push(...filterConditions.params);
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
  function queryByTimeRange(from, to) {
    const db = getDb();
    if (!db) return [];
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] });
    return hydrateConnectionRows(db.prepare(
      `SELECT ${connectionReadColumns('c')} FROM connections c${where} ORDER BY c.lastSeen DESC`
    ).all(...params));
  }

  function queryByTimeRangePaged(from, to, limit, offset, { sort = 'lastSeen', sortDir = 'desc', filters = {} } = {}) {
    const db = getDb();
    if (!db) return [];
    const sortSql = SORT_COL_SQL[sort] || 'lastSeen';
    const direction = sortDir === 'asc' ? 'ASC' : 'DESC';
    const { where, params } = buildWhereAndParams(from, to, buildFilterConditions(filters));
    const orderClause = sortSql.split(',').map(column => `${column.trim()} ${direction}`).join(', ');
    const sql = `SELECT ${connectionReadColumns('c')} FROM connections c${where} ORDER BY ${orderClause}`;
    if (limit == null) return hydrateConnectionRows(db.prepare(sql).all(...params));
    return hydrateConnectionRows(db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, limit, offset));
  }

  function countByTimeRange(from, to, { filters = {} } = {}) {
    const db = getDb();
    if (!db) return 0;
    const { where, params } = buildWhereAndParams(from, to, buildFilterConditions(filters));
    return db.prepare(`SELECT COUNT(*) AS cnt FROM connections${where}`).get(...params)?.cnt || 0;
  }

  function countFactsByTimeRange(from, to) {
    const db = getDb();
    if (!db) return { connections: 0, devices: 0, destinations: 0 };
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] });
    const row = db.prepare(`
      SELECT COUNT(*) AS connections,
             COUNT(DISTINCT COALESCE(NULLIF(srcMac, ''), src)) AS devices,
             COUNT(DISTINCT dst) AS destinations
      FROM connections${where}
    `).get(...params) || {};
    return {
      connections: row.connections || 0,
      devices: row.devices || 0,
      destinations: row.destinations || 0,
    };
  }

  function createConnectionExportReader(from, to) {
    const db = getDb();
    const dbPath = getDbPath();
    if (!db || dbPath === ':memory:') {
      return {
        countByTimeRange: () => countByTimeRange(from, to),
        queryByTimeRangePaged: (_from, _to, limit, offset, opts) =>
          queryByTimeRangePaged(from, to, limit, offset, opts),
        close() {},
      };
    }

    const snapshotDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      snapshotDb.pragma('query_only = ON');
      snapshotDb.exec('BEGIN');
      const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] });
      const count = snapshotDb.prepare(`SELECT COUNT(*) AS cnt FROM connections${where}`).get(...params)?.cnt || 0;
      const pageStatement = snapshotDb.prepare(
        `SELECT ${connectionReadColumns('c')} FROM connections c${where}
         ORDER BY c.lastSeen DESC LIMIT ? OFFSET ?`
      );
      let closed = false;
      return {
        countByTimeRange: () => count,
        queryByTimeRangePaged: (_from, _to, limit, offset) =>
          hydrateConnectionRows(pageStatement.all(...params, limit, offset)),
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

  function groupDstByTimeRange(from, to, { filters = {} } = {}) {
    const db = getDb();
    if (!db) return [];
    const { where, params } = buildWhereAndParams(from, to, buildFilterConditions(filters));
    return db.prepare(
      `SELECT dst, MAX(dstHost) AS dstHost, COUNT(*) AS cnt FROM connections${where} GROUP BY dst`
    ).all(...params);
  }

  function groupServiceByTimeRange(from, to) {
    const db = getDb();
    if (!db) return [];
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] });
    return db.prepare(
      `SELECT dport, proto, COUNT(*) AS count FROM connections${where}
       GROUP BY dport, proto ORDER BY count DESC LIMIT 20`
    ).all(...params);
  }

  // Which source devices contacted a given (small) set of destination IPs.
  // Used by the AI context to link devices to threat destinations. Bounded by
  // both the destination list size and a hard row cap so it never scans wide.
  function groupSrcForDstsByTimeRange(from, to, dsts) {
    const db = getDb();
    if (!db || !Array.isArray(dsts) || dsts.length === 0) return [];
    const capped = dsts.slice(0, 50);
    const placeholders = capped.map(() => '?').join(',');
    const conditions = [];
    const params = [];
    if (from != null) { conditions.push('lastSeen >= ?'); params.push(from); }
    if (to != null) { conditions.push('lastSeen <= ?'); params.push(to); }
    conditions.push(`dst IN (${placeholders})`);
    params.push(...capped);
    const where = ' WHERE ' + conditions.join(' AND ');
    return db.prepare(
      `SELECT dst, src,
              MAX(srcDnsName) AS srcDnsName,
              MAX(srcMdnsName) AS srcMdnsName,
              MAX(srcMac) AS srcMac,
              COUNT(*) AS cnt
       FROM connections${where}
       GROUP BY dst, src ORDER BY cnt DESC LIMIT 200`
    ).all(...params);
  }

  // Bounded source-device summary for AI context. Keep this separate from the
  // full graph summary so a manual AI request does not run its heavier queries.
  function groupSrcByTimeRange(from, to, limit = 30) {
    const db = getDb();
    if (!db) return [];
    const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const { where, params } = buildWhereAndParams(from, to, { conditions: [], params: [] });
    return db.prepare(
      `SELECT src,
              MAX(srcMac) AS srcMac,
              MAX(srcVendor) AS srcVendor,
              MAX(srcDnsName) AS srcDnsName,
              MAX(srcMdnsName) AS srcMdnsName,
              COUNT(*) AS count,
              MIN(firstSeen) AS firstSeen,
              MAX(lastSeen) AS lastSeen
       FROM connections${where}
       GROUP BY src ORDER BY count DESC LIMIT ?`
    ).all(...params, cappedLimit);
  }

  function summarizeByTimeRange(from, to, { src = null, buckets = 60 } = {}) {
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
    const conditions = [];
    const params = [];
    if (from != null) { conditions.push('lastSeen >= ?'); params.push(from); }
    if (to != null) { conditions.push('lastSeen <= ?'); params.push(to); }
    if (src != null) { conditions.push('src = ?'); params.push(src); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const targetExpr = "COALESCE(NULLIF(org, ''), NULLIF(dstHost, ''), dst)";
    const countRow = timed('range', () => db.prepare(
      `SELECT COUNT(*) AS total, MIN(lastSeen) AS minLastSeen, MAX(lastSeen) AS maxLastSeen
       FROM connections${where}`
    ).get(...params) || {});
    const total = countRow.total || 0;
    const rangeFrom = from ?? countRow.minLastSeen ?? Date.now();
    const rangeTo = to ?? countRow.maxLastSeen ?? Date.now();
    const bucketCount = Math.max(1, Math.min(240, Number(buckets) || 60));
    const bucketMs = Math.max(1, (Math.max(rangeTo, rangeFrom + 1) - rangeFrom) / bucketCount);

    const byDst = timed('destinations', () => db.prepare(
      `SELECT dst, dstHost, country, org,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM connections${where}
       GROUP BY dst ORDER BY count DESC LIMIT 500`
    ).all(...params));
    const byDevice = timed('devices', () => db.prepare(
      `SELECT src, MAX(srcMac) AS srcMac, MAX(srcVendor) AS srcVendor,
              MAX(srcDnsName) AS srcDnsName, MAX(srcMdnsName) AS srcMdnsName,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM connections${where}
       GROUP BY src ORDER BY count DESC LIMIT 200`
    ).all(...params));
    const deviceObservations = timed('observations', () => db.prepare(`
      WITH filtered_connections AS (SELECT * FROM connections${where})
      SELECT c.src, GROUP_CONCAT(DISTINCT o.routerId) AS observedByCsv
      FROM filtered_connections c
      JOIN connection_observations o
        ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      GROUP BY c.src
    `).all(...params));
    const observationsByDevice = new Map(deviceObservations.map(row => [row.src, normalizeObservedBy(row.observedByCsv)]));
    for (const row of byDevice) {
      row.observedBy = observationsByDevice.get(row.src) || [];
      row.sources = compatibilitySource(row.observedBy);
    }
    const byTarget = timed('targets', () => db.prepare(
      `SELECT ${targetExpr} AS key, ${targetExpr} AS label,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM connections${where}
       GROUP BY key ORDER BY count DESC LIMIT 1000`
    ).all(...params));
    const byEdge = timed('edges', () => db.prepare(
      `SELECT src, ${targetExpr} AS key,
              COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
       FROM connections${where}
       GROUP BY src, key ORDER BY count DESC LIMIT 3000`
    ).all(...params));
    const locationLimit = 500;
    const locationFilter = `${where}${where ? ' AND' : ' WHERE'} lat IS NOT NULL AND lon IS NOT NULL`;
    const byLocation = timed('locations', () => db.prepare(
      `SELECT ${targetExpr} AS key, ${targetExpr} AS org,
              country, city, lat, lon,
              COUNT(*) AS totalSessions, COUNT(DISTINCT src) AS srcCount,
              MAX(ttl) AS maxTtl, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen,
              COUNT(*) OVER () AS totalGroups,
              SUM(COUNT(*)) OVER () AS allLocationSessions
       FROM connections${locationFilter}
       GROUP BY key, lat, lon ORDER BY totalSessions DESC LIMIT ?`
    ).all(...params, locationLimit));
    const locationTotalSessions = byLocation[0]?.allLocationSessions || 0;
    const locationShownSessions = byLocation.reduce((sum, row) => sum + (row.totalSessions || 0), 0);
    const locationTotalGroups = byLocation[0]?.totalGroups || 0;
    for (const row of byLocation) {
      delete row.totalGroups;
      delete row.allLocationSessions;
    }
    const appRows = timed('applications', () => db.prepare(
      `SELECT dport, proto, COALESCE(NULLIF(dstHost, ''), dst) AS dstHost, COUNT(*) AS count
       FROM connections${where}
       GROUP BY dport, proto, dstHost ORDER BY count DESC`
    ).all(...params));
    const timeline = timed('timeline', () => db.prepare(
      `SELECT ${targetExpr} AS key,
              CASE
                WHEN lastSeen < ? THEN 0
                WHEN lastSeen >= ? THEN ?
                ELSE CAST((lastSeen - ?) / ? AS INTEGER)
              END AS bucket,
              COUNT(*) AS count
       FROM connections${where}
       GROUP BY key, bucket ORDER BY bucket ASC, count DESC`
    ).all(rangeFrom, rangeTo, bucketCount - 1, rangeFrom, bucketMs, ...params));
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
    groupDstByTimeRange,
    groupServiceByTimeRange,
    groupSrcForDstsByTimeRange,
    groupSrcByTimeRange,
    summarizeByTimeRange,
  };
}

module.exports = {
  createHistoryQueries,
  buildFilterConditions,
  buildWhereAndParams,
  escapeLikeValue,
  makeLikePat,
};
