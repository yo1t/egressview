'use strict';

// AI analysis context builder.
//
// This context is NOT anonymized: destination IPs/hostnames and source device
// IPs/names/MACs are included so the model can produce actionable, threat-focused
// guidance that names the devices and destinations involved. What is still
// excluded: credentials, raw per-connection logs, and router addresses.
// The consent/privacy UI copy reflects this boundary.

const MAX_SERVICES = 20;
const MAX_DESTINATIONS = 15;
const MAX_THREATS = 40;
const MAX_DEVICES_PER_THREAT = 5;

function routerKinds(routers) {
  const counts = {};
  for (const router of routers) {
    if (!router.enabled) continue;
    const kind = String(router.kind || 'unknown').slice(0, 40);
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function hostOrNull(dst, dstHost) {
  const host = String(dstHost || '').trim();
  return host && host !== dst ? host.slice(0, 253) : null;
}

// Classify grouped destinations into prioritized threats (danger before warn)
// and attach the source devices that contacted each threat destination.
function buildThreats({ dstGroups, threatIntel, history, from, to }) {
  if (!threatIntel?.matchThreatIntel) return [];
  const threats = [];
  for (const { dst, dstHost, cnt } of dstGroups) {
    const match = threatIntel.matchThreatIntel(dst, dstHost || dst);
    if (!match) continue;
    threats.push({
      ip: dst,
      host: hostOrNull(dst, dstHost),
      connections: Number(cnt) || 0,
      level: match.confidence === 'low' ? 'warn' : 'danger',
      source: match.source ? String(match.source).slice(0, 60) : null,
      tag: match.tag ? String(match.tag).slice(0, 60) : null,
      devices: [],
    });
  }
  threats.sort((a, b) => (a.level === b.level
    ? b.connections - a.connections
    : (a.level === 'danger' ? -1 : 1)));
  const top = threats.slice(0, MAX_THREATS);

  const links = typeof history.groupSrcForDstsByTimeRange === 'function'
    ? history.groupSrcForDstsByTimeRange(from, to, top.map(threat => threat.ip))
    : [];
  const devicesByDst = new Map();
  for (const row of links) {
    const list = devicesByDst.get(row.dst) || [];
    if (list.length >= MAX_DEVICES_PER_THREAT) continue;
    const name = String(row.srcDnsName || row.srcMdnsName || '').trim();
    const mac = String(row.srcMac || '').trim();
    list.push({
      ip: row.src,
      name: name ? name.slice(0, 253) : null,
      mac: mac ? mac.slice(0, 32) : null,
      connections: Number(row.cnt) || 0,
    });
    devicesByDst.set(row.dst, list);
  }
  for (const threat of top) threat.devices = devicesByDst.get(threat.ip) || [];
  return top;
}

function buildAiContext({ facts, history, routers, from, to, threatIntel = null }) {
  const services = history.groupServiceByTimeRange(from, to)
    .slice(0, MAX_SERVICES)
    .map(row => ({
      port: Number(row.dport) || 0,
      protocol: String(row.proto || 'unknown').slice(0, 20),
      connections: Number(row.count) || 0,
    }));

  const dstGroups = history.groupDstByTimeRange(from, to);
  const topDestinations = [...dstGroups]
    .sort((a, b) => (Number(b.cnt) || 0) - (Number(a.cnt) || 0))
    .slice(0, MAX_DESTINATIONS)
    .map(row => ({
      ip: row.dst,
      host: hostOrNull(row.dst, row.dstHost),
      connections: Number(row.cnt) || 0,
    }));

  const threats = buildThreats({ dstGroups, threatIntel, history, from, to });

  return {
    schemaVersion: 2,
    range: facts.range,
    previousRange: facts.previousRange,
    collection: {
      health: facts.collection.health,
      enabledRouters: facts.collection.enabledCount,
      readyRouters: facts.collection.readyCount,
      routerKinds: routerKinds(routers),
    },
    current: facts.current,
    previous: facts.previous,
    topServices: services,
    topDestinations,
    threats,
    privacy: {
      anonymized: false,
      includes: ['ip', 'hostname', 'deviceName', 'mac'],
      excluded: ['credentials', 'rawLogs', 'routerAddress'],
    },
  };
}

// Backwards-compatible alias: the previous name implied anonymization, which no
// longer holds. Kept so existing imports keep working.
const buildAnonymousAiContext = buildAiContext;

module.exports = {
  buildAiContext,
  buildAnonymousAiContext,
  routerKinds,
  MAX_SERVICES,
  MAX_DESTINATIONS,
  MAX_THREATS,
};
