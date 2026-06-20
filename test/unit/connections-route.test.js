// Unit tests for /api/connections route helpers
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { _attachThreats, _parseTimestampParam, _parsePaginationOpts, MAX_LIMIT, SERVER_FILTER_COLS } = require('../../src/routes/connections');

describe('connections route: attachThreats', () => {
  it('adds threat intel to SQLite/API rows that do not persist threat', () => {
    const rows = [{
      src: '192.168.1.10',
      dst: '203.0.113.10',
      dstHost: 'raw.githubusercontent.com',
      dport: 443,
      proto: 'TCP',
      firstSeen: 1000,
      lastSeen: 2000,
    }];
    const threatIntel = {
      matchThreatIntel(dst, host) {
        assert.equal(dst, '203.0.113.10');
        assert.equal(host, 'raw.githubusercontent.com');
        return {
          source: 'urlhaus',
          tag: 'URLhaus: malware hosted on raw.githubusercontent.com',
          confidence: 'low',
          matchType: 'domain',
          matchValue: 'raw.githubusercontent.com',
        };
      },
    };

    const result = _attachThreats(rows, threatIntel);

    assert.equal(result[0].threat.confidence, 'low');
    assert.equal(result[0].threat.source, 'urlhaus');
  });

  it('sets threat to null when there is no match', () => {
    const result = _attachThreats(
      [{ src: '192.168.1.10', dst: '8.8.8.8', dstHost: 'dns.google' }],
      { matchThreatIntel: () => null }
    );

    assert.equal(result[0].threat, null);
  });

  it('returns rows unchanged (no threat field) when threatIntel is not provided', () => {
    // Regression guard: routeCtx must include threatIntel, otherwise attachThreats
    // early-returns and ALL API responses have threat=undefined (P2-4 regression root cause)
    const rows = [{ src: '192.168.1.10', dst: '203.0.113.10', dstHost: 'raw.githubusercontent.com' }];
    const result = _attachThreats(rows, undefined);
    // Returns the original rows without modification — threat field is absent
    assert.strictEqual(result, rows, 'should return the original array reference');
    assert.equal(result[0].threat, undefined, 'threat field should not be set');
  });
});

// ─── _parseTimestampParam helper ──────────────────────────────────────────────

describe('connections route: _parseTimestampParam', () => {
  function mockRes() {
    const r = { _status: null, _body: null };
    r.status = (code) => { r._status = code; return r; };
    r.json   = (body) => { r._body  = body; return r; };
    return r;
  }

  it('returns { ts: null, err: false } when value is null', () => {
    const res = mockRes();
    const result = _parseTimestampParam(null, 'from', res);
    assert.equal(result.ts, null);
    assert.equal(result.err, false);
    assert.equal(res._status, null, 'should not set response status');
  });

  it('returns { ts: null, err: false } when value is empty string', () => {
    const res = mockRes();
    const result = _parseTimestampParam('', 'from', res);
    assert.equal(result.ts, null);
    assert.equal(result.err, false);
  });

  it('parses a valid Unix ms timestamp', () => {
    const res = mockRes();
    const ts = Date.now();
    const result = _parseTimestampParam(String(ts), 'from', res);
    assert.equal(result.ts, ts);
    assert.equal(result.err, false);
    assert.equal(res._status, null);
  });

  it('returns { ts: null, err: true } and sends 400 for invalid input', () => {
    const res = mockRes();
    const result = _parseTimestampParam('not-a-number', 'from', res);
    assert.equal(result.err, true);
    assert.equal(res._status, 400);
    assert.ok(res._body?.error, 'should include error message');
  });
});

// ─── Pagination constants ─────────────────────────────────────────────────────

describe('connections route: pagination constants', () => {
  it('MAX_LIMIT is a positive integer', () => {
    assert.ok(Number.isInteger(MAX_LIMIT) && MAX_LIMIT > 0, `MAX_LIMIT should be a positive integer, got ${MAX_LIMIT}`);
  });

  it('MAX_LIMIT is at least 200 (usable page size)', () => {
    assert.ok(MAX_LIMIT >= 200, `MAX_LIMIT should be at least 200, got ${MAX_LIMIT}`);
  });
});

// ─── Pagination integration: route handler logic ──────────────────────────────

describe('connections route: GET /connections pagination', () => {
  // Build a minimal route instance and call it directly without an HTTP server

  function makeHistory(rows) {
    return {
      queryByTimeRange:       () => rows,
      queryByTimeRangePaged:  (from, to, limit, offset) => rows.slice(offset, offset + limit),
      countByTimeRange:       () => rows.length,
      summarizeByTimeRange:   () => ({ byDst: [], byDevice: [] }),
    };
  }

  function makeReq(query = {}) {
    return { query };
  }

  function makeRes() {
    const r = { _status: 200, _body: null };
    r.status = (code) => { r._status = code; return r; };
    r.json   = (body) => { r._body  = body; return r; };
    return r;
  }

  const connectionsRoutes = require('../../src/routes/connections');

  function callRoute(rows, query) {
    const router = connectionsRoutes({
      requireAdmin: (_req, _res, next) => next(),
      history: makeHistory(rows),
    });
    // Find the /connections GET handler (not /connections/summary)
    const layer = router.stack.find(l => l.route?.path === '/connections' && l.route?.methods?.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = makeReq(query);
    const res = makeRes();
    handler(req, res);
    return res;
  }

  it('returns connections array without pagination when limit is absent', () => {
    const rows = [{ src: '192.168.1.1', dst: '10.0.0.1', dport: 443, proto: 'TCP' }];
    const res = callRoute(rows, {});
    assert.ok(Array.isArray(res._body.connections));
    assert.equal(res._body.total, undefined, 'total should not be present in non-paged response');
  });

  it('returns paginated response with total, limit, offset when limit is provided', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ src: '192.168.1.1', dst: `10.0.0.${i + 1}`, dport: 80, proto: 'TCP' }));
    const res = callRoute(rows, { limit: '3', offset: '0' });
    assert.equal(res._body.connections.length, 3);
    assert.equal(res._body.total, 10);
    assert.equal(res._body.limit, 3);
    assert.equal(res._body.offset, 0);
  });

  it('applies offset correctly', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ src: '192.168.1.1', dst: `10.0.0.${i + 1}`, dport: 80, proto: 'TCP' }));
    const res = callRoute(rows, { limit: '2', offset: '3' });
    assert.equal(res._body.connections.length, 2);
    assert.equal(res._body.offset, 3);
  });

  it('clamps limit to MAX_LIMIT', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ src: '192.168.1.1', dst: `10.0.0.${i + 1}`, dport: 80, proto: 'TCP' }));
    const res = callRoute(rows, { limit: String(MAX_LIMIT + 9999), offset: '0' });
    assert.equal(res._body.limit, MAX_LIMIT);
  });

  it('returns 400 for non-numeric limit', () => {
    const res = callRoute([], { limit: 'abc' });
    assert.equal(res._status, 400);
    assert.ok(res._body?.error);
  });

  it('returns 400 for negative limit', () => {
    const res = callRoute([], { limit: '-1' });
    assert.equal(res._status, 400);
  });

  it('returns 400 for negative offset', () => {
    const res = callRoute([], { limit: '10', offset: '-5' });
    assert.equal(res._status, 400);
  });

  it('defaults offset to 0 when not provided', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ src: '192.168.1.1', dst: `10.0.0.${i + 1}`, dport: 80, proto: 'TCP' }));
    const res = callRoute(rows, { limit: '10' });
    assert.equal(res._body.offset, 0);
  });
});

// ─── Summary route handler ────────────────────────────────────────────────────

describe('connections route: GET /connections/summary', () => {
  let lastSummaryArgs;
  function makeHistory() {
    return {
      queryByTimeRange:       () => [],
      queryByTimeRangePaged:  () => [],
      countByTimeRange:       () => 0,
      summarizeByTimeRange:   (...args) => {
        lastSummaryArgs = args;
        return {
          byDst:    [{ dst: '10.0.0.1', count: 5 }],
          byDevice: [{ src: '192.168.1.1', count: 5 }],
        };
      },
    };
  }

  function callSummaryRoute(query = {}) {
    lastSummaryArgs = null;
    const connectionsRoutes = require('../../src/routes/connections');
    const router = connectionsRoutes({
      requireAdmin: (_req, _res, next) => next(),
      history: makeHistory(),
    });
    const layer = router.stack.find(l => l.route?.path === '/connections/summary' && l.route?.methods?.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { _status: 200, _body: null };
    res.status = (code) => { res._status = code; return res; };
    res.json   = (body) => { res._body  = body; return res; };
    handler({ query }, res);
    return res;
  }

  it('returns byDst and byDevice arrays', () => {
    const res = callSummaryRoute({});
    assert.ok(Array.isArray(res._body.byDst),    'byDst should be an array');
    assert.ok(Array.isArray(res._body.byDevice), 'byDevice should be an array');
  });

  it('includes serverTime', () => {
    const before = Date.now();
    const res = callSummaryRoute({});
    assert.ok(typeof res._body.serverTime === 'number' && res._body.serverTime >= before);
  });

  it('returns 400 for invalid from timestamp', () => {
    const res = callSummaryRoute({ from: 'bad' });
    assert.equal(res._status, 400);
  });

  it('passes src and buckets options to summary aggregation', () => {
    const res = callSummaryRoute({ src: '192.168.1.10', buckets: '120' });
    assert.equal(res._status, 200);
    assert.deepEqual(lastSummaryArgs[2], { src: '192.168.1.10', buckets: 120 });
  });

  it('returns 400 for invalid buckets', () => {
    const res = callSummaryRoute({ buckets: 'bad' });
    assert.equal(res._status, 400);
  });
});

// ─── _parsePaginationOpts ─────────────────────────────────────────────────────

describe('connections route: _parsePaginationOpts', () => {
  it('defaults to lastSeen DESC with no filters', () => {
    const opts = _parsePaginationOpts({});
    assert.equal(opts.sort,    'lastSeen');
    assert.equal(opts.sortDir, 'desc');
    assert.deepEqual(opts.filters, {});
  });

  it('accepts valid sort column and direction', () => {
    const opts = _parsePaginationOpts({ sort: 'org', sortDir: 'asc' });
    assert.equal(opts.sort,    'org');
    assert.equal(opts.sortDir, 'asc');
  });

  it('falls back to lastSeen for an unknown sort column', () => {
    const opts = _parsePaginationOpts({ sort: 'app', sortDir: 'desc' });
    assert.equal(opts.sort, 'lastSeen', 'unknown column should fall back to lastSeen');
  });

  it('falls back to desc for an unknown sortDir', () => {
    const opts = _parsePaginationOpts({ sort: 'src', sortDir: 'sideways' });
    assert.equal(opts.sortDir, 'desc');
  });

  it('parses fDst filter param', () => {
    const opts = _parsePaginationOpts({ fDst: 'google', fDstMode: 'contains' });
    assert.deepEqual(opts.filters.dst, { mode: 'contains', value: 'google' });
  });

  it('defaults filter mode to contains when mode is absent', () => {
    const opts = _parsePaginationOpts({ fOrg: 'Amazon' });
    assert.equal(opts.filters.org.mode, 'contains');
  });

  it('parses all server-side filter columns', () => {
    const query = {
      fSrc: '192.168', fSrcMode: 'startsWith',
      fDst: 'google',  fDstMode: 'contains',
      fDport: '443',   fDportMode: 'contains',
      fProto: 'TCP',   fProtoMode: 'contains',
      fCountry: 'US',  fCountryMode: 'contains',
      fOrg: 'Amazon',  fOrgMode: 'endsWith',
    };
    const opts = _parsePaginationOpts(query);
    assert.equal(opts.filters.src.value,     '192.168');
    assert.equal(opts.filters.src.mode,      'startsWith');
    assert.equal(opts.filters.dst.value,     'google');
    assert.equal(opts.filters.dport.value,   '443');
    assert.equal(opts.filters.proto.value,   'TCP');
    assert.equal(opts.filters.country.value, 'US');
    assert.equal(opts.filters.org.mode,      'endsWith');
  });

  it('ignores empty string filter values', () => {
    const opts = _parsePaginationOpts({ fDst: '' });
    assert.equal(opts.filters.dst, undefined, 'empty string should not create a filter entry');
  });

  it('SERVER_FILTER_COLS covers expected columns', () => {
    const expected = ['src', 'dst', 'dport', 'proto', 'country', 'org'];
    for (const col of expected) {
      assert.ok(SERVER_FILTER_COLS.includes(col), `${col} should be in SERVER_FILTER_COLS`);
    }
  });
});

// ─── parseTimestampParam ─────────────────────────────────────────────────────

describe('connections route: parseTimestampParam', () => {
  function fakeRes() {
    const r = { code: null, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json   = (b) => { r.body = b; return r; };
    return r;
  }

  it('returns ts for a valid unix ms timestamp', () => {
    const res = fakeRes();
    const { ts, err } = _parseTimestampParam('1700000000000', 'from', res);
    assert.equal(err, false);
    assert.equal(ts, 1700000000000);
  });

  it('returns 400 for a non-numeric value', () => {
    const res = fakeRes();
    const { err } = _parseTimestampParam('notanumber', 'from', res);
    assert.ok(err);
    assert.equal(res.code, 400);
  });

  it('returns 400 for a negative value', () => {
    const res = fakeRes();
    const { err } = _parseTimestampParam('-1', 'from', res);
    assert.ok(err);
    assert.equal(res.code, 400);
  });

  it('returns ts=null and err=false for undefined (optional param omitted)', () => {
    const res = fakeRes();
    const { ts, err } = _parseTimestampParam(undefined, 'from', res);
    assert.equal(ts, null);
    assert.equal(err, false);
  });
});
