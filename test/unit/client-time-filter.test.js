// Unit tests for browser-side time-filter data merging.
// These run the frontend files in a small VM with DOM/fetch stubs.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

function loadTimeFilterVm(apiConnections = [], options = {}) {
  const files = [
    'public/js/connections-panel.js',
    'public/js/time-filter.js',
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

  const calls = options.calls || [];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: '',
        style: {},
        addEventListener() {},
      });
    }
    return elements.get(id);
  }

  const context = {
    console,
    URLSearchParams,
    document: { getElementById: element },
    _BASE: '',
    apiFetch: options.apiFetch || (async () => ({
      ok: true,
      json: async () => ({ connections: apiConnections, serverTime: Date.now() }),
    })),
    calls,
    asusActive: false,
    logMode: false,
    statsMode: false,
    selectedMac: null,
    nodes: [],
    buildGraphFromConnections: opts => calls.push(['buildGraphFromConnections', opts]),
    updateOrgGraph: opts => calls.push(['updateOrgGraph', opts]),
    scheduleGraphAutoFit: opts => calls.push(['scheduleGraphAutoFit', opts]),
    updateStats: () => calls.push(['updateStats']),
    updateLogView: () => calls.push(['updateLogView']),
    updateConnPanel: ip => calls.push(['updateConnPanel', ip]),
    currentGraphRangeKey: options.currentGraphRangeKey,
    fetchGraphSummary: options.fetchGraphSummary,
    clearGraphSummary: options.clearGraphSummary,
    graphSummary: options.graphSummary,
    graphSummaryKey: options.graphSummaryKey,
  };

  vm.runInNewContext(files, context);
  return context;
}

describe('client time filter fetchConnectionRange', () => {
  it('merges bounded historical ranges without discarding live data', async () => {
    const now = Date.now();
    const live = {
      src: '192.0.2.10', dst: '203.0.113.10', dport: 443, proto: 'TCP',
      firstSeen: now - 10_000, lastSeen: now - 10_000,
    };
    const yesterday = {
      src: '192.0.2.20', dst: '203.0.113.20', dport: 443, proto: 'TCP',
      firstSeen: now - 90_000_000, lastSeen: now - 90_000_000,
    };

    const ctx = loadTimeFilterVm([yesterday]);
    await vm.runInContext(`
      allConnections = [${JSON.stringify(live)}];
      dataRangeFrom = ${now - 86_400_000};
      fetchConnectionRange(${now - 172_800_000}, ${now - 86_400_000});
    `, ctx);

    const result = vm.runInContext(`({
      count: allConnections.length,
      livePresent: allConnections.some(c => c.dst === '203.0.113.10'),
      historicalPresent: allConnections.some(c => c.dst === '203.0.113.20'),
      dataRangeFrom,
    })`, ctx);

    assert.equal(result.count, 2);
    assert.equal(result.livePresent, true);
    assert.equal(result.historicalPresent, true);
    assert.equal(result.dataRangeFrom, now - 86_400_000);
  });

  it('moves continuous loaded range back for open-ended fetches', async () => {
    const now = Date.now();
    const older = {
      src: '192.0.2.30', dst: '203.0.113.30', dport: 443, proto: 'TCP',
      firstSeen: now - 604_800_000, lastSeen: now - 604_800_000,
    };
    const from = now - 1_209_600_000;

    const ctx = loadTimeFilterVm([older]);
    await vm.runInContext(`
      allConnections = [];
      dataRangeFrom = ${now - 86_400_000};
      fetchConnectionRange(${from}, null);
    `, ctx);

    const result = vm.runInContext(`({
      count: allConnections.length,
      dataRangeFrom,
    })`, ctx);

    assert.equal(result.count, 1);
    assert.equal(result.dataRangeFrom, from);
  });

  it('redraws immediately before fetching additional historical data', async () => {
    const now = Date.now();
    let resolveFetch;
    const fetchDone = new Promise(resolve => { resolveFetch = resolve; });
    const calls = [];
    const ctx = loadTimeFilterVm([], {
      calls,
      apiFetch: async url => {
        calls.push(['apiFetch', String(url)]);
        await fetchDone;
        return {
          ok: true,
          json: async () => ({
            connections: [{
              src: '192.0.2.40', dst: '203.0.113.40', dport: 443, proto: 'TCP',
              firstSeen: now - 604_800_000, lastSeen: now - 604_800_000,
            }],
            serverTime: now,
          }),
        };
      },
    });
    vm.runInContext(`
      currentTimeFilter = '7d';
      dataRangeFrom = ${now - 86_400_000};
    `, ctx);
    const pending = vm.runInContext('applyTimeFilter()', ctx);

    assert.equal(calls.filter(c => c[0] === 'buildGraphFromConnections').length, 1);
    assert.equal(calls.some(c => c[0] === 'apiFetch'), true);

    resolveFetch();
    await pending;

    assert.equal(calls.filter(c => c[0] === 'buildGraphFromConnections').length, 2);
  });

  it('does not let an older period-change fetch redraw after a newer change', async () => {
    const now = Date.now();
    let resolveFirstFetch;
    const firstFetchDone = new Promise(resolve => { resolveFirstFetch = resolve; });
    const calls = [];
    const ctx = loadTimeFilterVm([], {
      calls,
      apiFetch: async url => {
        calls.push(['apiFetch', String(url)]);
        await firstFetchDone;
        return { ok: true, json: async () => ({ connections: [], serverTime: now }) };
      },
    });
    vm.runInContext(`
      currentTimeFilter = '14d';
      dataRangeFrom = ${now - 86_400_000};
    `, ctx);
    const older = vm.runInContext('applyTimeFilter()', ctx);
    assert.equal(calls.filter(c => c[0] === 'buildGraphFromConnections').length, 1);

    vm.runInContext("currentTimeFilter = '1h';", ctx);
    await vm.runInContext('applyTimeFilter()', ctx);
    assert.equal(calls.filter(c => c[0] === 'buildGraphFromConnections').length, 2);

    resolveFirstFetch();
    await older;

    assert.equal(calls.filter(c => c[0] === 'buildGraphFromConnections').length, 2);
  });

  it('refreshCurrentTimeFilterView fetches older data before rendering stats for a 2 week period', async () => {
    const now = Date.now();
    const calls = [];
    const ctx = loadTimeFilterVm([], {
      calls,
      apiFetch: async url => {
        calls.push(['apiFetch', String(url)]);
        return {
          ok: true,
          json: async () => ({
            connections: [{
              src: '192.0.2.50', dst: '203.0.113.50', dport: 443, proto: 'TCP',
              firstSeen: now - 10 * 86_400_000, lastSeen: now - 10 * 86_400_000,
            }],
            serverTime: now,
          }),
        };
      },
    });
    vm.runInContext(`
      statsMode = true;
      currentTimeFilter = '14d';
      dataRangeFrom = ${now - 86_400_000};
    `, ctx);

    await vm.runInContext('refreshCurrentTimeFilterView()', ctx);

    assert.equal(calls.some(c => c[0] === 'apiFetch'), true);
    assert.equal(calls.filter(c => c[0] === 'updateStats').length, 2);
    const result = vm.runInContext(`({
      dataRangeFrom,
      visible: getFilteredConnections().some(c => c.dst === '203.0.113.50'),
    })`, ctx);
    assert.equal(result.dataRangeFrom < now - 86_400_000, true);
    assert.equal(result.visible, true);
  });

  it('re-fetches graph summary when returning to a truncated already-loaded period', async () => {
    const now = Date.now();
    const calls = [];
    const ctx = loadTimeFilterVm([], {
      calls,
      currentGraphRangeKey: () => '14d:open',
      apiFetch: async url => {
        calls.push(['apiFetch', String(url)]);
        return {
          ok: true,
          json: async () => ({
            connections: [{
              src: '192.0.2.60', dst: '203.0.113.60', dport: 443, proto: 'TCP',
              firstSeen: now - 10 * 86_400_000, lastSeen: now - 10 * 86_400_000,
            }],
            truncated: true,
            serverTime: now,
          }),
        };
      },
      fetchGraphSummary: async () => {
        calls.push(['fetchGraphSummary']);
        ctx.graphSummary = { total: 100001 };
        ctx.graphSummaryKey = '14d:open';
      },
      clearGraphSummary: () => {
        calls.push(['clearGraphSummary']);
        ctx.graphSummary = null;
        ctx.graphSummaryKey = null;
      },
    });
    vm.runInContext(`
      currentTimeFilter = '14d';
      dataRangeFrom = ${now - 86_400_000};
    `, ctx);

    await vm.runInContext('applyTimeFilter()', ctx);
    vm.runInContext('dataRangeFrom = 0; graphSummary = null; graphSummaryKey = null;', ctx);
    calls.length = 0;

    await vm.runInContext('applyTimeFilter()', ctx);

    assert.equal(calls.filter(c => c[0] === 'apiFetch').length, 0);
    assert.equal(calls.filter(c => c[0] === 'fetchGraphSummary').length, 1);
    assert.equal(calls.filter(c => c[0] === 'buildGraphFromConnections').length, 1);
  });
});
