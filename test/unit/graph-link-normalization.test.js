'use strict';

// Regression tests for normalizeGraphLinks (now in graph-helpers.js).
// Run: node --test test/unit/graph-link-normalization.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public/js/graph-helpers.js'), 'utf8');

function load() {
  const exports = {};
  const wrapped = source.replace(/^export function /gm, 'function ')
    .replace(/^export /gm, '');
  const fnNames = [...wrapped.matchAll(/^function (\w+)/gm)].map(m => m[1]);
  const tail = fnNames.map(n => `exports.${n} = ${n};`).join('\n');
  const ctx = { exports };
  vm.runInNewContext(wrapped + '\n' + tail, ctx);
  return ctx.exports;
}

const { normalizeGraphLinks } = load();

describe('graph link normalization', () => {
  it('converts D3-mutated endpoint objects back to IDs', () => {
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
