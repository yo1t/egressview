'use strict';

// The addresses an Agent's computer used most recently, read from the local
// side of the flows it reported (P3-194). The Agent does not send its
// addresses on their own; a flow names the address it left from.
//
// One computer often has several: the LAN address the router sees, and the
// addresses of a VPN, Docker or a virtual machine's host-only network. They
// are listed newest first; the caller matches them against the routers'
// device list to tell which one is on the LAN.

// The last hour the Agent reported in. Enough for any address in use, and a
// range on `lastObservedAt`, which is indexed: on the production Hub an hour
// holds about 25,000 flows across all Agents.
const ADDRESS_WINDOW_MS = 60 * 60 * 1000;
const ADDRESS_LIST_MAX = 8;

// Nothing anyone else could reach: loopback, IPv6 link-local, unspecified.
function isLocalOnly(address) {
  const value = String(address).toLowerCase();
  return value.startsWith('127.') || value === '::1' || value === '0.0.0.0' || value === '::'
    || /^fe[89ab][0-9a-f]:/.test(value);
}

/**
 * The addresses the Agent's flows left from in the hour before `until`
 * (normally its last delivery), newest first, with the collectors that saw
 * them.
 *
 * @returns {{ addresses: Array<{ address, lastUsedAt, flows }>, collectors: string[] }}
 */
function listAgentAddresses(db, {
  agentId, until, windowMs = ADDRESS_WINDOW_MS, limit = ADDRESS_LIST_MAX,
} = {}) {
  if (!agentId || !Number.isFinite(until)) return { addresses: [], collectors: [] };
  const rows = db.prepare(`
    SELECT localAddress AS address, MAX(lastObservedAt) AS lastUsedAt, COUNT(*) AS flows,
      GROUP_CONCAT(DISTINCT collector) AS collectors
    FROM agent_observations
    WHERE lastObservedAt BETWEEN ? AND ? AND agentId = ?
    GROUP BY localAddress
    ORDER BY lastUsedAt DESC
  `).all(until - windowMs, until, agentId);
  const collectors = new Set();
  const addresses = [];
  for (const row of rows) {
    for (const name of String(row.collectors || '').split(',')) if (name) collectors.add(name);
    if (isLocalOnly(row.address) || addresses.length >= limit) continue;
    addresses.push({ address: row.address, lastUsedAt: row.lastUsedAt, flows: row.flows });
  }
  return { addresses, collectors: [...collectors].sort() };
}

module.exports = { ADDRESS_WINDOW_MS, ADDRESS_LIST_MAX, isLocalOnly, listAgentAddresses };
