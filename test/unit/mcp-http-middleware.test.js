// Unit tests for src/mcp-http-middleware.js (P2-68)
// Run: node --test test/unit/mcp-http-middleware.test.js
//
// These middlewares were previously inline in mcp-server.js and only reachable
// through a booted HTTP transport. Extracting them makes the ordering
// contracts they depend on directly assertable.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mw = require('../../src/mcp-http-middleware');
const mcpAudit = require('../../src/mcp-audit');

function makeReq(overrides = {}) {
  const headers = overrides.headers || {};
  return {
    method: 'POST',
    headers,
    ip: '198.51.100.7',
    get(name) { return headers[String(name).toLowerCase()]; },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    listeners: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    get(name) { return this.headers[name]; },
    on(event, fn) { (this.listeners[event] ||= []).push(fn); return this; },
    emit(event) { for (const fn of this.listeners[event] || []) fn(); },
  };
  return res;
}

describe('createAuthMiddleware', () => {
  it('rejects a wrong token without leaking which part differed', () => {
    const res = makeRes();
    let nexted = false;
    mw.createAuthMiddleware('correct-token')(
      makeReq({ headers: { 'x-admin-token': 'wrong-token!' } }), res, () => { nexted = true; }
    );
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });

  it('rejects a token of a different length rather than throwing', () => {
    const res = makeRes();
    mw.createAuthMiddleware('correct-token')(
      makeReq({ headers: { 'x-admin-token': 'short' } }), res, () => {}
    );
    assert.equal(res.statusCode, 401);
  });

  it('accepts the Bearer form and attaches the fixed service identity', () => {
    const req = makeReq({ headers: { authorization: 'Bearer correct-token' } });
    let nexted = false;
    mw.createAuthMiddleware('correct-token')(req, makeRes(), () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(req.mcpAuth.subject, 'private-token');
    assert.deepEqual([...req.mcpAuth.scopes], ['network.read', 'notes.write']);
    assert.ok(Object.isFrozen(req.mcpAuth), 'identity must not be mutable downstream');
  });

  it('rejects a missing token', () => {
    const res = makeRes();
    mw.createAuthMiddleware('correct-token')(makeReq(), res, () => {});
    assert.equal(res.statusCode, 401);
  });
});

describe('resolveTimeoutMs', () => {
  it('accepts a positive integer within bounds', () => {
    assert.equal(mw.resolveTimeoutMs('5000', 30_000), 5000);
  });

  it('falls back for zero, negative and non-numeric values', () => {
    // A zero or negative timeout would disable the deadline entirely.
    for (const value of ['0', '-1', '', 'abc', '1.5', undefined, null]) {
      assert.equal(mw.resolveTimeoutMs(value, 30_000), 30_000, `value: ${value}`);
    }
  });

  it('falls back above the bound rather than overflowing the timer', () => {
    assert.equal(mw.resolveTimeoutMs('600001', 30_000), 30_000);
    assert.equal(mw.resolveTimeoutMs('600000', 30_000), 600_000);
  });
});

describe('requestIdFor', () => {
  it('accepts a caller id only in a safe shape', () => {
    assert.equal(mw.requestIdFor(makeReq({ headers: { 'x-request-id': 'abc-123_x.y' } })), 'abc-123_x.y');
  });

  it('generates one when the supplied id is unsafe or too long', () => {
    for (const supplied of ['has space', 'semi;colon', '<script>', 'x'.repeat(101), '']) {
      const id = mw.requestIdFor(makeReq({ headers: { 'x-request-id': supplied } }));
      assert.notEqual(id, supplied);
      assert.match(id, /^[0-9a-f-]{36}$/);
    }
  });
});

describe('auditContext', () => {
  it('is null-valued before authentication but still carries the client address', () => {
    const context = mw.auditContext(makeReq({ mcpRequestId: 'r1' }));
    assert.equal(context.subject, null);
    assert.equal(context.clientId, null);
    assert.equal(context.requestId, 'r1');
    // The only identifier available when a request fails before auth.
    assert.equal(context.clientIp, '198.51.100.7');
  });

  it('carries the verified identity once authentication has run', () => {
    const req = makeReq({
      mcpRequestId: 'r2',
      mcpAuth: { subject: 's', clientId: 'c', scopes: ['network.read'] },
    });
    assert.deepEqual(mw.auditContext(req), {
      subject: 's', clientId: 'c', scopes: ['network.read'],
      requestId: 'r2', clientIp: '198.51.100.7',
    });
  });
});

describe('createRequestContextMiddleware', () => {
  it('stamps a request id and start time before anything else runs', () => {
    const req = makeReq();
    mw.createRequestContextMiddleware()(req, makeRes(), () => {});
    assert.match(req.mcpRequestId, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(req.mcpStartedAt));
  });
});

describe('createRateLimitMiddleware', () => {
  beforeEach(() => { mcpAudit._resetForTest(':memory:'); });

  it('holds a concurrency slot only on the pre-auth pass', () => {
    let acquired = 0;
    const limiter = { check: () => ({ allowed: true }), acquire: () => { acquired += 1; return () => {}; } };
    mw.createRateLimitMiddleware(limiter)(makeReq({ mcpStartedAt: Date.now() }), makeRes(), () => {});
    assert.equal(acquired, 1);
    // Taking a second slot after authentication would double-count the same request.
    mw.createRateLimitMiddleware(limiter, { stage: 'post-auth' })(
      makeReq({ mcpStartedAt: Date.now() }), makeRes(), () => {}
    );
    assert.equal(acquired, 1);
  });

  it('releases the slot exactly once even when both finish and close fire', () => {
    let released = 0;
    const limiter = { check: () => ({ allowed: true }), acquire: () => () => { released += 1; } };
    const res = makeRes();
    mw.createRateLimitMiddleware(limiter)(makeReq({ mcpStartedAt: Date.now() }), res, () => {});
    res.emit('finish');
    res.emit('close');
    assert.equal(released, 1);
  });

  it('audits a rejection and sets Retry-After', () => {
    const limiter = {
      check: () => ({ allowed: false, reason: 'global_rate', retryAfterSeconds: 42 }),
      acquire: () => () => {},
    };
    const res = makeRes();
    let nexted = false;
    mw.createRateLimitMiddleware(limiter)(
      makeReq({ mcpStartedAt: Date.now(), mcpRequestId: 'r3', body: { method: 'tools/call' } }),
      res, () => { nexted = true; }
    );
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '42');
    const [row] = mcpAudit.list();
    assert.equal(row.eventType, 'mcp_rate_limited');
    assert.equal(row.reason, 'global_rate');
    assert.equal(row.httpStatus, 429);
  });

  it('applies per-identity limits only after authentication', () => {
    const seen = [];
    const limiter = { check: (args) => { seen.push(args); return { allowed: true }; }, acquire: () => () => {} };
    mw.createRateLimitMiddleware(limiter)(makeReq({ mcpStartedAt: Date.now() }), makeRes(), () => {});
    mw.createRateLimitMiddleware(limiter, { stage: 'post-auth' })(
      makeReq({ mcpStartedAt: Date.now(), mcpAuth: { subject: 's', clientId: 'c' } }), makeRes(), () => {}
    );
    assert.deepEqual(seen[0], {});
    assert.deepEqual(seen[1], { subject: 's', clientId: 'c', skipGlobal: true });
  });
});

describe('createAuditMiddleware', () => {
  beforeEach(() => { mcpAudit._resetForTest(':memory:'); });

  function run(req, res) {
    mw.createAuditMiddleware()(req, res, () => {});
    res.emit('finish');
    return mcpAudit.list();
  }

  it('classifies status codes into reason codes', () => {
    const cases = [
      [400, 'bad_request'], [403, 'insufficient_scope'], [404, 'not_found'],
      [405, 'method_not_allowed'], [413, 'payload_too_large'], [418, 'client_error'],
      [500, 'server_error'],
    ];
    for (const [status, reason] of cases) {
      mcpAudit._resetForTest(':memory:');
      const res = makeRes(); res.statusCode = status;
      const [row] = run(makeReq({ mcpStartedAt: Date.now(), body: { method: 'ping' } }), res);
      assert.equal(row.reason, reason, `status ${status}`);
      assert.equal(row.outcome, 'failure');
    }
  });

  it('distinguishes invalid_token from plain unauthorized', () => {
    const res = makeRes(); res.statusCode = 401;
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    const [row] = run(makeReq({ mcpStartedAt: Date.now() }), res);
    assert.equal(row.reason, 'invalid_token');
  });

  it('skips 429, which the limiter has already audited', () => {
    const res = makeRes(); res.statusCode = 429;
    assert.deepEqual(run(makeReq({ mcpStartedAt: Date.now() }), res), []);
  });

  it('treats a timed-out stream as a failure even though it reports 200', () => {
    // A streamed response that blew its deadline still reports 200; the flag
    // is the authoritative signal, not the status code.
    const res = makeRes();
    const [row] = run(makeReq({ mcpStartedAt: Date.now(), mcpTimedOut: true }), res);
    assert.equal(row.outcome, 'failure');
    assert.equal(row.reason, 'request_timeout');
  });

  it('does not double-write when the tool handler already audited', () => {
    const res = makeRes();
    const rows = run(makeReq({
      mcpStartedAt: Date.now(),
      mcpToolAuditWritten: true,
      body: { method: 'tools/call', params: { name: 'get_devices' } },
    }), res);
    assert.deepEqual(rows, []);
  });

  it('records the tool name for an unhandled tools/call', () => {
    const res = makeRes(); res.statusCode = 403;
    const [row] = run(makeReq({
      mcpStartedAt: Date.now(),
      body: { method: 'tools/call', params: { name: 'set_device_note' } },
    }), res);
    assert.equal(row.eventType, 'mcp_tool_call');
    assert.equal(row.toolName, 'set_device_note');
  });
});
