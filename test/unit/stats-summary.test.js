'use strict';

// Unit tests for three pure transformation functions in public/js/stats.js:
//   statsTargetRows      — normalises summary.byTarget / byDst into a uniform row shape
//   appSlicesFromSummary — aggregates app groups into [label, count] slices
//   mapPointsFromSummary — converts byLocation entries into map-point objects
//
// stats.js has heavy DOM/D3/SVG setup at the top level.  We slice only the three
// target functions (from statsTargetRows up to updateMapCoverageNotice) and run
// them in a vm context with lightweight stubs for t() and guessApp().
// Run: node --test test/unit/stats-summary.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const root   = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public/js/stats.js'), 'utf8');

const start = source.indexOf('function statsTargetRows');
const end   = source.indexOf('function updateMapCoverageNotice');
assert.notEqual(start, -1, 'function statsTargetRows not found');
assert.notEqual(end,   -1, 'function updateMapCoverageNotice not found');

const fnSrc = source.slice(start, end);

function load({ tStub = k => k, guessAppStub = () => '' } = {}) {
  const ctx = vm.createContext({
    Map, Number, Math,
    t: tStub,
    guessApp: guessAppStub,
  });
  vm.runInContext(fnSrc, ctx);
  return ctx;
}

const { statsTargetRows, mapPointsFromSummary } = load();

// ─── statsTargetRows ──────────────────────────────────────────────────────────

describe('statsTargetRows', () => {
  it('returns [] for empty summary', () => {
    assert.equal(statsTargetRows({}).length, 0);
    assert.equal(statsTargetRows({ byTarget: [], byDst: [] }).length, 0);
  });

  it('uses byTarget when present', () => {
    const rows = statsTargetRows({
      byTarget: [{ key: 'google.com', label: 'Google', count: 5 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key,   'google.com');
    assert.equal(rows[0].label, 'Google');
    assert.equal(rows[0].count, 5);
  });

  it('falls back to byDst when byTarget is absent', () => {
    const rows = statsTargetRows({
      byDst: [{ org: 'Cloudflare', dst: '1.1.1.1', count: 3 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key,   'Cloudflare');
    assert.equal(rows[0].count, 3);
  });

  it('byDst falls back to dstHost then dst for label', () => {
    const rows = statsTargetRows({
      byDst: [{ dstHost: 'example.com', dst: '93.184.216.34', count: 2 }],
    });
    assert.equal(rows[0].key, 'example.com');
  });

  it('filters out rows with count === 0', () => {
    const rows = statsTargetRows({
      byTarget: [
        { key: 'a', label: 'A', count: 1 },
        { key: 'b', label: 'B', count: 0 },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'a');
  });

  it('filters out rows with no key', () => {
    const rows = statsTargetRows({
      byTarget: [{ key: '', label: '', count: 5 }],
    });
    assert.equal(rows.length, 0);
  });
});

// ─── appSlicesFromSummary ─────────────────────────────────────────────────────

describe('appSlicesFromSummary', () => {
  it('returns [] for empty groups', () => {
    const ctx = load();
    const result = JSON.parse(JSON.stringify(ctx.appSlicesFromSummary([], 8)));
    assert.deepEqual(result, []);
  });

  it('aggregates groups with the same app label', () => {
    const ctx = load();
    const groups = [
      { app: 'HTTPS', count: 3 },
      { app: 'HTTPS', count: 2 },
      { app: 'DNS',   count: 1 },
    ];
    const result = JSON.parse(JSON.stringify(ctx.appSlicesFromSummary(groups, 8)));
    const https = result.find(([l]) => l === 'HTTPS');
    assert.ok(https, 'HTTPS slice missing');
    assert.equal(https[1], 5);
  });

  it('sorts slices by count descending', () => {
    const ctx = load();
    const groups = [
      { app: 'SSH',   count: 1 },
      { app: 'HTTPS', count: 5 },
      { app: 'DNS',   count: 3 },
    ];
    const result = JSON.parse(JSON.stringify(ctx.appSlicesFromSummary(groups, 8)));
    assert.equal(result[0][0], 'HTTPS');
    assert.equal(result[1][0], 'DNS');
    assert.equal(result[2][0], 'SSH');
  });

  it('groups beyond topN are collapsed into an Other slice', () => {
    const ctx = load({ tStub: k => k === 'stats.legend.other' ? 'Other' : k });
    const groups = [
      { app: 'A', count: 5 },
      { app: 'B', count: 4 },
      { app: 'C', count: 3 },
    ];
    const result = JSON.parse(JSON.stringify(ctx.appSlicesFromSummary(groups, 2)));
    assert.equal(result.length, 3); // A, B, Other
    const other = result.find(([l]) => l === 'Other');
    assert.ok(other, 'Other slice missing');
    assert.equal(other[1], 3);
  });

  it('falls back to guessApp when g.app is absent', () => {
    const ctx = load({ guessAppStub: () => 'HTTPS' });
    const groups = [{ dport: 443, proto: 'TCP', count: 2 }];
    const result = JSON.parse(JSON.stringify(ctx.appSlicesFromSummary(groups, 8)));
    const https = result.find(([l]) => l === 'HTTPS');
    assert.ok(https, 'expected guessApp fallback to HTTPS');
    assert.equal(https[1], 2);
  });
});

// ─── mapPointsFromSummary ─────────────────────────────────────────────────────

describe('mapPointsFromSummary', () => {
  it('returns [] for empty or missing byLocation', () => {
    assert.equal(mapPointsFromSummary({}).length, 0);
    assert.equal(mapPointsFromSummary({ byLocation: [] }).length, 0);
  });

  it('filters out entries without lat/lon', () => {
    const summary = {
      byLocation: [
        { lat: 35.6895, lon: 139.6917, org: 'NTT', totalSessions: 1 },
        { lat: null, lon: null, org: 'Unknown' },
        { org: 'NoCoords' },
      ],
    };
    const result = mapPointsFromSummary(summary);
    assert.equal(result.length, 1);
    assert.equal(result[0].org, 'NTT');
  });

  it('converts lat/lon to Numbers', () => {
    const summary = {
      byLocation: [{ lat: '35.6895', lon: '139.6917', org: 'X', totalSessions: 0 }],
    };
    const result = mapPointsFromSummary(summary);
    assert.equal(typeof result[0].lat, 'number');
    assert.equal(typeof result[0].lon, 'number');
    assert.ok(Math.abs(result[0].lat - 35.6895) < 0.0001);
  });

  it('calculates freshness clamped to [0.15, 1.0]', () => {
    const hi = mapPointsFromSummary({
      byLocation: [{ lat: 0, lon: 0, org: 'A', maxTtl: 9999 }],
    });
    assert.ok(hi[0].freshness <= 1.0);

    const lo = mapPointsFromSummary({
      byLocation: [{ lat: 0, lon: 0, org: 'B', maxTtl: 0 }],
    });
    assert.ok(lo[0].freshness >= 0.15);
  });

  it('uses key field when org is absent', () => {
    const summary = {
      byLocation: [{ lat: 1, lon: 2, key: 'my-org', totalSessions: 3 }],
    };
    const result = mapPointsFromSummary(summary);
    assert.equal(result[0].org, 'my-org');
    assert.equal(result[0].key, 'my-org');
  });

  it('initialises srcs as an empty Map', () => {
    const summary = {
      byLocation: [{ lat: 1, lon: 2, org: 'Z', totalSessions: 0 }],
    };
    const result = mapPointsFromSummary(summary);
    assert.ok(result[0].srcs instanceof Map);
    assert.equal(result[0].srcs.size, 0);
  });

  it('sets totalSessions from the source record', () => {
    const summary = {
      byLocation: [{ lat: 1, lon: 2, org: 'T', totalSessions: 42 }],
    };
    const result = mapPointsFromSummary(summary);
    assert.equal(result[0].totalSessions, 42);
  });
});
