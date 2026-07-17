'use strict';

const EXPORT_LIMIT = 50_000;
const EXPORT_PAGE_SIZE = 1_000;
const EXPORT_TIMEOUT_MS = 60_000;

const CSV_COLUMNS = [
  'src', 'srcMac', 'srcVendor', 'srcDnsName', 'srcMdnsName',
  'dst', 'dstHost', 'dport', 'proto', 'country', 'city', 'org',
  'firstSeen', 'lastSeen', 'ttl', 'source', 'observedBy',
  'threatConfidence', 'threatSource', 'threatTag',
];

function exportRow(connection) {
  const threat = connection.threat || {};
  return {
    src: connection.src || '',
    srcMac: connection.srcMac || '',
    srcVendor: connection.srcVendor || '',
    srcDnsName: connection.srcDnsName || '',
    srcMdnsName: connection.srcMdnsName || '',
    dst: connection.dst || '',
    dstHost: connection.dstHost || '',
    dport: connection.dport ?? '',
    proto: connection.proto || '',
    country: connection.country || '',
    city: connection.city || '',
    org: connection.org || '',
    firstSeen: connection.firstSeen || null,
    lastSeen: connection.lastSeen || null,
    ttl: connection.ttl ?? '',
    source: connection.source || '',
    observedBy: Array.isArray(connection.observedBy) ? connection.observedBy : [],
    threatConfidence: threat.confidence || '',
    threatSource: threat.source || threat.feed || '',
    threatTag: threat.tag || threat.category || '',
  };
}

function preventCsvFormula(value) {
  const text = String(value ?? '');
  return /^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const normalized = Array.isArray(value) ? value.join('|') : value;
  const safe = preventCsvFormula(normalized).replace(/\r\n?/g, '\n');
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvLine(row) {
  return CSV_COLUMNS.map(column => csvCell(row[column])).join(',') + '\r\n';
}

async function writeChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) throw new Error('Export client disconnected');
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Export client disconnected'));
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

function exportFilename(format, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `egressview-connections-${stamp}.${format}`;
}

async function streamConnectionExport({
  res,
  history,
  threatIntel,
  from,
  to,
  format,
  limit = EXPORT_LIMIT,
  pageSize = EXPORT_PAGE_SIZE,
  timeoutMs = EXPORT_TIMEOUT_MS,
  now = Date.now,
}) {
  const startedAt = now();
  const total = history.countByTimeRange(from, to);
  const count = Math.min(total, limit);
  const truncated = total > limit;
  const filename = exportFilename(format, new Date(startedAt));

  res.set({
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Export-Total': String(total),
    'X-Export-Count': String(count),
    'X-Export-Truncated': String(truncated),
  });
  res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');

  if (format === 'csv') {
    await writeChunk(res, '\uFEFF' + CSV_COLUMNS.join(',') + '\r\n');
  } else {
    const meta = JSON.stringify({ from, to, total, exported: count, truncated, limit });
    await writeChunk(res, `{"meta":${meta},"connections":[`);
  }

  let written = 0;
  while (written < count) {
    if (now() - startedAt > timeoutMs) throw new Error('Connection export timed out');
    const rows = history.queryByTimeRangePaged(
      from,
      to,
      Math.min(pageSize, count - written),
      written,
      { sort: 'lastSeen', sortDir: 'desc' }
    );
    if (!rows.length) break;
    const enriched = threatIntel ? rows.map(connection => ({
      ...connection,
      threat: threatIntel.matchThreatIntel(connection.dst, connection.dstHost || connection.dst) || null,
    })) : rows;
    for (const connection of enriched) {
      if (now() - startedAt > timeoutMs) throw new Error('Connection export timed out');
      const row = exportRow(connection);
      if (format === 'csv') {
        await writeChunk(res, csvLine(row));
      } else {
        await writeChunk(res, (written ? ',' : '') + JSON.stringify(row));
      }
      written++;
    }
  }

  if (format === 'json') await writeChunk(res, ']}');
  res.end();
  return { total, written, truncated };
}

module.exports = {
  CSV_COLUMNS,
  EXPORT_LIMIT,
  EXPORT_PAGE_SIZE,
  EXPORT_TIMEOUT_MS,
  csvCell,
  csvLine,
  exportFilename,
  exportRow,
  preventCsvFormula,
  streamConnectionExport,
};
