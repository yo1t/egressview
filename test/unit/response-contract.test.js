'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const {
  BOUNDED_ARRAY_LIMIT,
  MODES,
  NEVER_ENFORCED,
  classifyResponse,
  createResponseContractDiagnostics,
  createResponseContractRegistry,
  isNeverEnforced,
  routeKey,
} = require('../../src/response-contract');

const schema = z.object({ success: z.boolean() });

describe('レスポンス契約の登録簿（P2-95 step 1）', () => {
  it('リクエスト側と同じ方法でルートを綴る', () => {
    // Two route resolvers that disagree would send one of them looking up a
    // contract that does not exist and calling the miss a pass.
    const req = { method: 'get', baseUrl: '/api', route: { path: '/devices/:id' } };
    assert.equal(routeKey(req), 'GET /api/devices/:id');
  });

  it('宣言したものを引ける', () => {
    const registry = createResponseContractRegistry();
    registry.declare('GET /api/devices/:id', 200, schema);
    assert.equal(registry.lookup('GET /api/devices/:id', 200)?.status, 200);
    assert.equal(registry.lookup('GET /api/devices/:id', 404), null);
    assert.deepEqual(registry.declaredRoutes(), ['GET /api/devices/:id']);
  });

  it('壊れた宣言はその場で拒む', () => {
    const registry = createResponseContractRegistry();
    assert.throws(() => registry.declare('/api/x', 200, schema), /route like/);
    assert.throws(() => registry.declare('GET /api/x', '200', schema), /status code/);
    assert.throws(() => registry.declare('GET /api/x', 200, {}), /needs a schema/);
  });
});

describe('引けなかったことを合格にしない', () => {
  it('契約が見つからない応答はunmatchedであって合格ではない', () => {
    // The failure mode of this whole feature: a route nobody is checking,
    // counted as fine. Three defects found on 2026-08-24 had that shape.
    const registry = createResponseContractRegistry();
    const result = classifyResponse({
      mode: 'enforce', route: 'GET /api/unknown', status: 200, registry,
    });
    assert.equal(result.action, 'unmatched');
  });

  it('ルート自体を解決できなかった場合もunmatched', () => {
    const registry = createResponseContractRegistry();
    const result = classifyResponse({ mode: 'enforce', route: null, status: 200, registry });
    assert.equal(result.action, 'unmatched');
  });

  it('意図的な除外と、知らないことを混ぜない', () => {
    // "Excluded" is a decision with a reason. "Unmatched" is ignorance. A
    // counter that adds them together hides the second behind the first.
    const registry = createResponseContractRegistry();
    const excluded = classifyResponse({
      mode: 'enforce', route: 'GET /readyz', status: 200, registry,
    });
    assert.equal(excluded.action, 'never-enforced');

    const diagnostics = createResponseContractDiagnostics();
    diagnostics.recordNeverEnforced();
    diagnostics.recordUnmatched('GET /api/unknown');
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.neverEnforced, 1);
    assert.equal(snapshot.unmatched, 1);
    assert.deepEqual(snapshot.unmatchedRoutes, { 'GET /api/unknown': 1 });
  });
});

describe('検証の強さと呼び名を一致させる', () => {
  it('boundedでない応答はenforceにならない', () => {
    // Validating the first N elements and calling the response checked would
    // be false: element N+1 is exactly where an unchecked one would be.
    const registry = createResponseContractRegistry();
    registry.declare('GET /api/connections', 200, schema, { bounded: false });
    const result = classifyResponse({
      mode: 'enforce', route: 'GET /api/connections', status: 200, registry,
    });
    assert.equal(result.action, 'observe');
    assert.match(result.reason, /unbounded/);
  });

  it('boundedな応答はenforceになる', () => {
    const registry = createResponseContractRegistry();
    registry.declare('GET /api/status', 200, schema);
    assert.equal(
      classifyResponse({ mode: 'enforce', route: 'GET /api/status', status: 200, registry }).action,
      'enforce'
    );
  });

  it('配列要素まで見ていない契約は、そう申告できる', () => {
    // A reader must not take "declared" to mean the elements were checked.
    const registry = createResponseContractRegistry();
    registry.declare('GET /api/devices', 200, schema, { arrayElementsObserved: true });
    assert.equal(registry.lookup('GET /api/devices', 200).arrayElementsObserved, true);
  });

  it('boundedの定義が1か所にある', () => {
    assert.equal(typeof BOUNDED_ARRAY_LIMIT, 'number');
    assert.ok(BOUNDED_ARRAY_LIMIT > 0);
  });
});

describe('本番で強制しないものを固定する', () => {
  it('health、download、stream、redirectが恒久的に除外されている', () => {
    // Pinned so nobody quietly adds enforcement later. `/readyz` is the
    // sharpest case: on 2026-08-24 a failing readiness check rolled a deploy
    // back, and the ALB drains a target by the same signal. A healthy Hub must
    // not be declared unhealthy because a field was missing from a contract.
    for (const route of [
      'GET /healthz',
      'GET /readyz',
      'GET /api/connections/export',
      'GET /api/backup/download/:name',
      'GET /api/auth/oidc/start',
      'GET /api/auth/oidc/callback',
    ]) {
      assert.ok(isNeverEnforced(route), `${route} must stay out of production enforcement`);
    }
  });

  it('除外にはすべて理由が付いている', () => {
    // "Not done yet" and "never" look the same in a list without one.
    for (const entry of NEVER_ENFORCED) {
      assert.ok(entry.reason && entry.reason.length > 10, `${entry.route} has no reason`);
    }
  });
});

describe('実行時の挙動を変えない', () => {
  it('既定のoffでは何も判断しない', () => {
    const registry = createResponseContractRegistry();
    registry.declare('GET /api/status', 200, schema);
    assert.equal(
      classifyResponse({ mode: 'off', route: 'GET /api/status', status: 200, registry }).action,
      'skip'
    );
  });

  it('知らないモードは黙って通さず、その場で失敗する', () => {
    const registry = createResponseContractRegistry();
    assert.throws(
      () => classifyResponse({ mode: 'lenient', route: 'GET /x', status: 200, registry }),
      /Unknown response contract mode/
    );
    assert.deepEqual(MODES, ['off', 'observe', 'enforce']);
  });

  it('どのHTTPルートにも接続されていない', () => {
    // This step adds the registry, not the middleware. Nothing may inspect a
    // response until the schemas are declarations rather than observations.
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'response-contract.js'), 'utf8'
    );
    assert.doesNotMatch(source, /res\.json\s*=/);
    assert.doesNotMatch(source, /app\.use|router\./);
  });
});

describe('P2-95の積み残しを宣言する（2026-08-29）', () => {
  const { createRegistry } = require('../../src/response-contracts');

  it('GET /api/ai/facts が宣言されている', () => {
    // #315's description said this was declared when it was not; the gate's
    // `undeclared: GET /api/ai/facts x15` was the evidence, and the P2-95 spec
    // carries the correction. This is the implementation catching up to what
    // was written.
    const contract = createRegistry().lookup('GET /api/ai/facts', 200);
    assert.ok(contract, 'GET /api/ai/facts 200 is not declared');
    const shape = {
      serverTime: 1,
      range: { from: 1, to: 2, durationMs: 1 },
      previousRange: { from: 0, to: 1, durationMs: 1 },
      collection: {
        health: 'ok', enabledCount: 1, readyCount: 1,
        reportedSessions: 5, lastUpdatedAt: null, routers: [],
      },
      sourceScope: null,
      current: { connections: 1, devices: 1, destinations: 1, safe: 1, warn: 0, danger: 0 },
      previous: { connections: 0, devices: 0, destinations: 0, safe: 0, warn: 0, danger: 0 },
    };
    assert.equal(contract.schema.safeParse(shape).success, true);
  });

  it('lastUpdatedAt は null を取る', () => {
    // Null until a collection source has succeeded once, which is the state a
    // fresh Hub is in -- the one a contract is most likely to meet first.
    const contract = createRegistry().lookup('GET /api/ai/facts', 200);
    const withNumber = contract.schema.safeParse({
      serverTime: 1,
      range: { from: 1, to: 2, durationMs: 1 },
      previousRange: { from: 0, to: 1, durationMs: 1 },
      collection: {
        health: 'off', enabledCount: 0, readyCount: 0,
        reportedSessions: 0, lastUpdatedAt: 1_700_000_000, routers: [],
      },
      sourceScope: { sourceKind: 'agent', sourceId: 'a1' },
      current: { connections: 0, devices: 0, destinations: 0, safe: 0, warn: 0, danger: 0 },
      previous: { connections: 0, devices: 0, destinations: 0, safe: 0, warn: 0, danger: 0 },
    });
    assert.equal(withNumber.success, true);
  });

  it('GET /api/devices が宣言され、boundedを主張しない', () => {
    // 203 devices on the production Hub, under the 500-element limit -- which
    // is a count, not a bound. The route has no pagination, so a larger
    // network exceeds it and the declaration must not say otherwise.
    const contract = createRegistry().lookup('GET /api/devices', 200);
    assert.ok(contract, 'GET /api/devices 200 is not declared');
    assert.equal(contract.bounded, false);
    assert.equal(contract.arrayElementsObserved, true);
    assert.equal(contract.schema.safeParse({ devices: [] }).success, true);
    assert.equal(contract.schema.safeParse({ devices: [{ ip: '192.0.2.10' }] }).success, true);
    assert.equal(contract.schema.safeParse({}).success, false);
  });

  it('boundedでない宣言はenforceにならない', () => {
    // The property that makes `bounded: false` more than a label.
    const registry = createRegistry();
    for (const route of ['GET /api/ai/facts', 'GET /api/devices']) {
      const decision = classifyResponse({ mode: 'enforce', route, status: 200, registry });
      assert.equal(decision.action, 'observe', `${route} would be enforced`);
      assert.match(decision.reason, /unbounded/);
    }
  });

  it('connections/summary は宣言しないままにする', () => {
    // Its tests call the handler directly with a stand-in `res`, never through
    // Express, so nothing can reach it to check the contract. Declaring it
    // would create a contract nobody exercises, which is what the gate exists
    // to refuse. An HTTP-level test comes first.
    assert.equal(createRegistry().lookup('GET /api/connections/summary', 200), null);
  });
});

