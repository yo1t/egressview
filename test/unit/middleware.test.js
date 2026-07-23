'use strict';

const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const authCookies = require('../../src/auth-cookies');
const { createAuthMiddleware } = require('../../src/auth-middleware');

function createFixture({
  adminToken = crypto.randomBytes(24).toString('hex'),
  sessionToken = 'session-token',
  csrfToken = 'csrf-token',
} = {}) {
  const session = {
    id: 42,
    authMethod: 'local',
    deviceLabel: 'My Mac',
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
  });
  return { adminToken, csrfToken, events, middleware, session, sessionToken };
}

function mockReq({
  token = '',
  cookie = '',
  csrf = '',
  method = 'GET',
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
    originalUrl: '/api/settings',
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
