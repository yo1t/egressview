'use strict';

function countThreats(history, threatIntel, from, to) {
  let safe = 0;
  let warn = 0;
  let danger = 0;
  for (const { dst, dstHost, cnt } of history.groupDstByTimeRange(from, to)) {
    const threat = threatIntel?.matchThreatIntel(dst, dstHost || dst);
    if (!threat) safe += cnt;
    else if (threat.confidence === 'low') warn += cnt;
    else danger += cnt;
  }
  return { safe, warn, danger };
}

function periodFacts(history, threatIntel, from, to) {
  return {
    ...history.countFactsByTimeRange(from, to),
    ...countThreats(history, threatIntel, from, to),
  };
}

function collectionFacts(routers) {
  const enabled = routers.filter(router => router.enabled);
  const ready = enabled.filter(router => router.ready);
  const health = enabled.length === 0 ? 'off'
    : ready.length === enabled.length ? 'ok'
      : ready.length > 0 ? 'partial' : 'error';
  const lastUpdatedAt = ready.reduce(
    (latest, router) => Math.max(latest, Number(router.lastSuccessAt) || 0),
    0
  ) || null;
  return {
    health,
    enabledCount: enabled.length,
    readyCount: ready.length,
    reportedSessions: ready.reduce((total, router) => total + (Number(router.sessionCount) || 0), 0),
    lastUpdatedAt,
    routers: routers.map(router => ({
      id: router.id,
      kind: router.kind,
      displayName: router.displayName,
      enabled: !!router.enabled,
      ready: !!router.ready,
      sessionCount: Number(router.sessionCount) || 0,
      lastSuccessAt: Number(router.lastSuccessAt) || null,
    })),
  };
}

function buildAiFacts({ history, threatIntel, routers, from, to, serverTime = Date.now() }) {
  const durationMs = to - from;
  const previousFrom = from - durationMs;
  const previousTo = from;
  return {
    serverTime,
    range: { from, to, durationMs },
    previousRange: { from: previousFrom, to: previousTo, durationMs },
    collection: collectionFacts(routers),
    current: periodFacts(history, threatIntel, from, to),
    previous: periodFacts(history, threatIntel, previousFrom, previousTo),
  };
}

module.exports = { buildAiFacts, collectionFacts, countThreats, periodFacts };
