'use strict';

// Which device-list row each Agent's computer is on now, and what the Agent
// knows about that computer that a router does not: its name, who made it
// and which model, and the IPv6 addresses it sends from (P3-199, P3-200).
//
// The device list is built from what routers see, and a router names a
// device only by what the LAN announces. On the production Hub 2026-11-22 a
// Mac read "Mac" with no maker (its Wi-Fi address is random), and a virtual
// machine behind its host's NAT had no name, maker or hardware address at
// all. IPv6 is passed through by the router there, so no router knows which
// device holds which IPv6 address; an Agent knows its own.

const { isDeviceAddress, isAgentSideAddress } = require('./devices');

// An Agent not heard from for longer than this may have left the address it
// was on, and another device may hold it now.
const CURRENT_WITHIN_MS = 24 * 60 * 60 * 1000;
const IPV6_LIST_MAX = 3;
const CACHE_MS = 60 * 1000;

/**
 * The row an Agent is on: of the LAN addresses it sent from in its last hour,
 * newest first, the first a router knows the hardware address of; failing
 * that, the first with a row at all (a virtual machine no router sees).
 */
function primaryAddress(addresses, devices) {
  const lan = addresses.filter(entry => isDeviceAddress(entry.address) && !isAgentSideAddress(entry.address));
  return lan.find(entry => devices.getByIp(entry.address)?.mac)
    || lan.find(entry => devices.getByIp(entry.address))
    || null;
}

/**
 * @returns {Map<string, { agentId, hostName, platform, manufacturer, model, ipv6: string[], lastUsedAt }>}
 *   keyed by the row's IPv4 address
 */
function buildAgentDeviceIdentities({ agentIdentities, agentIngest, devices, now = Date.now() }) {
  const byIp = new Map();
  if (!agentIdentities || !agentIngest?.listAgentAddresses || !devices?.getByIp) return byIp;
  const hardware = agentIngest.listAgentHardware?.() || new Map();
  for (const agent of agentIdentities.listAgents()) {
    if (agent.revokedAt || agent.lastSeenAt == null || now - agent.lastSeenAt > CURRENT_WITHIN_MS) continue;
    const { addresses } = agentIngest.listAgentAddresses({ agentId: agent.agentId, until: agent.lastSeenAt });
    const primary = primaryAddress(addresses, devices);
    if (!primary) continue;
    const held = byIp.get(primary.address);
    // Two Agents on one address: a computer that changed hands within the
    // hour. The one that used it last has it.
    if (held && held.lastUsedAt >= primary.lastUsedAt) continue;
    const made = hardware.get(agent.agentId) || {};
    byIp.set(primary.address, {
      agentId: agent.agentId,
      hostName: agent.hostName || null,
      platform: agent.platform || null,
      manufacturer: made.manufacturer || null,
      model: made.model || null,
      ipv6: addresses.filter(entry => entry.address.includes(':'))
        .slice(0, IPV6_LIST_MAX).map(entry => entry.address),
      lastUsedAt: primary.lastUsedAt,
    });
  }
  return byIp;
}

/**
 * Cached for a minute: the device list is fetched on every refresh, and the
 * Agents' addresses change far more slowly. Each rebuild also records where
 * each Agent is, which offers the row it left as a merge candidate.
 */
function createAgentDeviceIdentityReader(ctx, { cacheMs = CACHE_MS, clock = Date.now } = {}) {
  let cached = null;
  let cachedAt = 0;
  return function read() {
    const now = clock();
    if (cached && now - cachedAt < cacheMs) return cached;
    cached = buildAgentDeviceIdentities({ ...ctx, now });
    cachedAt = now;
    for (const [ip, identity] of cached) {
      ctx.devices.noteAgentAddress?.({
        agentId: identity.agentId, hostName: identity.hostName, ip, at: identity.lastUsedAt,
      });
    }
    return cached;
  };
}

module.exports = { buildAgentDeviceIdentities, createAgentDeviceIdentityReader, primaryAddress, CURRENT_WITHIN_MS };
