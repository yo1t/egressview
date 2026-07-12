'use strict';

// Unit tests for public/js/graph-helpers.js (pure data-transformation helpers).
// These functions are now a standalone ES module; we load them via vm with
// module-level exports shimmed to a plain object.
// Run: node --test test/unit/graph-helpers.test.js

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

const { flagEmoji, meshNodeId, linkEndpointId, normalizeGraphLinks, currentGraphRangeKey, routerTargetsFromSource } = load();

describe('flagEmoji', () => {
  it('converts a 2-letter country code to a flag emoji', () => {
    assert.equal(flagEmoji('JP'), '🇯🇵');
    assert.equal(flagEmoji('US'), '🇺🇸');
  });
  it('returns empty string for missing or wrong-length codes', () => {
    assert.equal(flagEmoji(''), '');
    assert.equal(flagEmoji(null), '');
    assert.equal(flagEmoji('J'), '');
    assert.equal(flagEmoji('JPN'), '');
  });
});

describe('meshNodeId', () => {
  it('wraps a MAC in the mesh-node id form', () => {
    assert.equal(meshNodeId('aa:bb:cc'), '__node_aa:bb:cc__');
  });
});

describe('linkEndpointId', () => {
  it('returns id from object endpoint', () => {
    assert.equal(linkEndpointId({ id: 'foo', x: 1 }), 'foo');
  });
  it('returns string endpoint as-is', () => {
    assert.equal(linkEndpointId('bar'), 'bar');
  });
  it('returns undefined for null endpoint object', () => {
    assert.equal(linkEndpointId(null), undefined);
  });
});

describe('normalizeGraphLinks', () => {
  const node = id => ({ id });
  const link = (source, target, extra = {}) => ({ source, target, ...extra });

  it('returns empty array when both inputs are empty', () => {
    assert.deepEqual(normalizeGraphLinks([], []), []);
  });
  it('keeps links whose source and target are in the node set', () => {
    const result = normalizeGraphLinks([link('a', 'b')], [node('a'), node('b')]);
    assert.equal(result.length, 1);
  });
  it('drops links whose target is not in the node set', () => {
    const result = normalizeGraphLinks([link('a', 'z')], [node('a')]);
    assert.equal(result.length, 0);
  });
  it('resolves object endpoints to their id property', () => {
    const result = normalizeGraphLinks(
      [link({ id: 'a' }, { id: 'b' })],
      [node('a'), node('b')]
    );
    assert.equal(result[0].source, 'a');
    assert.equal(result[0].target, 'b');
  });
});

describe('currentGraphRangeKey', () => {
  it('uses raw from:to when no time filter is active', () => {
    assert.equal(currentGraphRangeKey(100, 200, undefined), '100:200');
    assert.equal(currentGraphRangeKey(null, null, undefined), ':');
  });
  it('custom filter embeds both bounds', () => {
    assert.equal(currentGraphRangeKey(100, 200, 'custom'), 'custom:100:200');
  });
  it('today/yesterday embed the ISO day of "from"', () => {
    const ts = Date.UTC(2026, 0, 2, 3, 4);
    assert.equal(currentGraphRangeKey(ts, 0, 'today'), 'today:2026-01-02:0');
    assert.match(currentGraphRangeKey(ts, '', 'yesterday'), /^yesterday:2026-01-02:/);
  });
  it('other named filters are treated as open-ended', () => {
    assert.equal(currentGraphRangeKey(100, 200, '7d'), '7d:open');
  });
});

describe('routerTargetsFromSource', () => {
  it('returns undefined when isMulti is false', () => {
    assert.equal(routerTargetsFromSource('cisco', false), undefined);
  });
  it('returns __router__ for yamaha source', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(routerTargetsFromSource('yamaha', true))), ['__router__']);
  });
  it('returns __router_cisco__ for cisco source', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(routerTargetsFromSource('cisco', true))), ['__router_cisco__']);
  });
  it('returns both for combined source', () => {
    const result = routerTargetsFromSource('yamaha+cisco', true);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), ['__router__', '__router_cisco__']);
  });
  it('defaults to yamaha when source is empty', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(routerTargetsFromSource('', true))), ['__router__']);
    assert.deepEqual(JSON.parse(JSON.stringify(routerTargetsFromSource(null, true))), ['__router__']);
  });
});
