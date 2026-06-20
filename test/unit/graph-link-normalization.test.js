'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

function loadGraphLinkHelpers() {
  const source = fs.readFileSync(path.join(root, 'public/js/graph.js'), 'utf8');
  const start = source.indexOf('function linkEndpointId');
  const end = source.indexOf('function buildGraph');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const context = {};
  vm.runInNewContext(source.slice(start, end), context);
  return context;
}

describe('graph link normalization', () => {
  it('converts D3-mutated endpoint objects back to IDs', () => {
    const { normalizeGraphLinks } = loadGraphLinkHelpers();
    const nodes = [{ id: 'client-1' }, { id: '__org__:Example' }];
    const links = [{
      id: 'dev-org:client-1:example',
      source: { id: 'client-1', vx: 1 },
      target: { id: '__org__:Example', vx: 2 },
      ltype: 'dev-org',
    }];

    assert.deepEqual(JSON.parse(JSON.stringify(normalizeGraphLinks(links, nodes))), [{
      id: 'dev-org:client-1:example',
      source: 'client-1',
      target: '__org__:Example',
      ltype: 'dev-org',
    }]);
  });

  it('drops links whose target node was removed during a reset redraw', () => {
    const { normalizeGraphLinks } = loadGraphLinkHelpers();
    const nodes = [{ id: 'client-1' }];
    const links = [{
      id: 'dev-org:client-1:old',
      source: 'client-1',
      target: '__org__:Amazon.com, Inc.',
      ltype: 'dev-org',
    }];

    assert.deepEqual(JSON.parse(JSON.stringify(normalizeGraphLinks(links, nodes))), []);
  });
});
