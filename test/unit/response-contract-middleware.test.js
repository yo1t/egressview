'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const {
  DEFAULT_MODE,
  createResponseContractMiddleware,
  resolveMode,
} = require('../../src/response-contract-middleware');
const {
  createResponseContractRegistry,
  createResponseContractDiagnostics,
} = require('../../src/response-contract');

function registryWith(route, status, schema, options) {
  const registry = createResponseContractRegistry();
  registry.declare(route, status, schema, options);
  return registry;
}

/** A response object with just enough of Express to be patched. */
function fakeResponse(status = 200) {
  const sent = [];
  return {
    statusCode: status,
    sent,
    json(body) { sent.push(body); return this; },
  };
}

function run(middleware, { route = '/status', status = 200, body = {} } = {}) {
  const req = { method: 'GET', baseUrl: '/api', route: { path: route } };
  const res = fakeResponse(status);
  res.req = req;
  middleware(req, res, () => {});
  res.json(body);
  return res;
}

describe('観測するが拒まない（P2-95 step 4）', () => {
  const schema = z.object({ ok: z.boolean() });

  it('契約を破った応答も、そのまま送る', () => {
    // Production enforcement is step 5 and 6, route by route. Until then a
    // broken contract is a thing to know about, not a thing to refuse.
    const diagnostics = createResponseContractDiagnostics();
    const middleware = createResponseContractMiddleware({
      mode: 'observe',
      registry: registryWith('GET /api/status', 200, schema),
      diagnostics,
      logger: { warn() {} },
    });
    const res = run(middleware, { body: { ok: 'not a boolean' } });

    assert.deepEqual(res.sent, [{ ok: 'not a boolean' }], 'the response was altered');
    assert.equal(diagnostics.snapshot().violations, 1);
  });

  it('enforceでも、名簿に無いルートは拒まない', () => {
    // Enforcement is per route and each entry is a decision. Setting the mode
    // must not start refusing everything that has a contract.
    const diagnostics = createResponseContractDiagnostics();
    const middleware = createResponseContractMiddleware({
      mode: 'enforce',
      registry: registryWith('GET /api/status', 200, schema),
      diagnostics,
      logger: { warn() {} },
    });
    const res = run(middleware, { body: { ok: 'no' } });
    assert.deepEqual(res.sent, [{ ok: 'no' }]);
  });

  it('強制するのは、送る方が悪い応答だけ', () => {
    // Enforcing replaces a response that is slightly wrong with one that is
    // definitely broken. It earns a place only where sending the wrong thing
    // is worse than sending nothing -- here, two responses that project a
    // credential down to a fact about it.
    const { ENFORCED_ROUTES, isEnforcedRoute } = require('../../src/response-contract');
    assert.deepEqual(ENFORCED_ROUTES.map((entry) => entry.route), [
      'GET /api/auth/security-config',
      'GET /api/config/ai',
    ]);
    for (const entry of ENFORCED_ROUTES) {
      assert.match(entry.reason, /leak/, `${entry.route} does not say why refusing beats sending`);
    }
    // Ordinary routes stay out: shape drift is caught in CI before it ships.
    assert.equal(isEnforcedRoute('GET /api/status', 200), false);
    assert.equal(isEnforcedRoute('POST /api/agent/ingest', 200), false);
  });

  it('秘密が混ざった応答は、名簿にあれば拒まれる', () => {
    // The failure this list exists for: a projection that stops projecting.
    const { z } = require('zod');
    const registry = createResponseContractRegistry();
    registry.declare('GET /api/config/ai', 200, z.object({ provider: z.string() }).strict());
    const middleware = createResponseContractMiddleware({
      mode: 'enforce', registry, logger: { warn() {} },
    });
    const req = { method: 'GET', baseUrl: '/api', route: { path: '/config/ai' } };
    const res = fakeResponse(200);
    res.req = req;
    res.status = function status(code) { this.statusCode = code; return this; };
    middleware(req, res, () => {});
    // Not shaped like a real credential, and not called one. The first
    // version wrote `apiKey: 'sk-ant-...'` here -- in the test asserting a
    // credential must not be sent -- and detect-secrets flagged it. What the
    // test needs is an unexpected field with a value it can look for, not a
    // convincing forgery.
    res.json({ provider: 'anthropic', unexpectedField: 'must-not-be-sent' });

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.sent, [{ error: 'Response did not match its contract' }]);
    assert.doesNotMatch(JSON.stringify(res.sent), /must-not-be-sent/);
  });

  it('拒むのは成功応答だけ', () => {
    // Replacing a 4xx or 5xx with a different 5xx tells the caller less than
    // the original already did.
    const { isEnforcedRoute } = require('../../src/response-contract');
    assert.equal(isEnforcedRoute('GET /anything', 404), false);
    assert.equal(isEnforcedRoute('GET /anything', 500), false);
  });

  it('既定では何も見ない', () => {
    // A Hub that has not asked for this pays a mode check and nothing else.
    const diagnostics = createResponseContractDiagnostics();
    const middleware = createResponseContractMiddleware({
      registry: registryWith('GET /api/status', 200, schema), diagnostics,
    });
    run(middleware, { body: { ok: 'no' } });
    assert.equal(middleware.mode, DEFAULT_MODE);
    assert.equal(diagnostics.snapshot().violations, 0);
    assert.equal(diagnostics.snapshot().matched, 0);
  });

  it('設定の綴り違いで、勝手に強制へ倒れない', () => {
    // A typo must not be a silent decision to start refusing responses.
    assert.equal(resolveMode('enfroce'), 'off');
    assert.equal(resolveMode(undefined), 'off');
    assert.equal(resolveMode('OBSERVE'), 'observe');
  });
});

describe('数えるものを取り違えない', () => {
  const schema = z.object({ ok: z.boolean() });

  it('契約どおりの応答を数える', () => {
    const diagnostics = createResponseContractDiagnostics();
    const middleware = createResponseContractMiddleware({
      mode: 'observe',
      registry: registryWith('GET /api/status', 200, schema),
      diagnostics,
      logger: { warn() {} },
    });
    run(middleware, { body: { ok: true } });
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.matched, 1);
    assert.equal(snapshot.violations, 0);
  });

  it('契約の無いルートを合格として数えない', () => {
    const diagnostics = createResponseContractDiagnostics();
    const middleware = createResponseContractMiddleware({
      mode: 'observe',
      registry: createResponseContractRegistry(),
      diagnostics,
      logger: { warn() {} },
    });
    run(middleware, { body: { anything: true } });
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.matched, 0);
    assert.equal(snapshot.unmatched, 1);
    assert.deepEqual(snapshot.unmatchedRoutes, { 'GET /api/status': 1 });
  });

  it('検証に使った時間を測る', () => {
    // Step 4 exists to answer what this costs. A middleware that could not
    // say would leave the decision to enforce resting on a guess.
    const middleware = createResponseContractMiddleware({
      mode: 'observe',
      registry: registryWith('GET /api/status', 200, schema),
      logger: { warn() {} },
    });
    run(middleware, { body: { ok: true } });
    assert.equal(typeof middleware.snapshot().checkedMilliseconds, 'number');
  });
});

describe('ログが利用者のデータを写さない', () => {
  it('field名は出すが、値は出さない', () => {
    // A tool that shows people what leaves their machine must not copy a
    // response body into its own log to complain about the shape of it.
    const warnings = [];
    const middleware = createResponseContractMiddleware({
      mode: 'observe',
      registry: registryWith('GET /api/status', 200, z.object({ routerIp: z.boolean() })),
      logger: { warn: (line) => warnings.push(line) },
    });
    // TEST-NET-1, not this network's address. The first version of this test
    // used a real one -- in the test asserting that a log must not carry the
    // user's data -- and the secret scan caught it.
    run(middleware, { body: { routerIp: '192.0.2.10' } });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /routerIp/);
    assert.doesNotMatch(warnings[0], /192\.0\.2\.10/);
  });

  it('同じ違反を繰り返し書かない', () => {
    // A broken shape is returned on every request, and a log repeating one
    // finding thousands of times buries the second one.
    const warnings = [];
    const middleware = createResponseContractMiddleware({
      mode: 'observe',
      registry: registryWith('GET /api/status', 200, z.object({ ok: z.boolean() })),
      logger: { warn: (line) => warnings.push(line) },
    });
    for (let i = 0; i < 50; i += 1) run(middleware, { body: { ok: 'no' } });
    assert.equal(warnings.length, 1);
  });

  it('検証が落ちても応答は送られる', () => {
    // Checking a response must never be the reason one fails to send.
    const registry = createResponseContractRegistry();
    registry.declare('GET /api/status', 200, {
      safeParse() { throw new Error('schema exploded'); },
    });
    const middleware = createResponseContractMiddleware({
      mode: 'observe', registry, logger: { warn() {} },
    });
    const res = run(middleware, { body: { ok: true } });
    assert.deepEqual(res.sent, [{ ok: true }]);
  });
});

describe('アプリに接続されている', () => {
  it('/api の下で、権限検査より前に動く', () => {
    // Before `enforceApiPermissions` so that a refusal it produces is seen by
    // the envelope contracts -- which is where every unattributable response
    // measured on 2026-08-25 came from.
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'http-app.js'), 'utf8'
    );
    const installed = source.indexOf("app.use('/api', responseContracts)");
    const permissions = source.indexOf("app.use('/api', enforceApiPermissions)");
    assert.ok(installed > 0, 'the middleware is not installed');
    assert.ok(installed < permissions, 'it runs after the permission check');
  });

  it('既定では接続すらされない', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'http-app.js'), 'utf8'
    );
    assert.match(source, /if \(responseContracts\.mode !== 'off'\)/);
  });

  it('運用者が読む場所へ、定期的に要約を出す', () => {
    // A counter nobody looks at answers nothing, and step 4 exists to answer
    // what enforcement would cost and what it would have refused.
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'http-app.js'), 'utf8'
    );
    assert.match(source, /\[response-contract\] mode=/);
    assert.match(source, /checkedMs=/);
    assert.match(source, /summary\.unref\(\)/);
    // Which routes, not just how many. The first run reported 137 unmatched
    // and named none of them: a number that asks the reader to go and find
    // the work themselves is not a report.
    assert.match(source, /\[response-contract\] undeclared:/);
  });
});
