// Routes: connection history query
'use strict';

const zlib = require('zlib');
const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { parseTimestamp } = require('../utils');
const { streamConnectionExport } = require('../connection-export');
const logger = require('../logger');
const {
  sourceScopeShape, validateSourceScopePair, requireKnownSourceScope,
} = require('../source-scope');

// Send helper for compatibility consumers that request an unpaged response
// (up to 50k rows, 20MB+). The graph uses the bounded summary endpoint.
// The compression middleware's streaming gzip splits the response across many
// event-loop turns, which stretches into tens of seconds on a production
// process that's busy with polling and socket.io broadcasts (measured on EC2:
// streaming 15-50s vs. a single gzipSync call at 0.5s).
// Compressing once up front at level 1 (~80ms for 20MB) keeps it a single
// write while still cutting bandwidth. Setting Content-Encoding here means
// the compression middleware won't compress it again.
const GZIP_MIN_BYTES = 100_000;
function sendLargeJson(req, res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.set('Content-Type', 'application/json; charset=utf-8');
  if (body.length >= GZIP_MIN_BYTES && /\bgzip\b/i.test(req.headers?.['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip');
    return res.end(zlib.gzipSync(body, { level: 1 }));
  }
  res.end(body);
}

const MAX_LIMIT = 1000;
// Cap for the no-limit compatibility path. A synchronous better-sqlite3
// .all() + JSON.stringify on 100k+ rows blocks the Node.js event loop for
// several seconds, delaying Socket.IO heartbeats and router polling.
const MAX_FULL_FETCH = 50_000;

const ALLOWED_SORT_COLS = new Set(['lastSeen', 'src', 'dst', 'dport', 'proto', 'country', 'org']);
const ALLOWED_SORT_DIRS = new Set(['asc', 'desc']);
const ALLOWED_FILTER_MODES = new Set(['contains', 'startsWith', 'endsWith', 'exact']);
// Columns whose filters can be applied server-side (maps to DB columns)
const SERVER_FILTER_COLS = ['src', 'dst', 'dport', 'proto', 'country', 'org', 'srcMac'];
// How long an answer may be served for is decided by what it cost to produce.
//
// A fixed ten seconds looked prudent and was the reason the cache served
// almost nothing: measured on the Hub 2026-09-20, hits=2 misses=393 (1%). The
// dashboard asks for the all-time summary about once a minute, its cache key
// is stable -- `from` and `to` are both null -- and the entry had always
// expired by the time the next request arrived. Every one of those misses
// re-ran five GROUP BY scans of 478,424 rows and blocked the event loop for
// 3.7 seconds.
//
// Caching an expensive answer for longer is the trade the operator wants:
// staleness costs nothing here, and freshness costs the whole Hub two seconds
// of not answering anyone. A cheap answer keeps the short TTL, because there
// is nothing to buy with it.
const SUMMARY_CACHE_MIN_TTL_MS = 10_000;
// Matches the coarsest grid below. A shorter ceiling would expire an answer
// while the key naming it is still in use, which is the `expired=22` that
// measurement found after the grid was fixed.
const SUMMARY_CACHE_MAX_TTL_MS = 5 * 60_000;
// 3.7 seconds of work buys about 110 seconds of reuse; 26 ms buys the minimum.
const SUMMARY_CACHE_TTL_PER_COST_MS = 30;
// How coarse the grid is that a rolling window's key snaps to.
//
// The key, not the TTL, is what decided whether this cache ever served
// anything. Measured on the Hub 2026-09-20 with the miss reasons in hand:
// expired=0, keyNeverSeen=89. The browser sends `from = now - N`, the grid was
// a fixed ten seconds, and the summary is asked for about once a minute, so
// consecutive requests always landed in different cells and no TTL could be
// reached. A grid finer than the request interval can never repeat a key.
//
// Proportional to the window rather than fixed, because the error it
// introduces is an error in where the window starts: five minutes is nothing
// on a fourteen-day view and is the whole of a five-minute one.
// A ladder, not a ratio. Sizing the grid as a fraction of the span was tried
// first and does not work: the span is `now - from`, so it changes with every
// request, the grid changes with it, and the key moves anyway -- the very
// failure this is here to fix. Fixed rungs keep the grid still while the
// window slides across it.
// The rungs sit between the ranges the UI offers, never on one. A boundary
// that a preset lands on is a boundary the window slides across, which puts
// the key back in motion for the most common view of all.
const SUMMARY_CACHE_QUANTUM_LADDER = [
  [20 * 60_000, 10_000],       // live and 15m: keep today's ten seconds
  [2 * 60 * 60_000, 60_000],   // 1h: a minute, against a request a minute apart
  [8 * 60 * 60_000, 180_000],  // 3h and 6h: three minutes
];
const SUMMARY_CACHE_MIN_QUANTUM_MS = 10_000;
const SUMMARY_CACHE_MAX_QUANTUM_MS = 5 * 60_000;
const summaryCache = new Map();
const THREAT_FILTER_SCAN_CHUNK = 1000;

const boundedText = max => z.string().max(max).optional();
const timestampQuery = z.union([
  z.string().max(20),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]).optional();
const unsignedIntegerQuery = z.union([
  z.string().regex(/^\d+$/).max(16),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]).optional();
const timeQueryShape = { from: timestampQuery, to: timestampQuery };
const scopedTimeQueryShape = { ...timeQueryShape, ...sourceScopeShape };
const filterQueryShape = {
  sort: boundedText(32),
  sortDir: boundedText(16),
  fSrc: boundedText(512),
  fSrcMode: boundedText(32),
  fDst: boundedText(512),
  fDstMode: boundedText(32),
  fDport: boundedText(64),
  fDportMode: boundedText(32),
  fProto: boundedText(64),
  fProtoMode: boundedText(32),
  fCountry: boundedText(64),
  fCountryMode: boundedText(32),
  fOrg: boundedText(512),
  fOrgMode: boundedText(32),
  fSrcMac: boundedText(64),
};
const emptyQuerySchema = z.object({}).strict();
const summaryQuerySchema = z.object({
  ...scopedTimeQueryShape,
  buckets: unsignedIntegerQuery,
  src: boundedText(64),
}).strict().superRefine(validateSourceScopePair);
const timeQuerySchema = z.object(timeQueryShape).strict();
const threatConnectionsQuerySchema = z.object({
  ...scopedTimeQueryShape,
  confidence: boundedText(16),
  limit: unsignedIntegerQuery,
}).strict().superRefine(validateSourceScopePair);
const threatCountsQuerySchema = z.object({ ...scopedTimeQueryShape, ...filterQueryShape }).strict().superRefine(validateSourceScopePair);
const exportQuerySchema = z.object({
  ...scopedTimeQueryShape,
  format: z.string().max(8),
}).strict().superRefine(validateSourceScopePair);
const connectionsQuerySchema = z.object({
  ...scopedTimeQueryShape,
  ...filterQueryShape,
  limit: unsignedIntegerQuery,
  offset: unsignedIntegerQuery,
  fThreat: boundedText(16),
}).strict().superRefine(validateSourceScopePair);

/**
 * Rounds a range bound down to the cache TTL so that polls within one TTL
 * share a key. `null` (an open-ended "up to now") is preserved: it already
 * means the same thing on every request.
 */
/**
 * The grid this window's key snaps to, sized from the window itself.
 *
 * A request is only ever answered from cache if another request produced the
 * same key, so the grid has to be coarser than the interval between requests.
 * Sizing it from the span keeps the distortion proportional: a view of the
 * last hour may start up to three minutes early, a view of the last five
 * minutes up to fifteen seconds.
 */
function summaryCacheQuantum(from, to) {
  if (from == null) return SUMMARY_CACHE_MIN_QUANTUM_MS;
  const spanMs = (to ?? Date.now()) - from;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return SUMMARY_CACHE_MIN_QUANTUM_MS;
  for (const [upToMs, quantumMs] of SUMMARY_CACHE_QUANTUM_LADDER) {
    if (spanMs <= upToMs) return quantumMs;
  }
  return SUMMARY_CACHE_MAX_QUANTUM_MS;
}

function quantiseForCache(value, quantumMs = SUMMARY_CACHE_MIN_QUANTUM_MS) {
  if (!Number.isFinite(value)) return value ?? null;
  return Math.floor(value / quantumMs) * quantumMs;
}

/**
 * How often the summary cache answers, reported with the slow-request log.
 *
 * A hit rate near zero is what a broken cache key looks like from outside, and
 * it is not visible any other way: the query is correct, the response is
 * correct, and only the cost is wrong.
 */
const summaryCacheStats = {
  hits: 0,
  misses: 0,
  // Why a miss missed. A hit rate alone says the cache is not working and
  // nothing about which of the two possible reasons it is, and guessing
  // between them cost a wrong fix and a production deploy (P3-139): the TTL
  // was raised on the belief that the key was stable, when the key was moving
  // every quantum and no TTL could ever have been reached.
  expired: 0,
  movingKey: 0,
  // What the misses were asking for, coarsely: enough to tell a one-hour view
  // from an open-ended one, and no timestamps or addresses.
  ranges: {},
  slowestMs: 0,
  slowestRange: null,
  ttlGrantedMs: 0,
};
// Keys seen before, so a miss can say whether this key has ever been cached.
// Bounded: it answers a question about recent traffic, not a log of it.
const summaryKeysSeen = new Map();
const SUMMARY_KEYS_SEEN_LIMIT = 200;

/**
 * How far back a request asked, named coarsely enough to log.
 *
 * No timestamps and no addresses: the operator needs to know whether the
 * expensive misses are a fourteen-day view or something wider, not who asked.
 */
function summaryRangeLabel(from, to) {
  if (from == null && to == null) return 'all';
  if (from == null) return 'open-start';
  const spanMs = (to ?? Date.now()) - from;
  if (spanMs <= 3_600_000) return '<=1h';
  if (spanMs <= 6 * 3_600_000) return '<=6h';
  if (spanMs <= 86_400_000) return '<=24h';
  if (spanMs <= 7 * 86_400_000) return '<=7d';
  if (spanMs <= 14 * 86_400_000) return '<=14d';
  return '>14d';
}

function noteSummaryKeySeen(key) {
  summaryKeysSeen.set(key, Date.now());
  if (summaryKeysSeen.size > SUMMARY_KEYS_SEEN_LIMIT) {
    const oldest = summaryKeysSeen.keys().next().value;
    summaryKeysSeen.delete(oldest);
  }
}

function summaryCacheSnapshot() {
  const total = summaryCacheStats.hits + summaryCacheStats.misses;
  return {
    ...summaryCacheStats,
    ranges: { ...summaryCacheStats.ranges },
    hitRate: total ? summaryCacheStats.hits / total : null,
  };
}

/**
 * How long an answer may be served for: as long as the key that names it.
 *
 * Fixing the grid made keys repeat, and measurement then showed the next
 * problem: hits=36 misses=70, of which expired=22. The grid for that view was
 * three minutes and the answer's TTL was seventy-two seconds, so roughly six
 * tenths of every cell was uncovered and the same window was recomputed
 * inside its own cell. An answer that costs more still earns more, but never
 * less than its own key's lifetime.
 */
function summaryCacheTtl(computeMs, quantumMs = SUMMARY_CACHE_MIN_QUANTUM_MS) {
  const earned = Number.isFinite(computeMs) && computeMs > 0
    ? Math.round(computeMs * SUMMARY_CACHE_TTL_PER_COST_MS)
    : 0;
  const floor = Number.isFinite(quantumMs) && quantumMs > 0
    ? quantumMs
    : SUMMARY_CACHE_MIN_QUANTUM_MS;
  return Math.min(
    SUMMARY_CACHE_MAX_TTL_MS,
    Math.max(SUMMARY_CACHE_MIN_TTL_MS, earned, floor),
  );
}

function getSummaryCache(key) {
  const hit = summaryCache.get(key);
  if (!hit || Date.now() - hit.at > hit.ttlMs) {
    summaryCache.delete(key);
    return null;
  }
  return hit.body;
}

function setSummaryCache(key, body, ttlMs = SUMMARY_CACHE_MIN_TTL_MS) {
  summaryCache.set(key, { at: Date.now(), body, ttlMs });
  if (summaryCache.size > 20) {
    const oldest = summaryCache.keys().next().value;
    summaryCache.delete(oldest);
  }
}

/**
 * Reads that share the same expensive scan, cached on the same terms.
 *
 * Opening the connection log fires several requests at once, and under an agent
 * scope each one rebuilds the same thing: `connectionSource()` unions the
 * agent's uncorrelated observations, grouped per flow, before any LIMIT applies.
 * Measured on the Hub over a 24h window, that CTE costs ~1.9s per execution --
 * and one page view ran it in `/connections` (twice: the page and its total),
 * `/connections/summary`, and `/connections/threat-counts`. better-sqlite3 is
 * synchronous, so those do not overlap; they add up, which is why a single tab
 * took 8-12s while each query on its own looked survivable.
 *
 * The window bound is quantised to the TTL, so requests that arrive together
 * share a key rather than being told apart by their microsecond of arrival.
 * This changes nothing about staleness: the TTL already permits an answer that
 * old. `null` is preserved because "up to now" already means the same thing on
 * every request.
 */
function cachedRead(kind, keyParts, compute, { from = null, to = null } = {}) {
  const key = JSON.stringify({ kind, ...keyParts });
  const cached = getSummaryCache(key);
  if (cached) {
    summaryCacheStats.hits += 1;
    return { body: cached, cached: true };
  }
  summaryCacheStats.misses += 1;
  // A key this process has served before and lost means the TTL ran out. A key
  // it has never seen means the key itself moved, and no TTL would have helped.
  summaryCacheStats[summaryKeysSeen.has(key) ? 'expired' : 'movingKey'] += 1;
  const label = summaryRangeLabel(from, to);
  summaryCacheStats.ranges[label] = (summaryCacheStats.ranges[label] || 0) + 1;

  const startedAt = Date.now();
  const body = compute();
  const computeMs = Date.now() - startedAt;
  const ttlMs = summaryCacheTtl(computeMs, summaryCacheQuantum(from, to));
  if (computeMs > summaryCacheStats.slowestMs) {
    summaryCacheStats.slowestMs = computeMs;
    summaryCacheStats.slowestRange = label;
    summaryCacheStats.ttlGrantedMs = ttlMs;
  }
  setSummaryCache(key, body, ttlMs);
  noteSummaryKeySeen(key);
  return { body, cached: false };
}

function attachThreats(connections, threatIntel) {
  if (!threatIntel || typeof threatIntel.matchThreatIntel !== 'function') return connections;
  return connections.map(c => ({
    ...c,
    threat: threatIntel.matchThreatIntel(c.dst, c.dstHost || c.dst) || null,
  }));
}

function attachApplications(connections, history, sourceScope, from, to) {
  if (typeof history.attachAgentAttributions !== 'function') return connections;
  return history.attachAgentAttributions(connections, { sourceScope, from, to });
}

function matchesThreatFilter(row, fThreat) {
  if (!fThreat) return true;
  if (fThreat === 'safe')   return !row.threat;
  if (fThreat === 'warn')   return row.threat && row.threat.confidence === 'low';
  if (fThreat === 'danger') return row.threat && row.threat.confidence !== 'low';
  return true;
}

function queryThreatFilteredPage(history, threatIntel, from, to, limit, offset, opts, fThreat) {
  const requestedLimit = limit == null ? null : Math.max(0, limit);
  const requestedOffset = Math.max(0, offset || 0);
  const out = [];
  let total = 0;
  let scanned = 0;
  let truncated = false;

  while (true) {
    const rows = attachThreats(
      history.queryByTimeRangePaged(from, to, THREAT_FILTER_SCAN_CHUNK, scanned, opts),
      threatIntel
    );
    if (!rows.length) break;

    for (const row of rows) {
      if (!matchesThreatFilter(row, fThreat)) continue;
      if (total >= requestedOffset && (requestedLimit == null || out.length < requestedLimit)) {
        out.push(row);
      }
      total++;
      if (requestedLimit == null && out.length >= MAX_FULL_FETCH) {
        truncated = true;
        return { connections: out, total, truncated };
      }
    }

    scanned += rows.length;
    if (rows.length < THREAT_FILTER_SCAN_CHUNK) break;
  }

  return { connections: out, total, truncated };
}

function parseTimestampParam(value, name, res) {
  if (value == null || value === '') return { ts: null, err: false };
  const ts = parseTimestamp(value);
  if (ts === null) { res.status(400).json({ error: `invalid "${name}" timestamp` }); return { ts: null, err: true }; }
  return { ts, err: false };
}

// Parse sort/filter params from query string into options for history functions.
// Filter params: fSrc, fSrcMode, fDst, fDstMode, fDport, fDportMode,
//                fProto, fProtoMode, fCountry, fCountryMode, fOrg, fOrgMode,
//                fSrcMac (always exact — no mode param)
// Sort params:   sort (column name), sortDir (asc|desc)
function parsePaginationOpts(query) {
  const sort    = ALLOWED_SORT_COLS.has(query.sort)    ? query.sort    : 'lastSeen';
  const sortDir = ALLOWED_SORT_DIRS.has(query.sortDir) ? query.sortDir : 'desc';

  const filters = {};
  for (const col of SERVER_FILTER_COLS) {
    if (col === 'srcMac') continue; // handled separately below
    const capCol = col.charAt(0).toUpperCase() + col.slice(1);
    const value  = query[`f${capCol}`];
    if (value != null && value !== '') {
      const rawMode = query[`f${capCol}Mode`];
      const mode = ALLOWED_FILTER_MODES.has(rawMode) ? rawMode : 'contains';
      filters[col] = { mode, value };
    }
  }
  // srcMac is always exact match (MAC address format: AA:BB:CC:DD:EE:FF)
  if (query.fSrcMac != null && query.fSrcMac !== '') {
    filters.srcMac = { mode: 'exact', value: query.fSrcMac };
  }

  return { sort, sortDir, filters };
}

/**
 * @param {{ requireAdmin, history, threatIntel?, appState? }} ctx
 */
function connectionsRoutes(ctx) {
  const { requireAdmin, history, threatIntel, routerManager, agentIdentities, appState } = ctx;
  const router = Router();
  const readScope = (query, res) => requireKnownSourceScope(query, { routerManager, agentIdentities }, res);

  router.get('/connections/memory', requireAdmin, (req, res) => {
    const parsed = parseRequest(emptyQuerySchema, req.query, res);
    if (!parsed.ok) return;
    res.json({ ...history.getMemoryStats(), serverTime: Date.now() });
  });

  router.get('/connections/summary', requireAdmin, (req, res) => {
    const parsed = parseRequest(summaryQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const query = parsed.data;
    const scoped = readScope(query, res);
    if (!scoped.ok) return;
    const { ts: from, err: e1 } = parseTimestampParam(query.from, 'from', res);
    if (e1) return;
    const { ts: to, err: e2 } = parseTimestampParam(query.to, 'to', res);
    if (e2) return;
    const bucketsRaw = query.buckets;
    let buckets = 60;
    if (bucketsRaw != null && bucketsRaw !== '') {
      if (!/^\d+$/.test(bucketsRaw))
        return res.status(400).json({ error: 'invalid "buckets" parameter' });
      buckets = Math.max(1, Math.min(240, parseInt(bucketsRaw, 10)));
    }
    const src = query.src || null;
    const sourceScope = scoped.scope;
    // Quantised, because the browser's `from` is `Date.now() - N` and moves
    // every millisecond. With the raw value in the key, every poll of a
    // rolling range ("last hour", "last 14 days") minted a new entry and the
    // cache never once served a request -- measured on production 2026-09-06:
    // 369 responses over three seconds in six hours, every one of them this
    // route, p50 4,427ms, max 15,743ms, against a four-aggregation cost of
    // 7,210ms for the all-time range (P3-67).
    //
    // Rounding to the cache's own TTL changes nothing about how stale an
    // answer may be: the TTL already permits serving one that old. It only
    // stops two requests that would have shared an answer from being told
    // apart by their microsecond of arrival.
    // Counted, because the cache was serving nothing at all and the response's
    // own `cached` field is the only place that said so -- and nobody reads a
    // field on a response nobody kept. Measured 2026-09-06: 369 responses over
    // three seconds in six hours, every one of them this route.
    const summaryQuantum = summaryCacheQuantum(from, to);
    // Which record the chart is drawn from. Default is the observed one; an
    // operator can ask for the original last-seen chart back while the
    // observed record is still filling in (P3-155).
    const timelineSource = appState?.timelineSource === 'lastSeen' ? 'lastSeen' : 'observed';
    const { body: summary, cached } = cachedRead('summary', {
      from: quantiseForCache(from, summaryQuantum),
      to: quantiseForCache(to, summaryQuantum),
      src,
      buckets,
      sourceScope,
      // Part of the cache key: the two settings answer the same question from
      // different records and must not be served each other's answer.
      timelineSource,
    }, () => history.summarizeByTimeRange(from, to, {
      src,
      buckets,
      ...(sourceScope ? { sourceScope } : {}),
      timelineSource,
    }), { from, to });
    res.json({ ...summary, serverTime: Date.now(), cached });
  });

  router.get('/connections/new-nodes', requireAdmin, (req, res) => {
    const parsed = parseRequest(timeQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const { from: fromRaw, to: toRaw } = parsed.data;
    const { ts: from, err: e1 } = parseTimestampParam(fromRaw, 'from', res);
    if (e1) return;
    const { ts: to, err: e2 } = parseTimestampParam(toRaw, 'to', res);
    if (e2) return;
    res.json({ ...history.queryNewNodes(from, to), serverTime: Date.now() });
  });

  router.get('/connections/threat-connections', requireAdmin, (req, res) => {
    const parsed = parseRequest(threatConnectionsQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const query = parsed.data;
    const scoped = readScope(query, res);
    if (!scoped.ok) return;
    const { ts: from, err: e1 } = parseTimestampParam(query.from, 'from', res);
    if (e1) return;
    const { ts: to, err: e2 } = parseTimestampParam(query.to, 'to', res);
    if (e2) return;
    const confidence = ['low', 'high', 'all'].includes(query.confidence) ? query.confidence : 'all';
    const limit = Math.min(parseInt(query.limit, 10) || 50, 200);
    const groups = history.groupDstByTimeRange(from, to, { sourceScope: scoped.scope });
    const hits = [];
    for (const { dst, dstHost, cnt } of groups) {
      const t = threatIntel?.matchThreatIntel(dst, dstHost || dst);
      if (!t) continue;
      if (confidence === 'low'  && t.confidence !== 'low')  continue;
      if (confidence === 'high' && t.confidence !== 'high') continue;
      hits.push({
        dst,
        host: dstHost || null,
        sessions: cnt,
        confidence: t.confidence,
        source: t.source || null,
        tag: t.tag || null,
        matchType: t.matchType || null,
        matchValue: t.matchValue || null,
        url: t.url || null,
        feed: t.feed || t.source || null,
        category: t.category || t.tag || null,
      });
    }
    hits.sort((a, b) => b.sessions - a.sessions);
    const paged = hits.slice(0, limit);
    res.json({ count: paged.length, threats: paged, serverTime: Date.now() });
  });

  router.get('/connections/threat-counts', requireAdmin, (req, res) => {
    const parsed = parseRequest(threatCountsQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const query = parsed.data;
    const scoped = readScope(query, res);
    if (!scoped.ok) return;
    const { ts: from, err: e1 } = parseTimestampParam(query.from, 'from', res);
    if (e1) return;
    const { ts: to, err: e2 } = parseTimestampParam(query.to, 'to', res);
    if (e2) return;
    const { filters } = parsePaginationOpts(query);
    // Threat counts are derived from the same scoped scan the log itself runs,
    // and the tab asks for both at once. Cache the grouping, not the verdicts:
    // the feeds can change between polls and re-matching them is cheap.
    const threatQuantum = summaryCacheQuantum(from, to);
    const { body: groups } = cachedRead('threat-counts', {
      from: quantiseForCache(from, threatQuantum),
      to: quantiseForCache(to, threatQuantum),
      filters,
      sourceScope: scoped.scope,
    }, () => history.groupDstByTimeRange(from, to, { filters, sourceScope: scoped.scope }),
    { from, to });
    let safe = 0, warn = 0, danger = 0;
    for (const { dst, dstHost, cnt } of groups) {
      const threat = threatIntel?.matchThreatIntel(dst, dstHost || dst);
      if (!threat)                          safe   += cnt;
      else if (threat.confidence === 'low') warn   += cnt;
      else                                  danger += cnt;
    }
    res.json({ safe, warn, danger, serverTime: Date.now() });
  });

  router.get('/connections/export', requireAdmin, async (req, res) => {
    const parsed = parseRequest(exportQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const query = parsed.data;
    const scoped = readScope(query, res);
    if (!scoped.ok) return;
    const format = String(query.format || '').toLowerCase();
    if (!['csv', 'json'].includes(format)) {
      return res.status(400).json({ error: 'format must be "csv" or "json"' });
    }
    const { ts: from, err: fromError } = parseTimestampParam(query.from, 'from', res);
    if (fromError) return;
    if (from == null) return res.status(400).json({ error: '"from" timestamp is required' });
    const { ts: requestedTo, err: toError } = parseTimestampParam(query.to, 'to', res);
    if (toError) return;
    const to = requestedTo ?? Date.now();
    if (to < from) return res.status(400).json({ error: '"to" timestamp must not precede "from"' });

    let exportReader;
    try {
      const sourceScope = scoped.scope;
      exportReader = history.createConnectionExportReader?.(from, to, { sourceScope }) || history;
      await streamConnectionExport({ res, history: exportReader, threatIntel, from, to, format });
    } catch (err) {
      logger.error('[connections] Export failed:', err.message);
      if (!res.headersSent) return res.status(500).json({ error: 'Connection export failed' });
      if (!res.destroyed) res.destroy(err);
    } finally {
      exportReader?.close?.();
    }
  });

  router.get('/connections', requireAdmin, (req, res) => {
    const parsed = parseRequest(connectionsQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const query = parsed.data;
    const scoped = readScope(query, res);
    if (!scoped.ok) return;
    const { ts: from, err: e1 } = parseTimestampParam(query.from, 'from', res);
    if (e1) return;
    const { ts: to, err: e2 } = parseTimestampParam(query.to, 'to', res);
    if (e2) return;

    const limitRaw  = query.limit;
    const offsetRaw = query.offset;

    if (limitRaw != null) {
      if (!/^\d+$/.test(limitRaw))
        return res.status(400).json({ error: 'invalid "limit" parameter' });
      const limit = parseInt(limitRaw, 10);
      if (!Number.isFinite(limit) || limit < 0)
        return res.status(400).json({ error: 'invalid "limit" parameter' });
      if (offsetRaw != null && !/^\d+$/.test(offsetRaw))
        return res.status(400).json({ error: 'invalid "offset" parameter' });
      const offset = offsetRaw != null ? parseInt(offsetRaw, 10) : 0;
      if (!Number.isFinite(offset) || offset < 0)
        return res.status(400).json({ error: 'invalid "offset" parameter' });
      const clampedLimit = Math.min(limit, MAX_LIMIT);
      const opts = { ...parsePaginationOpts(query), sourceScope: scoped.scope };
      const fThreat = query.fThreat;
      if (['safe', 'warn', 'danger'].includes(fThreat)) {
        const result = queryThreatFilteredPage(history, threatIntel, from, to, clampedLimit, offset, opts, fThreat);
        return res.json({
          connections: attachApplications(result.connections, history, opts.sourceScope, from, to),
          total: result.total,
          limit: clampedLimit,
          offset,
          serverTime: Date.now(),
        });
      }
      // The total exists to size the pager, and it repeats the page's own scan
      // to produce one number. Paging through a log re-asks it per page with an
      // unchanged answer, so it is cached on the terms that decide it -- window,
      // filters, and scope -- and deliberately not on the page offset.
      const totalQuantum = summaryCacheQuantum(from, to);
      const { body: total } = cachedRead('connections-total', {
        from: quantiseForCache(from, totalQuantum),
        to: quantiseForCache(to, totalQuantum),
        filters: opts.filters,
        sourceScope: opts.sourceScope,
      }, () => history.countByTimeRange(from, to, {
        filters: opts.filters, sourceScope: opts.sourceScope,
      }), { from, to });
      const connections = attachApplications(attachThreats(
        history.queryByTimeRangePaged(from, to, clampedLimit, offset, opts), threatIntel
      ), history, opts.sourceScope, from, to);
      return res.json({ connections, total, limit: clampedLimit, offset, serverTime: Date.now() });
    }

    // No-limit compatibility path. Cap at MAX_FULL_FETCH to prevent
    // blocking the event loop with synchronous SQLite + JSON.stringify on
    // large time ranges (100k+ rows freeze heartbeats and router polling).
    const opts = { ...parsePaginationOpts(query), sourceScope: scoped.scope };
    const fThreat = query.fThreat;
    if (['safe', 'warn', 'danger'].includes(fThreat)) {
      const result = queryThreatFilteredPage(history, threatIntel, from, to, MAX_FULL_FETCH, 0, opts, fThreat);
      return sendLargeJson(req, res, { connections: result.connections, truncated: result.truncated, serverTime: Date.now() });
    }
    let connections = attachThreats(
      history.queryByTimeRangePaged(from, to, MAX_FULL_FETCH, 0, opts), threatIntel
    );
    const truncated = connections.length >= MAX_FULL_FETCH;
    sendLargeJson(req, res, { connections, truncated, serverTime: Date.now() });
  });

  return router;
}

module.exports = connectionsRoutes;
module.exports._attachThreats = attachThreats;
module.exports._attachApplications = attachApplications;
module.exports._matchesThreatFilter = matchesThreatFilter;
module.exports._parseTimestampParam = parseTimestampParam;
module.exports._parsePaginationOpts = parsePaginationOpts;
module.exports.MAX_LIMIT = MAX_LIMIT;
module.exports.SERVER_FILTER_COLS = SERVER_FILTER_COLS;
module.exports.summaryCacheSnapshot = summaryCacheSnapshot;
// The cache is module state, so it outlives any one app instance. That is
// correct in the server, which has exactly one history, and wrong in a test
// process that builds several with different fixtures behind the same key.
module.exports._resetReadCacheForTest = () => {
  summaryCache.clear();
  summaryKeysSeen.clear();
  Object.assign(summaryCacheStats, {
    hits: 0, misses: 0, expired: 0, movingKey: 0,
    ranges: {}, slowestMs: 0, slowestRange: null, ttlGrantedMs: 0,
  });
};
module.exports._sendLargeJson = sendLargeJson;
module.exports._summaryCacheTtl = summaryCacheTtl;
module.exports._summaryRangeLabel = summaryRangeLabel;
// Drops the cached bodies but keeps the memory of which keys were served, so a
// test can produce the expiry case without waiting out a TTL.
module.exports._expireSummaryEntriesForTest = () => { summaryCache.clear(); };
module.exports._summaryCacheQuantum = summaryCacheQuantum;
