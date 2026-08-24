'use strict';

const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const authCookies = require('../../src/auth-cookies');
const { createAuthMiddleware } = require('../../src/auth-middleware');
const { PERMISSIONS } = require('../../src/permissions');

function createFixture({
  adminToken = crypto.randomBytes(24).toString('hex'),
  sessionToken = 'session-token',
  csrfToken = 'csrf-token',
  resolvePermissions,
} = {}) {
  const session = {
    id: 42,
    authMethod: 'local',
    deviceLabel: 'My Mac',
    // Sessions carry a role from P2-61 Phase 3; the local administrator is admin.
    role: 'admin',
  };
  const events = [];
  const sessions = {
    verifySession: token => token === sessionToken ? session : null,
    verifyCsrf: (candidate, token) => candidate === session && token === csrfToken,
  };
  const middleware = createAuthMiddleware({
    appState: { adminToken },
    sessions,
    authCookies,
    authAudit: { append: event => events.push(event) },
    resolvePermissions,
  });
  return { adminToken, csrfToken, events, middleware, session, sessionToken };
}

function mockReq({
  token = '',
  cookie = '',
  csrf = '',
  method = 'GET',
  originalUrl = '/api/settings',
} = {}) {
  const headers = {};
  if (token) headers['x-admin-token'] = token;
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  return {
    headers,
    id: 'request-1',
    ip: '192.0.2.10',
    method,
    originalUrl,
    get(name) {
      return this.headers[name.toLowerCase()] || '';
    },
  };
}

function mockRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.body = null;
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    res.body = body;
    return res;
  };
  return res;
}

describe('requireAdmin middleware', () => {
  it('fails closed when authentication is not initialized', () => {
    const { middleware } = createFixture({ adminToken: '' });
    const res = mockRes();
    middleware.requireAdmin(mockReq({ token: 'anything' }), res, () => {});
    assert.equal(res.statusCode, 503);
  });

  it('rejects missing and invalid credentials', () => {
    const { middleware } = createFixture();
    for (const token of ['', 'wrong-token']) {
      const res = mockRes();
      middleware.requireAdmin(mockReq({ token }), res, () => {});
      assert.equal(res.statusCode, 401);
    }
  });

  it('accepts the admin API token without requiring browser CSRF', () => {
    const { adminToken, middleware } = createFixture();
    const req = mockReq({ token: adminToken, method: 'POST' });
    const res = mockRes();
    let nextCalled = false;
    middleware.requireAdmin(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.session, null);
    assert.equal(req.authSource, 'header');
    assert.equal(req.authMethod, 'api-token');
  });

  it('accepts a browser session cookie for safe requests', () => {
    const { middleware, session, sessionToken } = createFixture();
    const req = mockReq({
      cookie: `${authCookies.SESSION_COOKIE}=${sessionToken}`,
    });
    let nextCalled = false;
    middleware.requireAdmin(req, mockRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.session, session);
    assert.equal(req.authSource, 'cookie');
    assert.equal(req.authMethod, 'local');
  });

  it('rejects cookie mutations without a matching CSRF token and audits the failure', () => {
    const { events, middleware, sessionToken } = createFixture();
    const req = mockReq({
      cookie: `${authCookies.SESSION_COOKIE}=${sessionToken}`,
      method: 'POST',
    });
    const res = mockRes();
    middleware.requireAdmin(req, res, () => assert.fail('next must not run'));
    assert.equal(res.statusCode, 403);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'csrf_rejected');
    assert.equal(events[0].outcome, 'failure');
  });

  it('accepts and audits a valid cookie mutation after the response finishes', () => {
    const { csrfToken, events, middleware, sessionToken } = createFixture();
    const req = mockReq({
      cookie: [
        `${authCookies.SESSION_COOKIE}=${sessionToken}`,
        `${authCookies.CSRF_COOKIE}=${csrfToken}`,
      ].join('; '),
      csrf: csrfToken,
      method: 'POST',
    });
    const res = mockRes();
    let nextCalled = false;
    middleware.requireAdmin(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(events.length, 0);
    res.emit('finish');
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'api_mutation');
    assert.equal(events[0].outcome, 'success');
    assert.deepEqual(events[0].metadata, { statusCode: 200 });
  });
});

describe('API permission boundary', () => {
  it('allows explicitly public routes without initialized authentication', () => {
    const { middleware } = createFixture({ adminToken: '' });
    let nextCalled = false;
    middleware.enforceApiPermissions(
      mockReq({ method: 'GET', originalUrl: '/api/auth/status' }),
      mockRes(),
      () => { nextCalled = true; }
    );
    assert.equal(nextCalled, true);
  });

  it('rejects unclassified API routes before they reach Express routers', () => {
    const { adminToken, middleware } = createFixture();
    const res = mockRes();
    middleware.enforceApiPermissions(
      mockReq({ token: adminToken, method: 'GET', originalUrl: '/api/future-route' }),
      res,
      () => assert.fail('next must not run')
    );
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
  });

  it('allows only the permissions assigned to the authenticated identity', () => {
    const fixture = createFixture({
      resolvePermissions: () => [PERMISSIONS.NETWORK_READ],
    });
    const readReq = mockReq({
      token: fixture.adminToken,
      method: 'GET',
      originalUrl: '/api/connections?limit=10',
    });
    let nextCalled = false;
    fixture.middleware.enforceApiPermissions(readReq, mockRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.deepEqual(readReq.permissions, [PERMISSIONS.NETWORK_READ]);

    const writeReq = mockReq({
      token: fixture.adminToken,
      method: 'POST',
      originalUrl: '/api/notes',
    });
    const res = mockRes();
    fixture.middleware.enforceApiPermissions(
      writeReq,
      res,
      () => assert.fail('next must not run')
    );
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Permission denied' });
    assert.equal(fixture.events.at(-1).eventType, 'permission_denied');
    assert.deepEqual(fixture.events.at(-1).metadata.missingPermissions, [
      PERMISSIONS.NOTES_WRITE,
    ]);
  });

  it('does not repeat authentication and mutation auditing in route middleware', () => {
    const { adminToken, events, middleware } = createFixture();
    const req = mockReq({
      token: adminToken,
      method: 'POST',
      originalUrl: '/api/notes',
    });
    const res = mockRes();
    let nextCalls = 0;
    middleware.enforceApiPermissions(req, res, () => {
      middleware.requireAdmin(req, res, () => { nextCalls += 1; });
    });
    assert.equal(nextCalls, 1);
    res.emit('finish');
    assert.equal(events.filter(event => event.eventType === 'api_mutation').length, 1);
  });

  it('audits sensitive reads without logging high-frequency network reads', () => {
    const fixture = createFixture();
    const sensitiveReq = mockReq({
      token: fixture.adminToken,
      method: 'GET',
      originalUrl: '/api/auth/audit-events?before=123',
    });
    const sensitiveRes = mockRes();
    fixture.middleware.enforceApiPermissions(sensitiveReq, sensitiveRes, () => {});
    sensitiveRes.emit('finish');

    assert.equal(fixture.events.length, 1);
    assert.equal(fixture.events[0].eventType, 'api_sensitive_read');
    assert.equal(fixture.events[0].path, '/api/auth/audit-events?before=123');

    const networkReq = mockReq({
      token: fixture.adminToken,
      method: 'GET',
      originalUrl: '/api/connections?limit=10',
    });
    const networkRes = mockRes();
    fixture.middleware.enforceApiPermissions(networkReq, networkRes, () => {});
    networkRes.emit('finish');
    assert.equal(fixture.events.length, 1);
  });

  it('keeps browser sessions and API credentials distinct for realtime authorization', () => {
    const fixture = createFixture();
    const apiDecision = fixture.middleware.authorizeCredential(
      fixture.adminToken,
      [PERMISSIONS.NETWORK_READ]
    );
    assert.equal(apiDecision.allowed, true);
    assert.equal(apiDecision.authMethod, 'api-token');

    const cookieDecision = fixture.middleware.authorizeCredential(
      fixture.adminToken,
      [PERMISSIONS.NETWORK_READ],
      { browserSessionOnly: true }
    );
    assert.equal(cookieDecision, null);
  });
});
