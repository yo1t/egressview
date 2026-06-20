// Routes: connection history query
'use strict';

const { Router } = require('express');
const { parseTimestamp } = require('../utils');

const MAX_LIMIT = 1000;

const ALLOWED_SORT_COLS = new Set(['lastSeen', 'src', 'dst', 'dport', 'proto', 'country', 'org']);
const ALLOWED_SORT_DIRS = new Set(['asc', 'desc']);
const ALLOWED_FILTER_MODES = new Set(['contains', 'startsWith', 'endsWith', 'exact']);
// Columns whose filters can be applied server-side (maps to DB columns)
const SERVER_FILTER_COLS = ['src', 'dst', 'dport', 'proto', 'country', 'org'];

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
//                fProto, fProtoMode, fCountry, fCountryMode, fOrg, fOrgMode
// Sort params:   sort (column name), sortDir (asc|desc)
function parsePaginationOpts(query) {
  const sort    = ALLOWED_SORT_COLS.has(query.sort)    ? query.sort    : 'lastSeen';
  const sortDir = ALLOWED_SORT_DIRS.has(query.sortDir) ? query.sortDir : 'desc';

  const filters = {};
  for (const col of SERVER_FILTER_COLS) {
    const capCol = col.charAt(0).toUpperCase() + col.slice(1);
    const value  = query[`f${capCol}`];
    if (value != null && value !== '') {
      const rawMode = query[`f${capCol}Mode`];
      const mode = ALLOWED_FILTER_MODES.has(rawMode) ? rawMode : 'contains';
      filters[col] = { mode, value };
    }
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
    const summary = history.summarizeByTimeRange(from, to);
    res.json({ ...summary, serverTime: Date.now() });
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

    // No limit: return all rows, but still apply sort/filter opts
    const opts = parsePaginationOpts(req.query);
    const connections = attachThreats(
      history.queryByTimeRangePaged(from, to, null, 0, opts), threatIntel
    );
    res.json({ connections, serverTime: Date.now() });
  });

  return router;
}

module.exports = connectionsRoutes;
module.exports._attachThreats = attachThreats;
module.exports._parseTimestampParam = parseTimestampParam;
module.exports._parsePaginationOpts = parsePaginationOpts;
module.exports.MAX_LIMIT = MAX_LIMIT;
module.exports.SERVER_FILTER_COLS = SERVER_FILTER_COLS;
