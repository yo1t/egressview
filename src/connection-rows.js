'use strict';

// How a connection row is read and finished, shared by the history module on
// the main thread and the database read thread (db-worker.js), so a row comes
// back the same whichever thread read it.

const CONNECTION_READ_COLUMNS = [
  'src', 'dst', 'dport', 'proto', 'sport', 'ttl', 'srcMac', 'srcVendor',
  'srcDnsName', 'srcMdnsName', 'dstHost', 'country', 'org', 'lat', 'lon',
  'city', 'firstSeen', 'lastSeen', 'agentHost', 'process', 'pid',
];

function connectionReadColumns(alias = 'c') {
  const columns = CONNECTION_READ_COLUMNS.map(column => `${alias}.${column}`).join(', ');
  return `${columns}, (
    SELECT GROUP_CONCAT(o.routerId)
    FROM connection_observations o
    WHERE o.src = ${alias}.src AND o.dst = ${alias}.dst
      AND o.dport = ${alias}.dport AND o.proto = ${alias}.proto
  ) AS observedByCsv`;
}

function normalizeObservedBy(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map(id => String(id).trim()).filter(Boolean))].sort();
}

/**
 * The legacy `source` label and row hydration, given how to tell a router's
 * kind from its id. The caller owns that lookup: the history module keeps it
 * in memory, the read thread reads it from the routers table.
 */
function createRowHydration({ routerKind }) {
  function compatibilitySource(observedBy) {
    const kinds = new Set(normalizeObservedBy(observedBy).map(routerKind));
    if (kinds.has('yamaha') && kinds.has('cisco')) return 'yamaha+cisco';
    if (kinds.has('cisco')) return 'cisco';
    if (kinds.has('yamaha')) return 'yamaha';
    return 'unknown';
  }

  function hydrateConnectionRow(row) {
    const observedBy = normalizeObservedBy(row.observedByCsv ?? row.observedBy);
    const hydrated = { ...row, observedBy, source: compatibilitySource(observedBy) };
    delete hydrated.observedByCsv;
    return hydrated;
  }

  function hydrateConnectionRows(rows) {
    return rows.map(hydrateConnectionRow);
  }

  return { compatibilitySource, hydrateConnectionRow, hydrateConnectionRows };
}

module.exports = {
  CONNECTION_READ_COLUMNS,
  connectionReadColumns,
  normalizeObservedBy,
  createRowHydration,
};
