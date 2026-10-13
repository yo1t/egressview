'use strict';

const { createHash } = require('node:crypto');

const AGENT_GEO_CACHE_SCHEMA_VERSION = 1;

/// Locations for destinations, as stored by enrichment. The table is created by
/// enrichment at startup rather than by a migration, so a Hub that has never
/// enriched anything simply has none: "nothing to place", not a failure.
function readGeoLocations(db) {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'geo_cache'")
    .get();
  if (!hasTable) return [];
  return db
    .prepare(
      'SELECT ip, lat, lon, countryCode, city FROM geo_cache '
      + 'WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY ip'
    )
    .all();
}

/**
 * The whole /agent/geo-cache response, ready to send: the JSON text and its
 * ETag. Built where the rows are read -- on the read thread when there is one
 * -- because reading, hashing and serialising all of them cost 300-400 ms on
 * the thread that answers every request, about 25 times an hour on production
 * (2026-10-13, 118,758 rows), whether or not the answer was then a 304.
 */
function buildGeoCacheResponse(rows, { now = new Date() } = {}) {
  // Positional entries: repeating five key names across a hundred thousand
  // rows costs more than the coordinates themselves.
  const entries = rows.map(row => [
    row.ip,
    row.lat,
    row.lon,
    row.countryCode || null,
    row.city || null,
  ]);
  // The cache changes by a handful of rows a day, so most fetches should cost
  // a 304 rather than several megabytes.
  const etag = `W/"geo-${entries.length}-${createHash('sha256')
    .update(entries.map(entry => entry.join(',')).join('\n'))
    .digest('hex')
    .slice(0, 32)}"`;
  const json = JSON.stringify({
    schemaVersion: AGENT_GEO_CACHE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    entries,
  });
  return { etag, json, count: entries.length };
}

function buildGeoCacheFromDb(db) {
  return buildGeoCacheResponse(readGeoLocations(db));
}

module.exports = {
  AGENT_GEO_CACHE_SCHEMA_VERSION, buildGeoCacheFromDb, buildGeoCacheResponse, readGeoLocations,
};
