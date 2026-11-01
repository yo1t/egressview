'use strict';

// An Agent that has stopped reporting while its computer is still on the
// network (P3-103).
//
// On 2026-08-18 a Mac recorded nothing for 13h27m: the Agent's app had not come
// back after an update, and nothing said so. "No report for N minutes" alone
// would fire every time a laptop is closed, so this asks for a second witness:
// a router that keeps seeing new connections from the computer's address after
// its Agent went quiet. Asleep or switched off, the computer makes none.
//
// Checked against production before it was written (2026-11-02, four Agents,
// one to seven days each): no five-minute stretch in which a router saw a new
// connection from an Agent's computer and that Agent delivered nothing within
// ten minutes either side. No real outage fell inside those days, so that
// check shows only that the quiet cases stay quiet.
//
// New connections only (`firstObservedAt`). A router keeps a sleeping
// computer's NAT sessions for a while and refreshes `lastObservedAt` on each
// poll, which would look like traffic.
//
// It needs a router: a Hub with only Agents never raises it.

const SILENT_AFTER_MS = 15 * 60 * 1000;
const MIN_ROUTER_CONNECTIONS = 3;
// After the Agent's last delivery, connections it would still have reported:
// its send spacing and the router's poll put the two a little apart.
const ROUTER_SETTLE_MS = 2 * 60 * 1000;
// Agents quiet for longer are not looked at: by then the address may belong
// to another device, and a removed Agent should not be announced forever.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
// After a Hub start the routers are read at once, while the Agents are still
// waiting to retry the uploads that failed during the restart.
const STARTUP_GRACE_MS = 20 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const PRIVATE_V4_SQL = `(
  o.localAddress LIKE '192.168.%' OR o.localAddress LIKE '10.%'
  OR o.localAddress GLOB '172.1[6-9].*' OR o.localAddress GLOB '172.2[0-9].*'
  OR o.localAddress GLOB '172.3[01].*'
) AND o.localAddress NOT LIKE '%.255'`;

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Agents quiet for at least `silentAfterMs` whose computer a router still sees.
 * Reads `agents`, `agent_ingest_batches`, `agent_observations` and
 * `connection_observations`; runs on the read thread.
 *
 * @returns {Array<{ agentId, hostName, address, lastDeliveredAt, routerConnections, firstRouterAt, lastRouterAt }>}
 */
function findSilentAgents(db, {
  now = Date.now(), silentAfterMs = SILENT_AFTER_MS,
  minRouterConnections = MIN_ROUTER_CONNECTIONS, lookbackMs = LOOKBACK_MS,
} = {}) {
  for (const name of ['agents', 'agent_ingest_batches', 'agent_observations', 'connection_observations']) {
    if (!hasTable(db, name)) return [];
  }
  const agents = db.prepare('SELECT agentId, hostName FROM agents WHERE revokedAt IS NULL').all();
  const lastDelivery = db.prepare(
    'SELECT MAX(receivedAt) AS at FROM agent_ingest_batches WHERE agentId = ?'
  );
  // The computer's recent LAN addresses, newest first. A virtual interface
  // (a VM host-only network, Docker) is on this list too; the router check
  // below drops it, since no router sees it.
  const addresses = db.prepare(`
    SELECT o.localAddress AS address, MAX(o.lastObservedAt) AS lastUsedAt
    FROM agent_observations o
    WHERE o.agentId = ? AND o.lastObservedAt BETWEEN ? AND ? AND ${PRIVATE_V4_SQL}
    GROUP BY o.localAddress ORDER BY lastUsedAt DESC
  `);
  const routerSeen = db.prepare('SELECT 1 FROM connection_observations WHERE src = ? LIMIT 1');
  // On 2026-11-02 one Agent had a single row from another computer's address.
  // An address someone else used later is that one's now.
  const usedLaterByOther = db.prepare(`
    SELECT 1 FROM agent_observations
    WHERE localAddress = ? AND agentId <> ? AND lastObservedAt > ? LIMIT 1
  `);
  const routerSince = db.prepare(`
    SELECT COUNT(*) AS n, MIN(firstObservedAt) AS firstAt, MAX(firstObservedAt) AS lastAt
    FROM connection_observations WHERE src = ? AND firstObservedAt > ? AND firstObservedAt <= ?
  `);

  const findings = [];
  for (const agent of agents) {
    const lastDeliveredAt = lastDelivery.get(agent.agentId)?.at;
    if (lastDeliveredAt == null) continue;
    const quietFor = now - lastDeliveredAt;
    if (quietFor < silentAfterMs || quietFor > lookbackMs) continue;
    const address = addresses.all(agent.agentId, lastDeliveredAt - lookbackMs, lastDeliveredAt)
      .find(row => routerSeen.get(row.address)
        && !usedLaterByOther.get(row.address, agent.agentId, row.lastUsedAt))?.address;
    if (!address) continue;
    const router = routerSince.get(address, lastDeliveredAt + ROUTER_SETTLE_MS, now);
    if (router.n < minRouterConnections) continue;
    findings.push({
      agentId: agent.agentId,
      hostName: agent.hostName,
      address,
      lastDeliveredAt,
      routerConnections: router.n,
      firstRouterAt: router.firstAt,
      lastRouterAt: router.lastAt,
    });
  }
  return findings;
}

/**
 * One notification per Agent and silence: a silence is named by the Agent's
 * last delivery, so it is announced again only after the Agent has reported
 * and gone quiet a second time.
 */
function silenceKey({ agentId, lastDeliveredAt }) {
  return `${agentId}|${lastDeliveredAt}`;
}

/** Keys of silences already announced, from the detection log's agent_silent rows. */
function silenceKeysFromLog(rows) {
  const keys = [];
  for (const row of rows || []) {
    let tag;
    try { tag = JSON.parse(row.threatTag || ''); } catch { continue; }
    if (!tag || typeof tag !== 'object' || !tag.agentId || tag.lastDeliveredAt == null) continue;
    keys.push(silenceKey(tag));
  }
  return keys;
}

module.exports = {
  findSilentAgents, silenceKey, silenceKeysFromLog,
  SILENT_AFTER_MS, MIN_ROUTER_CONNECTIONS, ROUTER_SETTLE_MS, LOOKBACK_MS, STARTUP_GRACE_MS, CHECK_INTERVAL_MS,
};
