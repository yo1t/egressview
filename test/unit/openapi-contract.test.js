'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

  it('既定で保護され、公開routeだけが自ら開いていると宣言する', () => {
    // A route added without a security block inherits protection rather than
    // being described as open. The empty list on the public ten is the only
    // way OpenAPI has to override that, which is why ASH's rule against empty
    // security is suppressed for this file -- and this test is what makes the
    // suppression safe.
    assert.deepEqual(document.security, [{ sessionCookie: [] }, { apiToken: [] }]);
    const open = Object.entries(document.paths)
      .flatMap(([p, item]) => Object.entries(item)
        .filter(([, op]) => op.security.length === 0)
        .map(([m]) => `${m.toUpperCase()} ${p}`))
      .sort();
    const expected = HTTP_ROUTE_MATRIX
      .filter((r) => r.access === ACCESS.PUBLIC)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    assert.deepEqual(open, expected);
  });

  it('資格情報がTLS越しに運ばれると書く', () => {
    // Every credential here is a bearer secret. Describing them without
    // saying so would describe a worse system than the one that exists.
    assert.equal(document.servers.length, 1);
    assert.match(document.servers[0].url, /^https:/);
  });

  it('リクエストボディはサーバが実際に検証したものから来る', () => {
    // Not written by hand: a list tying routes to schemas would go stale the
    // first time a route changed, which is the failure this contract exists
    // to avoid.
    const captured = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'request-schemas.json'), 'utf8')
    ).bodies;
    for (const [route, schema] of Object.entries(captured)) {
      const [method, ...rest] = route.split(' ');
      const operation = document.paths[rest.join(' ')]?.[method.toLowerCase()];
      assert.ok(operation, `${route} is captured but absent from the contract`);
      assert.deepEqual(
        operation.requestBody.content['application/json'].schema, schema
      );
    }
  });

  it('ボディを書いていないoperationはそう言う', () => {
    // Silence would read as "this route takes nothing", which is a different
    // and false claim.
    for (const [p, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (operation.requestBody) continue;
        assert.match(
          operation.description, /The request body is not described here\./,
          `${method.toUpperCase()} ${p} is silent about its body`
        );
      }
    }
  });

  it('ボディの記述が減らない', () => {
    // A ratchet. Coverage comes from what the tests exercise, so it can only
    // fall if a test stops calling a route -- which is worth noticing.
    const described = Object.values(document.paths)
      .flatMap((item) => Object.values(item))
      .filter((operation) => operation.requestBody).length;
    assert.ok(
      described >= 43,
      `only ${described} operations describe a body; it was 43 when this was written`
    );
  });

  it('記述していない範囲を明示する', () => {
    // A contract that silently describes half of what it claims is worse than
    // one that says which half.
    // Response bodies are still undescribed, and the document has to keep
    // saying which half it covers.
    assert.match(document.info.description, /Response bodies are still not described/);
  });
});
