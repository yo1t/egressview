'use strict';

// Unit tests for normalizeGraphLinks and linkEndpointId (now in graph-helpers.js).
// Run: node --test test/unit/graph-filter.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const root   = path.join(__dirname, '..', '..');
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

const node  = id => ({ id });
const link  = (source, target, extra = {}) => ({ source, target, ...extra });

describe('normalizeGraphLinks', () => {
  it('returns empty array when both inputs are empty', () => {
    assert.deepEqual(normalizeGraphLinks([], []), []);
  });

  it('keeps links whose source and target are in the node set', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const links = [link('a', 'b'), link('b', 'c')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 2);
    assert.equal(result[0].source, 'a');
    assert.equal(result[0].target, 'b');
  });

  it('drops links whose source is not in the node set', () => {
    const nodes = [node('b'), node('c')];
    const links = [link('a', 'b'), link('b', 'c')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'b');
  });

  it('drops links whose target is not in the node set', () => {
    const nodes = [node('a'), node('b')];
    const links = [link('a', 'b'), link('b', 'z')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].target, 'b');
  });

  it('drops all links when no matching nodes exist', () => {
    const nodes = [node('x')];
    const links = [link('a', 'b'), link('c', 'd')];
    assert.deepEqual(normalizeGraphLinks(links, nodes), []);
  });

  it('preserves extra properties on kept links', () => {
    const nodes = [node('a'), node('b')];
    const links = [link('a', 'b', { weight: 5, label: 'test' })];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result[0].weight, 5);
    assert.equal(result[0].label, 'test');
  });

  it('resolves object endpoints to their id property', () => {
    const nodes = [node('a'), node('b')];
    const links = [link({ id: 'a', x: 1 }, { id: 'b', y: 2 })];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'a');
    assert.equal(result[0].target, 'b');
  });

  it('handles mixed object and string endpoints', () => {
    const nodes = [node('a'), node('b')];
    const links = [link({ id: 'a' }, 'b')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'a');
    assert.equal(result[0].target, 'b');
  });

  it('self-loops (source === target) are kept if the node exists', () => {
    const nodes = [node('a')];
    const links = [link('a', 'a')];
    const result = normalizeGraphLinks(links, nodes);
    assert.equal(result.length, 1);
  });
});
