'use strict';

// A program on a computer with an Agent that starts looking around the LAN:
// many addresses, or many ports on one address, in a short time (P3-191).
//
// The case this is for is a browser extension (or any other program on that
// computer) probing for routers, NAS boxes, cameras and printers to attack.
// The Agent already reports every connection with the process that made it,
// so this needs nothing new from the Agents.
//
// Thresholds from seven days of production data (2026-10-14, 1,381,814
// observations to LAN addresses, counted per process per two minutes):
//   - distinct LAN addresses: p99.9 = 8, maximum 17 (Windows svchost device
//     discovery). A sweep of one /24 is 254.
//   - distinct ports on one LAN address, ignoring the far side's ephemeral
//     ports: p99.9 = 2, maximum 7 (netcat run by hand).
// Neither threshold below was reached once in those seven days.

const WINDOW_MS = 2 * 60 * 1000;
const SWEEP_MIN_ADDRESSES = 30;
const PORT_PROBE_MIN_PORTS = 10;
// Ports at or above this on the far side are its own ephemeral ports (an
// incoming Zabbix check reaches 513 of them on one address in two minutes),
// not ports being probed.
const EPHEMERAL_PORT_FLOOR = 32768;
const SAMPLE_SIZE = 5;

// LAN destinations only: RFC 1918, IPv6 link-local and unique local. Multicast
// and broadcast are discovery by design (mDNS, SSDP) and are left out.
const LAN_DESTINATION_SQL = `(
  (o.remoteAddress LIKE '192.168.%' OR o.remoteAddress LIKE '10.%'
    OR o.remoteAddress GLOB '172.1[6-9].*' OR o.remoteAddress GLOB '172.2[0-9].*'
    OR o.remoteAddress GLOB '172.3[01].*'
    OR lower(o.remoteAddress) LIKE 'fe80:%' OR lower(o.remoteAddress) LIKE 'fd%'
    OR lower(o.remoteAddress) LIKE 'fc%')
  AND o.remoteAddress NOT LIKE '%.255'
  AND lower(o.remoteAddress) NOT LIKE 'ff%'
)`;

function windowStartFor(at, windowMs = WINDOW_MS) {
  return Math.floor(at / windowMs) * windowMs;
}

/**
 * Programs that crossed either threshold in one window [from, from + windowMs).
 * Reads `agent_observations`; runs on the read thread.
 *
 * @returns {Array<{ kind: 'sweep'|'port-probe', agentId, hostName, processName,
 *   localAddress, windowStart, windowMs, addresses, ports, target, sample }>}
 */
function findLanScans(db, {
  from, windowMs = WINDOW_MS,
  sweepMinAddresses = SWEEP_MIN_ADDRESSES, portProbeMinPorts = PORT_PROBE_MIN_PORTS,
} = {}) {
  const to = from + windowMs;
  const hasAgents = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_observations'"
  ).get();
  if (!hasAgents) return [];
  const findings = [];

  const sweeps = db.prepare(`
    SELECT o.agentId, a.hostName, o.processName,
           COUNT(DISTINCT o.remoteAddress) AS addresses,
           COUNT(DISTINCT o.remotePort) AS ports,
           MAX(o.localAddress) AS localAddress
    FROM agent_observations o JOIN agents a ON a.agentId = o.agentId
    WHERE o.firstObservedAt >= ? AND o.firstObservedAt < ? AND ${LAN_DESTINATION_SQL}
    GROUP BY o.agentId, o.processName
    HAVING COUNT(DISTINCT o.remoteAddress) >= ?
  `).all(from, to, sweepMinAddresses);
  const sampleAddresses = db.prepare(`
    SELECT DISTINCT o.remoteAddress AS address FROM agent_observations o
    WHERE o.agentId = ? AND o.processName IS ? AND o.firstObservedAt >= ? AND o.firstObservedAt < ?
      AND ${LAN_DESTINATION_SQL}
    ORDER BY o.remoteAddress LIMIT ${SAMPLE_SIZE}
  `);
  for (const row of sweeps) {
    findings.push({
      kind: 'sweep',
      agentId: row.agentId,
      hostName: row.hostName,
      processName: row.processName,
      localAddress: row.localAddress,
      windowStart: from,
      windowMs,
      addresses: row.addresses,
      ports: row.ports,
      target: null,
      sample: sampleAddresses.all(row.agentId, row.processName, from, to).map(r => r.address),
    });
  }

  const probes = db.prepare(`
    SELECT o.agentId, a.hostName, o.processName, o.remoteAddress AS target,
           COUNT(DISTINCT o.remotePort) AS ports,
           MAX(o.localAddress) AS localAddress
    FROM agent_observations o JOIN agents a ON a.agentId = o.agentId
    WHERE o.firstObservedAt >= ? AND o.firstObservedAt < ? AND o.remotePort < ?
      AND ${LAN_DESTINATION_SQL}
    GROUP BY o.agentId, o.processName, o.remoteAddress
    HAVING COUNT(DISTINCT o.remotePort) >= ?
  `).all(from, to, EPHEMERAL_PORT_FLOOR, portProbeMinPorts);
  const samplePorts = db.prepare(`
    SELECT DISTINCT o.remotePort AS port FROM agent_observations o
    WHERE o.agentId = ? AND o.processName IS ? AND o.remoteAddress = ?
      AND o.firstObservedAt >= ? AND o.firstObservedAt < ? AND o.remotePort < ?
    ORDER BY o.remotePort LIMIT ${SAMPLE_SIZE}
  `);
  for (const row of probes) {
    findings.push({
      kind: 'port-probe',
      agentId: row.agentId,
      hostName: row.hostName,
      processName: row.processName,
      localAddress: row.localAddress,
      windowStart: from,
      windowMs,
      addresses: 1,
      ports: row.ports,
      target: row.target,
      sample: samplePorts.all(row.agentId, row.processName, row.target, from, to, EPHEMERAL_PORT_FLOOR)
        .map(r => r.port),
    });
  }
  return findings;
}

/**
 * Which finished windows to look at now. A window is looked at once it ended
 * `settleMs` ago, so uploads from the Agents (seconds, normally) have landed.
 */
function windowsToCheck({ now, lastChecked, windowMs = WINDOW_MS, settleMs = 60 * 1000, maxWindows = 5 }) {
  const newestDone = windowStartFor(now - settleMs, windowMs) - windowMs;
  let next = lastChecked == null ? newestDone : lastChecked + windowMs;
  next = Math.max(next, newestDone - (maxWindows - 1) * windowMs);
  const windows = [];
  for (let start = next; start <= newestDone; start += windowMs) windows.push(start);
  return windows;
}

/** One notification per program and kind within `cooldownMs`. */
function createLanScanCooldown({ cooldownMs = 60 * 60 * 1000 } = {}) {
  const last = new Map();
  return {
    admit(finding, now = Date.now()) {
      const key = `${finding.agentId}|${finding.processName}|${finding.kind}|${finding.target || ''}`;
      const previous = last.get(key);
      if (previous != null && now - previous < cooldownMs) return false;
      last.set(key, now);
      for (const [k, at] of last) if (now - at >= cooldownMs) last.delete(k);
      return true;
    },
  };
}

module.exports = {
  findLanScans, windowsToCheck, windowStartFor, createLanScanCooldown,
  WINDOW_MS, SWEEP_MIN_ADDRESSES, PORT_PROBE_MIN_PORTS, EPHEMERAL_PORT_FLOOR,
};
