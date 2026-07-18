// Unit tests for summary-backed browser time filters.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

function stripEsModule(source) {
  return source
    .replace(/^import\s[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(default\s+)?(function|class|const|let|var)\s/gm, '$2 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}

function loadTimeFilterVm(options = {}) {
  const source = [
    'public/js/connections-panel.js',
    'public/js/time-filter.js',
  ].map(file => stripEsModule(fs.readFileSync(path.join(root, file), 'utf8'))).join('\n');

  const calls = options.calls || [];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id,
        value: '',
        textContent: '',
        classList: {
          add: (...names) => names.forEach(name => classes.add(name)),
          remove: (...names) => names.forEach(name => classes.delete(name)),
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
        },
        addEventListener() {},
        replaceChildren() {},
      });
    }
    return elements.get(id);
  }

  const context = {
    console,
    document: {
      getElementById: element,
      createElement: () => element(`created-${elements.size}`),
      createDocumentFragment: () => ({ appendChild() {} }),
    },
    calls,
    logMode: false,
    statsMode: false,
    selectedMac: null,
    nodes: [],
    buildGraphFromConnections: opts => calls.push(['buildGraphFromConnections', opts]),
    scheduleGraphAutoFit: opts => calls.push(['scheduleGraphAutoFit', opts]),
    updateStats: () => calls.push(['updateStats']),
    updateLogView: () => calls.push(['updateLogView']),
    fetchGraphSummary: options.fetchGraphSummary || (async (from, to) => {
      calls.push(['fetchGraphSummary', from, to]);
      return { total: 1 };
    }),
    t: key => key,
  };

  vm.runInNewContext(source, context);
  return context;
}

describe('summary-backed client time filter', () => {
  it('uses a five-minute range for the detailed live view', () => {
    const context = loadTimeFilterVm();
    vm.runInContext("currentTimeFilter = 'live';", context);
    const range = vm.runInContext('getTimeRange()', context);
    const duration = Date.now() - range.from;
    assert.ok(duration >= 299_000 && duration <= 301_000);
    assert.equal(range.to, null);
  });

  it('keeps a separate fifteen-minute summary range', () => {
    const context = loadTimeFilterVm();
    vm.runInContext("currentTimeFilter = '15m';", context);
    const range = vm.runInContext('getTimeRange()', context);
    const duration = Date.now() - range.from;
    assert.ok(duration >= 899_000 && duration <= 901_000);
    assert.equal(range.to, null);
  });

  it('fetches the graph summary before rendering a selected period', async () => {
    const calls = [];
    const context = loadTimeFilterVm({ calls });
    vm.runInContext("currentTimeFilter = '14d';", context);

    await vm.runInContext('applyTimeFilter()', context);

    assert.equal(calls.filter(call => call[0] === 'fetchGraphSummary').length, 1);
    assert.equal(calls.filter(call => call[0] === 'buildGraphFromConnections').length, 1);
    assert.ok(
      calls.findIndex(call => call[0] === 'fetchGraphSummary')
        < calls.findIndex(call => call[0] === 'buildGraphFromConnections')
    );
  });

  it('does not let an older summary response redraw after a newer period change', async () => {
    let resolveFirst;
    const firstDone = new Promise(resolve => { resolveFirst = resolve; });
    let requestCount = 0;
    const calls = [];
    const context = loadTimeFilterVm({
      calls,
      fetchGraphSummary: async () => {
        requestCount++;
        calls.push(['fetchGraphSummary', requestCount]);
        if (requestCount === 1) await firstDone;
      },
    });

    vm.runInContext("currentTimeFilter = '14d';", context);
    const older = vm.runInContext('applyTimeFilter()', context);
    vm.runInContext("currentTimeFilter = '1h';", context);
    await vm.runInContext('applyTimeFilter()', context);
    assert.equal(calls.filter(call => call[0] === 'buildGraphFromConnections').length, 1);

    resolveFirst();
    await older;
    assert.equal(calls.filter(call => call[0] === 'buildGraphFromConnections').length, 1);
  });

  it('refreshes graph, stats, and log views without loading connection history', async () => {
    const calls = [];
    const context = loadTimeFilterVm({ calls });
    vm.runInContext("currentTimeFilter = '7d'; statsMode = true; logMode = true;", context);

    await vm.runInContext('refreshCurrentTimeFilterView()', context);

    assert.equal(calls.filter(call => call[0] === 'fetchGraphSummary').length, 1);
    assert.equal(calls.filter(call => call[0] === 'updateStats').length, 1);
    assert.equal(calls.filter(call => call[0] === 'updateLogView').length, 1);
  });

  it('contains no unpaged connection-history request', () => {
    const source = fs.readFileSync(path.join(root, 'public/js/time-filter.js'), 'utf8');
    assert.doesNotMatch(source, /\/api\/connections\?(?!summary)/);
    assert.doesNotMatch(source, /fetchConnectionRange/);
  });
});
