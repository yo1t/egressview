'use strict';

// AI analysis context builder.
//
// This context is NOT anonymized: destination IPs/hostnames and source device
// IPs/names/MACs and bounded device/topology summaries are included so the model
// can produce actionable guidance. What is still excluded: credentials, user
// notes, raw per-connection logs, and router or mesh-node management addresses.
// The consent/privacy UI copy reflects this boundary.

const runtimeProfiler = require('./runtime-profiler');

const MAX_SERVICES = 20;
const MAX_DESTINATIONS = 15;
const MAX_THREATS = 40;
const MAX_DEVICES_PER_THREAT = 5;
const MAX_DEVICE_INVENTORY = 30;
const MAX_NETWORK_NODES = 10;
const MAX_DEVICES_PER_NODE = 5;
const MAX_CONTEXT_BYTES = 48 * 1024;

function textOrNull(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeMac(value) {
  return String(value || '').trim().toUpperCase();
}

function splitSources(value) {
  return [...new Set(String(value || '').split(',')
    .map(source => source.trim().slice(0, 40)).filter(Boolean))].slice(0, 10);
}

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

// Classify grouped destinations into prioritized threats (danger before warn).
function rankThreats(dstGroups, threatIntel) {
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
  return threats.slice(0, MAX_THREATS);
}

// Attach the source devices that contacted each threat destination.
function attachThreatDevices(top, links) {
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

function deviceName(row) {
  return textOrNull(
    row.asusName || row.dnsName || row.mdnsName || row.netbiosName
      || row.srcDnsName || row.srcMdnsName,
    253
  );
}

function deviceInventory({ activity, devices, sourceScope = null }) {
  const known = typeof devices?.getAll === 'function' ? devices.getAll() : [];
  const knownByIp = new Map();
  const knownByMac = new Map();
  for (const row of known) {
    if (row.ip) knownByIp.set(String(row.ip), row);
    const mac = normalizeMac(row.mac);
    if (mac) knownByMac.set(mac, row);
  }

  const result = [];
  const included = new Set();
  const add = (knownRow, activityRow = null) => {
    if (result.length >= MAX_DEVICE_INVENTORY) return;
    const ip = textOrNull(knownRow?.ip || activityRow?.src, 45);
    const mac = textOrNull(knownRow?.mac || activityRow?.srcMac, 32);
    const key = `${ip || ''}|${normalizeMac(mac)}`;
    if (!ip && !mac || included.has(key)) return;
    included.add(key);
    result.push({
      ip,
      mac,
      name: deviceName({ ...activityRow, ...knownRow }),
      vendor: textOrNull(knownRow?.vendor || activityRow?.srcVendor, 120),
      ipv6: textOrNull(knownRow?.ipv6Addr, 80),
      firstSeen: Number(knownRow?.firstSeen ?? activityRow?.firstSeen) || null,
      lastSeen: Number(activityRow?.lastSeen ?? knownRow?.lastSeen) || null,
      sources: splitSources(knownRow?.sources),
      status: textOrNull(knownRow?.status, 40),
      activeInRange: Boolean(activityRow),
      connections: Number(activityRow?.count) || 0,
    });
  };

  for (const row of activity) {
    const knownRow = knownByIp.get(String(row.src || '')) || knownByMac.get(normalizeMac(row.srcMac));
    add(knownRow, row);
  }
  // A selected source may only expose devices backed by that source's
  // observations. Inventory rows without source provenance stay All-only.
  if (!sourceScope) {
    for (const row of known) add(row);
  }

  return {
    totalKnown: known.length,
    includedActiveInRange: activity.length,
    included: result.length,
    devices: result,
  };
}

function buildNetworkTopology(asus) {
  const clients = typeof asus?.getClients === 'function' ? asus.getClients() : [];
  const meshNodes = typeof asus?.getMeshNodes === 'function' ? asus.getMeshNodes() : [];
  if (!clients.length && !meshNodes.length) return null;

  const clientsByParent = new Map();
  for (const client of clients) {
    const parent = normalizeMac(client.amesh_papMac);
    if (!parent) continue;
    const group = clientsByParent.get(parent) || [];
    group.push(client);
    clientsByParent.set(parent, group);
  }
  const nodes = meshNodes.slice(0, MAX_NETWORK_NODES).map(node => {
    const attached = clientsByParent.get(normalizeMac(node.mac)) || [];
    return {
      name: textOrNull(node.alias, 80),
      model: textOrNull(node.model, 80),
      mac: textOrNull(node.mac, 32),
      online: Boolean(node.online),
      connectedDevices: attached.length,
      sampleDevices: attached.slice(0, MAX_DEVICES_PER_NODE).map(client => ({
        ip: textOrNull(client.ip, 45),
        mac: textOrNull(client.mac, 32),
        name: textOrNull(client.name || client.dnsName || client.mdnsName, 120),
        vendor: textOrNull(client.vendor, 120),
        type: textOrNull(client.type, 20),
        rssi: Number.isFinite(Number(client.rssi)) ? Number(client.rssi) : null,
      })),
    };
  });
  const assigned = new Set(nodes.map(node => normalizeMac(node.mac)));
  const unassignedDevices = clients.filter(client => !assigned.has(normalizeMac(client.amesh_papMac))).length;
  return {
    source: 'asus',
    totalNodes: meshNodes.length,
    includedNodes: nodes.length,
    totalOnlineDevices: clients.length,
    unassignedDevices,
    nodes,
  };
}

function fitContextToByteLimit(context) {
  const bytes = () => Buffer.byteLength(JSON.stringify(context));
  // Reserve a five-digit value before trimming so recording the final size
  // cannot push an otherwise valid context over the limit.
  context.limits.serializedBytes = MAX_CONTEXT_BYTES;
  while (bytes() > MAX_CONTEXT_BYTES) {
    const threatWithDevices = [...context.threats].reverse().find(threat => threat.devices.length);
    if (threatWithDevices) {
      threatWithDevices.devices.pop();
      continue;
    }
    const nodeWithSamples = [...(context.networkTopology?.nodes || [])]
      .reverse().find(node => node.sampleDevices.length);
    if (nodeWithSamples) {
      nodeWithSamples.sampleDevices.pop();
      continue;
    }
    if (context.deviceInventory.devices.length > 10) {
      context.deviceInventory.devices.pop();
      context.deviceInventory.included = context.deviceInventory.devices.length;
      continue;
    }
    if (context.threats.length > 10) {
      context.threats.pop();
      continue;
    }
    if (context.topDestinations.length > 5) {
      context.topDestinations.pop();
      continue;
    }
    break;
  }
  context.limits.serializedBytes = bytes();
  context.limits.serializedBytes = bytes();
  return context;
}

// The reads a context needs, in the order it needs them. `read(fn, ...args)`
// is either the history module on this thread or the history reader, which
// runs them on the read thread (P3-190): the scheduled AI notification built
// its context on the thread that answers every request, and held it for
// 0.65-0.71 s every morning at 09:00.
function contextReads({ read, from, to, threatIntel, sourceScope }) {
  return {
    services: () => read('groupServiceByTimeRange', from, to, { sourceScope }),
    dstGroups: () => read('groupDstByTimeRange', from, to, { sourceScope }),
    threatLinks: (top) => (top.length
      ? read('groupSrcForDstsByTimeRange', from, to, top.map(threat => threat.ip), { sourceScope })
      : []),
    activity: () => read('groupSrcByTimeRange', from, to, MAX_DEVICE_INVENTORY, { sourceScope }),
    rank: (dstGroups) => rankThreats(dstGroups, threatIntel),
  };
}

function assembleAiContext({
  facts, routers, devices, asus, sourceScope, services, dstGroups, threats, activity,
}) {
  const topServices = services
    .slice(0, MAX_SERVICES)
    .map(row => ({
      port: Number(row.dport) || 0,
      protocol: String(row.proto || 'unknown').slice(0, 20),
      connections: Number(row.count) || 0,
    }));
  const topDestinations = [...dstGroups]
    .sort((a, b) => (Number(b.cnt) || 0) - (Number(a.cnt) || 0))
    .slice(0, MAX_DESTINATIONS)
    .map(row => ({
      ip: row.dst,
      host: hostOrNull(row.dst, row.dstHost),
      connections: Number(row.cnt) || 0,
    }));
  const deviceInventoryResult = deviceInventory({ activity, devices, sourceScope });
  // ASUS topology has no routerId/agentId provenance, so presenting it in a
  // scoped prompt would mix global devices into the selected source.
  const networkTopology = sourceScope ? null : buildNetworkTopology(asus);

  return fitContextToByteLimit({
    schemaVersion: 3,
    sourceScope,
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
    topServices,
    topDestinations,
    threats,
    deviceInventory: deviceInventoryResult,
    networkTopology,
    limits: {
      deviceInventory: MAX_DEVICE_INVENTORY,
      networkNodes: MAX_NETWORK_NODES,
      sampleDevicesPerNode: MAX_DEVICES_PER_NODE,
      contextBytes: MAX_CONTEXT_BYTES,
    },
    privacy: {
      anonymized: false,
      includes: ['ip', 'hostname', 'deviceName', 'mac', 'vendor', 'deviceInventory', 'networkTopology'],
      excluded: ['credentials', 'userNotes', 'rawLogs', 'routerAddress', 'nodeManagementAddress', 'archivedDevices'],
    },
  });
}

/**
 * Build the context on this thread, straight from the history module.
 * Kept for callers without a reader; the routes and the notifications use
 * buildAiContextAsync.
 */
function buildAiContext({
  facts, history, routers = [], from, to, threatIntel = null, devices = null, asus = null, sourceScope = null,
}) {
  const read = (fn, ...args) => (typeof history[fn] === 'function' ? history[fn](...args) : []);
  const reads = contextReads({ read, from, to, threatIntel, sourceScope });
  const dstGroups = reads.dstGroups();
  const top = reads.rank(dstGroups);
  return assembleAiContext({
    facts, routers, devices, asus, sourceScope,
    services: reads.services(),
    dstGroups,
    threats: attachThreatDevices(top, reads.threatLinks(top)),
    activity: reads.activity(),
  });
}

/** The same context, with every query going through `read` (P3-190). */
async function buildAiContextAsync({
  facts, read, routers = [], from, to, threatIntel = null, devices = null, asus = null, sourceScope = null,
}) {
  const reads = contextReads({ read, from, to, threatIntel, sourceScope });
  const services = await reads.services();
  const dstGroups = await reads.dstGroups();
  const top = runtimeProfiler.measureSync('aiContext.rankThreats', () => reads.rank(dstGroups));
  const links = await reads.threatLinks(top);
  const activity = await reads.activity();
  return runtimeProfiler.measureSync('aiContext.assemble', () => assembleAiContext({
    facts, routers, devices, asus, sourceScope, services, dstGroups,
    threats: attachThreatDevices(top, links),
    activity,
  }));
}

// Backwards-compatible alias: the previous name implied anonymization, which no
// longer holds. Kept so existing imports keep working.
const buildAnonymousAiContext = buildAiContext;

module.exports = {
  buildAiContext,
  buildAiContextAsync,
  buildAnonymousAiContext,
  routerKinds,
  MAX_SERVICES,
  MAX_DESTINATIONS,
  MAX_THREATS,
  MAX_DEVICE_INVENTORY,
  MAX_NETWORK_NODES,
  MAX_DEVICES_PER_NODE,
  MAX_CONTEXT_BYTES,
};
