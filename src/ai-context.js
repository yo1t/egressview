'use strict';

const MAX_SERVICES = 20;

function routerKinds(routers) {
  const counts = {};
  for (const router of routers) {
    if (!router.enabled) continue;
    const kind = String(router.kind || 'unknown').slice(0, 40);
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function buildAnonymousAiContext({ facts, history, routers, from, to }) {
  const services = history.groupServiceByTimeRange(from, to)
    .slice(0, MAX_SERVICES)
    .map(row => ({
      port: Number(row.dport) || 0,
      protocol: String(row.proto || 'unknown').slice(0, 20),
      connections: Number(row.count) || 0,
    }));

  return {
    schemaVersion: 1,
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
    privacy: {
      anonymized: true,
      excluded: ['ip', 'mac', 'deviceName', 'routerAddress', 'credentials', 'rawLogs'],
    },
  };
}

module.exports = { buildAnonymousAiContext, routerKinds, MAX_SERVICES };
