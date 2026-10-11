'use strict';

const runtimeProfiler = require('./runtime-profiler');

function tallyThreats(groups, threatIntel) {
  let safe = 0;
  let warn = 0;
  let danger = 0;
  for (const { dst, dstHost, cnt } of groups) {
    const threat = threatIntel?.matchThreatIntel(dst, dstHost || dst);
    if (!threat) safe += cnt;
    else if (threat.confidence === 'low') warn += cnt;
    else danger += cnt;
  }
  return { safe, warn, danger };
}

function countThreats(history, threatIntel, from, to, sourceScope = null) {
  return tallyThreats(history.groupDstByTimeRange(from, to, { sourceScope }), threatIntel);
}

function periodFacts(history, threatIntel, from, to, sourceScope = null) {
  return {
    ...history.countFactsByTimeRange(from, to, { sourceScope }),
    ...countThreats(history, threatIntel, from, to, sourceScope),
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

function buildAiFacts({ history, threatIntel, routers, from, to, sourceScope = null, serverTime = Date.now() }) {
  const durationMs = to - from;
  const previousFrom = from - durationMs;
  const previousTo = from;
  return {
    serverTime,
    range: { from, to, durationMs },
    previousRange: { from: previousFrom, to: previousTo, durationMs },
    collection: collectionFacts(routers),
    sourceScope,
    current: periodFacts(history, threatIntel, from, to, sourceScope),
    previous: periodFacts(history, threatIntel, previousFrom, previousTo, sourceScope),
  };
}

async function periodFactsAsync(read, threatIntel, from, to, sourceScope = null) {
  const counts = await read('countFactsByTimeRange', from, to, { sourceScope });
  const groups = await read('groupDstByTimeRange', from, to, { sourceScope });
  // Measured, because it runs on the request thread over every destination
  // in the period, and a stall it caused would otherwise name nothing (P3-190).
  return { ...counts, ...runtimeProfiler.measureSync('aiFacts.tallyThreats', () => tallyThreats(groups, threatIntel)) };
}

/**
 * The same facts, read through `read(fn, ...args)` -- the history reader, so
 * the queries run on the read thread when the server has one (P3-184).
 *
 * Measured on the production Hub on 2026-10-01, seven days scoped to one Mac:
 * 6.3 s, nearly all of it building the agent's unmatched flows twice for the
 * current period, on the thread that answers every request.
 *
 * `openEnded` is for a caller that was not given an upper bound and filled in
 * "now". The current period is then read without one, which is the same rows
 * (nothing is later than now) and lets the agent-scoped queries share one
 * build (history-queries.js). The previous period always has a bound.
 */
async function buildAiFactsAsync({
  read, threatIntel, routers, from, to, openEnded = false, sourceScope = null, serverTime = Date.now(),
}) {
  const durationMs = to - from;
  const previousFrom = from - durationMs;
  const previousTo = from;
  const current = await periodFactsAsync(read, threatIntel, from, openEnded ? null : to, sourceScope);
  const previous = await periodFactsAsync(read, threatIntel, previousFrom, previousTo, sourceScope);
  return {
    serverTime,
    range: { from, to, durationMs },
    previousRange: { from: previousFrom, to: previousTo, durationMs },
    collection: collectionFacts(routers),
    sourceScope,
    current,
    previous,
  };
}

module.exports = {
  buildAiFacts, buildAiFactsAsync, collectionFacts, countThreats, periodFacts, tallyThreats,
};
