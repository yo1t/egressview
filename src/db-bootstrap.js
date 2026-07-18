// Explicit DB bootstrap boundary (P2-30 expand phase).
//
// Five modules keep long-lived connections to the same SQLite file:
// history, sessions, devices, enrichment, and beacons (backup adds a
// temporary one while running). Schema migrations are owned by history and
// MUST complete before any other module opens the file — a migration
// failure throws here, so the process stops with nothing else attached.
//
// server.js used to encode this ordering implicitly in its call sequence;
// this module makes it an explicit, testable invariant.
'use strict';

/**
 * Open every long-lived DB connection in the required order.
 * @param {{
 *   dbPath: string,
 *   sourceRouterMap?: { yamaha: string, cisco: string },
 *   history, sessions, devices, enrichment, beacons,
 * }} deps
 */
function runDbBootstrap({ dbPath, sourceRouterMap, history, sessions, devices, enrichment, beacons }) {
  // 1. history first: runs the versioned migrations (with the P2-33
  //    fail-closed backup). Throws on failure — nothing below runs.
  history.loadConnectionHistory(dbPath, sourceRouterMap ? { sourceRouterMap } : {});

  // 2. The remaining modules attach only after the schema is final.
  sessions.initDb(dbPath);
  devices.initDb(dbPath);
  const enrichResult = enrichment.initDb(dbPath);
  beacons.initDb(dbPath);
  return { staleEnrichmentIps: enrichResult?.staleIps || [] };
}

module.exports = { runDbBootstrap };
