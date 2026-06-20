// Routes: connection history query
'use strict';

const { Router } = require('express');
const { parseTimestamp } = require('../utils');

const MAX_LIMIT = 1000;
// Cap for the no-limit "full graph fetch" path. A synchronous better-sqlite3
// .all() + JSON.stringify on 100k+ rows blocks the Node.js event loop for
// several seconds, delaying Socket.IO heartbeats and router polling.
const MAX_FULL_FETCH = 50_000;

const ALLOWED_SORT_COLS = new Set(['lastSeen', 'src', 'dst', 'dport', 'proto', 'country', 'org']);
const ALLOWED_SORT_DIRS = new Set(['asc', 'desc']);
const ALLOWED_FILTER_MODES = new Set(['contains', 'startsWith', 'endsWith', 'exact']);
// Columns whose filters can be applied server-side (maps to DB columns)
const SERVER_FILTER_COLS = ['src', 'dst', 'dport', 'proto', 'country', 'org', 'srcMac'];
const SUMMARY_CACHE_TTL_MS = 10_000;
const summaryCache = new Map();

function getSummaryCache(key) {
  const hit = summaryCache.get(key);
  if (!hit || Date.now() - hit.at > SUMMARY_CACHE_TTL_MS) {
    summaryCache.delete(key);
    return null;
  }
  return hit.body;
}

function setSummaryCache(key, body) {
  summaryCache.set(key, { at: Date.now(), body });
  if (summaryCache.size > 20) {
    const oldest = summaryCache.keys().next().value;
    summaryCache.delete(oldest);
  }
}

function attachThreats(connections, threatIntel) {
  if (!threatIntel || typeof threatIntel.matchThreatIntel !== 'function') return connections;
  return connections.map(c => ({
    ...c,
    threat: threatIntel.matchThreatIntel(c.dst, c.dstHost || c.dst) || null,
  }));
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
 * @param {{ requireAdmin, history, threatIntel? }} ctx
 */
function connectionsRoutes(ctx) {
  const { requireAdmin, history, threatIntel } = ctx;
  const router = Router();

  router.get('/connections/summary', requireAdmin, (req, res) => {
    const { ts: from, err: e1 } = parseTimestampParam(req.query.from, 'from', res);
    if (e1) return;
    const { ts: to, err: e2 } = parseTimestampParam(req.query.to, 'to', res);
    if (e2) return;
    const bucketsRaw = req.query.buckets;
    let buckets = 60;
    if (bucketsRaw != null && bucketsRaw !== '') {
      if (!/^\d+$/.test(bucketsRaw))
        return res.status(400).json({ error: 'invalid "buckets" parameter' });
      buckets = Math.max(1, Math.min(240, parseInt(bucketsRaw, 10)));
    }
    const src = req.query.src || null;
    const cacheKey = JSON.stringify({ from, to, src, buckets });
    const cached = getSummaryCache(cacheKey);
    if (cached) return res.json({ ...cached, serverTime: Date.now(), cached: true });
    const summary = history.summarizeByTimeRange(from, to, { src, buckets });
    setSummaryCache(cacheKey, summary);
    res.json({ ...summary, serverTime: Date.now(), cached: false });
  });

  router.get('/connections', requireAdmin, (req, res) => {
    const { ts: from, err: e1 } = parseTimestampParam(req.query.from, 'from', res);
    if (e1) return;
    const { ts: to, err: e2 } = parseTimestampParam(req.query.to, 'to', res);
    if (e2) return;

    const limitRaw  = req.query.limit;
    const offsetRaw = req.query.offset;

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
      const opts = parsePaginationOpts(req.query);
      const total = history.countByTimeRange(from, to, { filters: opts.filters });
      const connections = attachThreats(
        history.queryByTimeRangePaged(from, to, clampedLimit, offset, opts), threatIntel
      );
      return res.json({ connections, total, limit: clampedLimit, offset, serverTime: Date.now() });
    }

    // No-limit path (graph full-fetch). Cap at MAX_FULL_FETCH to prevent
    // blocking the event loop with synchronous SQLite + JSON.stringify on
    // large time ranges (100k+ rows freeze heartbeats and router polling).
    const opts = parsePaginationOpts(req.query);
    const connections = attachThreats(
      history.queryByTimeRangePaged(from, to, MAX_FULL_FETCH, 0, opts), threatIntel
    );
    const truncated = connections.length >= MAX_FULL_FETCH;
    res.json({ connections, truncated, serverTime: Date.now() });
  });

  return router;
}

module.exports = connectionsRoutes;
module.exports._attachThreats = attachThreats;
module.exports._parseTimestampParam = parseTimestampParam;
module.exports._parsePaginationOpts = parsePaginationOpts;
module.exports.MAX_LIMIT = MAX_LIMIT;
module.exports.SERVER_FILTER_COLS = SERVER_FILTER_COLS;
