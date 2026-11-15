'use strict';

// A device on the LAN probing a computer that has an Agent (P3-191): one
// sender reaching many of this computer's ports in a short time. The Mac
// Agent counts this from packet headers -- connection requests (TCP SYN) and
// UDP datagrams to ports below its own ephemeral range -- only while the
// packet counting the user can turn on is on, and sends one summary per
// sender, protocol and window. Nothing of what was sent is kept.
//
// Kept in a table created here rather than by a schema migration: a migration
// on this Hub begins with a verified copy of the whole database (5.1 GB in
// 2026-10), minutes during which nothing is collected.

// A summary at or above this many distinct ports is reported. The Agent sends
// from 5; normal LAN traffic from one sender reached at most 7 distinct ports
// on one address in two minutes over seven days of production data.
const PROBE_NOTIFY_MIN_PORTS = 10;

function ensureInboundProbesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_inbound_probes (
      agentId TEXT NOT NULL,
      windowStart INTEGER NOT NULL,
      windowSeconds INTEGER NOT NULL,
      localAddress TEXT NOT NULL,
      sourceAddress TEXT NOT NULL,
      networkProtocol TEXT NOT NULL,
      distinctPorts INTEGER NOT NULL,
      packets INTEGER NOT NULL,
      samplePorts TEXT NOT NULL,
      receivedAt INTEGER NOT NULL,
      PRIMARY KEY (agentId, windowStart, localAddress, sourceAddress, networkProtocol)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_inbound_probes_window ON agent_inbound_probes(windowStart);
  `);
}

/**
 * Stores the summaries of one upload. A summary already stored for the same
 * window is replaced by the later count (the Agent may resend a window it
 * counted further). Returns the ones that were not stored before, for
 * notification.
 */
function storeInboundProbes(db, agentId, probes, { receivedAt = Date.now() } = {}) {
  if (!Array.isArray(probes) || probes.length === 0) return [];
  const existing = db.prepare(`
    SELECT 1 FROM agent_inbound_probes
    WHERE agentId = ? AND windowStart = ? AND localAddress = ? AND sourceAddress = ? AND networkProtocol = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO agent_inbound_probes (
      agentId, windowStart, windowSeconds, localAddress, sourceAddress, networkProtocol,
      distinctPorts, packets, samplePorts, receivedAt
    ) VALUES (
      @agentId, @windowStart, @windowSeconds, @localAddress, @sourceAddress, @networkProtocol,
      @distinctPorts, @packets, @samplePorts, @receivedAt
    )
    ON CONFLICT (agentId, windowStart, localAddress, sourceAddress, networkProtocol) DO UPDATE SET
      distinctPorts = MAX(agent_inbound_probes.distinctPorts, excluded.distinctPorts),
      packets = MAX(agent_inbound_probes.packets, excluded.packets),
      samplePorts = excluded.samplePorts,
      receivedAt = excluded.receivedAt
  `);
  const fresh = [];
  db.transaction(() => {
    for (const probe of probes) {
      const row = {
        agentId,
        windowStart: Date.parse(probe.windowStart),
        windowSeconds: probe.windowSeconds,
        localAddress: probe.localAddress,
        sourceAddress: probe.sourceAddress,
        networkProtocol: probe.networkProtocol,
        distinctPorts: probe.distinctPorts,
        packets: probe.packets,
        samplePorts: JSON.stringify(probe.samplePorts || []),
        receivedAt,
      };
      const known = existing.get(row.agentId, row.windowStart, row.localAddress, row.sourceAddress, row.networkProtocol);
      upsert.run(row);
      if (!known) fresh.push({ ...probe, windowStartMs: row.windowStart });
    }
  })();
  return fresh;
}

// The senders listed per Agent. A sweep of a /24 from one device is one
// sender, so this bounds the answer without hiding a whole scan.
const LIST_MAX_SENDERS = 20;

/**
 * Per Agent, the devices that probed it since `since`: one entry per sender
 * and protocol, counted only from windows at the notification threshold, so
 * the list matches what the detection log reported. Newest first.
 *
 * @returns {Array<{agentId, total, senders: Array<{sourceAddress, networkProtocol,
 *   windows, maxPorts, packets, firstAt, lastAt, localAddress, samplePorts}>}>}
 */
function listInboundProbes(db, { since, minPorts = PROBE_NOTIFY_MIN_PORTS } = {}) {
  const rows = db.prepare(`
    SELECT agentId, sourceAddress, networkProtocol,
      COUNT(*) AS windows, MAX(distinctPorts) AS maxPorts, SUM(packets) AS packets,
      MIN(windowStart) AS firstAt, MAX(windowStart + windowSeconds * 1000) AS lastAt,
      MAX(windowStart) AS latestWindow
    FROM agent_inbound_probes
    WHERE windowStart >= ? AND distinctPorts >= ?
    GROUP BY agentId, sourceAddress, networkProtocol
    ORDER BY agentId, lastAt DESC
  `).all(since, minPorts);
  // The latest window's address and ports describe the sender as it was last
  // seen; the Agent's address can change between windows.
  const latest = db.prepare(`
    SELECT localAddress, samplePorts FROM agent_inbound_probes
    WHERE agentId = ? AND sourceAddress = ? AND networkProtocol = ? AND windowStart = ?
      AND distinctPorts >= ?
    ORDER BY distinctPorts DESC LIMIT 1
  `);
  const byAgent = new Map();
  for (const row of rows) {
    let report = byAgent.get(row.agentId);
    if (!report) {
      report = { agentId: row.agentId, total: 0, senders: [] };
      byAgent.set(row.agentId, report);
    }
    report.total += 1;
    if (report.senders.length >= LIST_MAX_SENDERS) continue;
    const last = latest.get(row.agentId, row.sourceAddress, row.networkProtocol, row.latestWindow, minPorts) || {};
    let samplePorts;
    try { samplePorts = JSON.parse(last.samplePorts || '[]'); } catch { samplePorts = []; }
    report.senders.push({
      sourceAddress: row.sourceAddress,
      networkProtocol: row.networkProtocol,
      windows: row.windows,
      maxPorts: row.maxPorts,
      packets: row.packets,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      localAddress: last.localAddress || null,
      samplePorts: Array.isArray(samplePorts) ? samplePorts : [],
    });
  }
  return [...byAgent.values()];
}

function pruneInboundProbes(db, before) {
  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_inbound_probes'"
  ).get();
  if (!hasTable) return 0;
  return db.prepare('DELETE FROM agent_inbound_probes WHERE windowStart < ?').run(before).changes;
}

module.exports = {
  PROBE_NOTIFY_MIN_PORTS, LIST_MAX_SENDERS,
  ensureInboundProbesTable, storeInboundProbes, listInboundProbes, pruneInboundProbes,
};
