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

  it('観測と宣言を取り違えられる書き方をしない', () => {
    // Until 2026-08-24 every response here was an observation, and this test
    // asserted so. Some are now declared by the server (P2-95). The property
    // that matters did not change: a reader must never take one for the other.
    // An observation that lost its marking would read as a promise.
    // Per response, not per route: a route can have a declared 200 and an
    // observed 400, and assuming otherwise is how a document ends up calling
    // an observation a promise.
    let observed = 0;
    let declaredSchemas = 0;
    for (const [p, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const route = `${method.toUpperCase()} ${p}`;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!response.content) continue;
          const schema = response.content['application/json'].schema;
          const claimsDeclared = /Declared by the server/.test(response.description);
          if (claimsDeclared) {
            declaredSchemas += 1;
            assert.equal(
              schema['x-observed'], undefined,
              `${route} ${status} is declared and must not claim to be observed`
            );
          } else {
            observed += 1;
            assert.equal(
              schema['x-observed'], true,
              `${route} ${status} is neither declared nor marked as observed`
            );
            assert.match(response.description, /not a guarantee/);
          }
        }
      }
    }
    assert.ok(observed > 50, `only ${observed} responses carry an observed shape`);
    assert.ok(declaredSchemas > 0, 'no response is declared, so step 2 did nothing');
  });

  it('毎回は返らなかったフィールドをrequiredにしない', () => {
    // The merge is what keeps one lucky example from becoming a promise.
    const { merge, shapeOf } = require('../../src/request-schema-capture');
    const merged = merge(shapeOf({ a: 1, b: 'x' }), shapeOf({ a: 2 }));
    assert.deepEqual(merged.required, ['a']);
    assert.ok('b' in merged.properties);
  });

  it('リクエストの配列には必ず上限がある', () => {
    // What makes the CKV_OPENAPI_21 suppression safe: the rule guards against
    // accepting an unbounded array, and that is a request-side concern. If a
    // request array ever loses its bound, the suppression stops being
    // justified and this fails.
    const uncapped = [];
    const walk = (schema, where) => {
      if (!schema || typeof schema !== 'object') return;
      if (schema.type === 'array' && schema.maxItems == null) uncapped.push(where);
      for (const value of Object.values(schema)) {
        if (value && typeof value === 'object') walk(value, where);
      }
    };
    for (const [p, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (operation.requestBody) walk(operation.requestBody, `${method.toUpperCase()} ${p}`);
      }
    }
    assert.deepEqual(uncapped, [], 'a request body accepts an array with no maximum');
  });

  it('記述していない範囲を明示する', () => {
    // A contract that silently describes half of what it claims is worse than
    // one that says which half.
    // The document has to keep saying which parts are enforced and which are
    // only observed. Losing that line would turn descriptions into promises.
    assert.match(document.info.description, /Request bodies are described for the routes/);
    assert.ok(
      document.info.description.includes('documentation of behaviour, not a promise'),
      'the document stopped saying that observed shapes are not promises'
    );
    assert.ok(
      document.info.description.includes('declared by the server'),
      'the document stopped distinguishing a declaration from an observation'
    );
  });
});
