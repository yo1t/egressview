'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { build, render, OUTPUT } = require('../../scripts/generate-openapi');
const { ACCESS, HTTP_ROUTE_MATRIX } = require('../../src/permission-matrix');

const committed = fs.readFileSync(OUTPUT, 'utf8');
const document = JSON.parse(committed);

describe('OpenAPI contract', () => {
  it('コミット済みの契約が生成物と一致する', () => {
    // The check that keeps this from going stale. Adding a route without
    // regenerating fails here rather than being noticed by a reader months
    // later -- which is how the hand-written sitemap came to list two URLs for
    // a site serving more than forty pages.
    assert.equal(
      render(build({ version: document.info.version })), committed,
      'docs/openapi.json is out of date; run `npm run docs:openapi`'
    );
  });

  it('permission matrixのrouteを1つも落とさない', () => {
    const described = Object.entries(document.paths)
      .flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`))
      .sort();
    const actual = HTTP_ROUTE_MATRIX
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    assert.deepEqual(described, actual);
  });

  it('公開routeにだけ認証なしを許す', () => {
    // A contract that shows an authenticated route as open would be worse than
    // no contract: it would be a documented invitation.
    for (const route of HTTP_ROUTE_MATRIX) {
      const operation = document.paths[route.path][route.method.toLowerCase()];
      const isOpen = operation.security.length === 0;
      assert.equal(
        isOpen, route.access === ACCESS.PUBLIC,
        `${route.method} ${route.path} is described as ${isOpen ? 'open' : 'protected'}`
      );
    }
  });

  it('必要な権限をscopeとして機械可読に持つ', () => {
    const gated = HTTP_ROUTE_MATRIX.filter((r) => r.access === ACCESS.PERMISSION);
    assert.ok(gated.length > 50, 'expected most routes to be permission gated');
    for (const route of gated) {
      const operation = document.paths[route.path][route.method.toLowerCase()];
      for (const requirement of operation.security) {
        assert.deepEqual(Object.values(requirement)[0], route.permissions);
      }
    }
  });

  it('agent routeはagentの資格情報だけを受け付けると書く', () => {
    // The separate access class is the point: a session cannot reach these and
    // an agent token cannot reach anything else.
    for (const route of HTTP_ROUTE_MATRIX.filter((r) => r.access === ACCESS.AGENT)) {
      const operation = document.paths[route.path][route.method.toLowerCase()];
      assert.deepEqual(operation.security, [{ agentToken: [] }]);
    }
  });

  it('記述していない範囲を明示する', () => {
    // A contract that silently describes half of what it claims is worse than
    // one that says which half.
    assert.match(document.info.description, /access surface, not the payloads/);
  });
});
