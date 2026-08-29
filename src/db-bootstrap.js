// Explicit DB bootstrap boundary (P2-30 expand phase).
//
// Long-lived modules keep separate connections to the same SQLite file.
// Schema migrations are owned by history and
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
 *   history, sessions, devices, enrichment, beacons, authAudit, apiIdentities,
 *   agentIdentities, agentIngest, threatIntel,
 * }} deps
 */
function runDbBootstrap({
  dbPath, sourceRouterMap, history, sessions, devices, enrichment, beacons, authAudit,
  apiIdentities, agentIdentities, agentIngest, threatIntel,
}) {
  // 1. history first: runs the versioned migrations (with the P2-33
  //    fail-closed backup). Throws on failure — nothing below runs.
  history.loadConnectionHistory(dbPath, sourceRouterMap ? { sourceRouterMap } : {});

  // 2. The remaining modules attach only after the schema is final.
  sessions.initDb(dbPath);
  devices.initDb(dbPath);
  const enrichResult = enrichment.initDb(dbPath);
  beacons.initDb(dbPath);
  if (authAudit) authAudit.initDb(dbPath);
  if (apiIdentities) apiIdentities.initDb(dbPath);
  if (agentIdentities) agentIdentities.initDb(dbPath);
  if (agentIngest) agentIngest.initDb(dbPath);
  // Threat indicators are cached here too (P3-54 part B). Without it a restart
  // while a feed is down starts with that feed absent and stays that way --
  // which production did, twice, on 2026-08-29.
  if (threatIntel) threatIntel.initDb(dbPath);
  return { staleEnrichmentIps: enrichResult?.staleIps || [] };
}

module.exports = { runDbBootstrap };
