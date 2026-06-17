// Unit tests for browser-side time-filter data merging.
// These run the frontend files in a small VM with DOM/fetch stubs.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

function loadTimeFilterVm(apiConnections = []) {
  const files = [
    'public/js/connections-panel.js',
    'public/js/time-filter.js',
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

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
    apiFetch: async () => ({
      ok: true,
      json: async () => ({ connections: apiConnections, serverTime: Date.now() }),
    }),
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
});
