// Unit tests for requireAdmin middleware behavior
// Verifies both admin-token auth and session-token auth without starting the full server.
// Run: node --test test/unit/middleware.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// ─── Recreate authenticate + requireAdmin from server.js logic ────────────────
// We don't import server.js (it starts the server on require).
// Instead we inline the identical logic so the test stays fast/offline.

function makeAuthenticate(getAdminToken, verifySession) {
  return function authenticate(provided) {
    if (!provided) return null;
    const session = verifySession(provided);
    if (session) return session;
    const adminToken = getAdminToken();
    if (adminToken) {
      const a = Buffer.from(provided);
      const b = Buffer.from(adminToken);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'admin';
    }
    return null;
  };
}

function makeRequireAdmin(getAdminToken, verifySession = () => null) {
  const authenticate = makeAuthenticate(getAdminToken, verifySession);
  return function requireAdmin(req, res, next) {
    if (!getAdminToken()) return res.status(503).json({ error: '認証未初期化' });
    const auth = authenticate(req.get('X-Admin-Token') || '');
    if (!auth) return res.status(401).json({ error: '認証エラー' });
    req.session = auth === 'admin' ? null : auth;
    next();
  };
}

// Minimal mock res / req helpers
function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (code) => { r._status = code; return r; };
  r.json   = (body) => { r._body  = body;  return r; };
  return r;
}
function mockReq(token) {
  return {
    headers: token != null ? { 'x-admin-token': token } : {},
    get(name) { return this.headers[name.toLowerCase()] ?? null; },
    session: undefined,
  };
}

// ─── Admin-token path ─────────────────────────────────────────────────────────

describe('requireAdmin — admin token path', () => {
  it('returns 503 when adminToken is not yet initialised', () => {
    const mw  = makeRequireAdmin(() => '');
    const res = mockRes();
    mw(mockReq('anything'), res, () => {});
    assert.equal(res._status, 503);
  });

  it('returns 401 when no token is provided', () => {
    const token = crypto.randomBytes(24).toString('hex');
    const mw    = makeRequireAdmin(() => token);
    const res   = mockRes();
    mw(mockReq(''), res, () => {});
    assert.equal(res._status, 401);
  });

  it('returns 401 when wrong token is provided', () => {
    const token = crypto.randomBytes(24).toString('hex');
    const mw    = makeRequireAdmin(() => token);
    const res   = mockRes();
    mw(mockReq('wrong-token'), res, () => {});
    assert.equal(res._status, 401);
  });

  it('calls next() and sets req.session=null when the correct admin token is provided', () => {
    const token = crypto.randomBytes(24).toString('hex');
    const mw    = makeRequireAdmin(() => token);
    const res   = mockRes();
    const req   = mockReq(token);
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() should have been called');
    assert.equal(res._status, 200);
    assert.equal(req.session, null); // admin token → no session row
  });
});

// ─── Session token path ───────────────────────────────────────────────────────

describe('requireAdmin — session token path', () => {
  const fakeSession = { id: 42, deviceLabel: 'My Mac', createdAt: Date.now() };

  it('calls next() and attaches the session row when a valid session token is provided', () => {
    const adminToken   = crypto.randomBytes(24).toString('hex');
    const sessionToken = crypto.randomBytes(24).toString('hex');
    const verifySession = (t) => t === sessionToken ? fakeSession : null;
    const mw  = makeRequireAdmin(() => adminToken, verifySession);
    const res = mockRes();
    const req = mockReq(sessionToken);
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() should have been called for a valid session token');
    assert.deepEqual(req.session, fakeSession);
  });

  it('returns 401 when neither session token nor admin token matches', () => {
    const adminToken = crypto.randomBytes(24).toString('hex');
    const verifySession = () => null;
    const mw  = makeRequireAdmin(() => adminToken, verifySession);
    const res = mockRes();
    mw(mockReq('invalid-session-token'), res, () => {});
    assert.equal(res._status, 401);
  });

  it('session token takes priority: next() called even when admin token differs', () => {
    const adminToken   = crypto.randomBytes(24).toString('hex');
    const sessionToken = crypto.randomBytes(24).toString('hex');
    const verifySession = (t) => t === sessionToken ? fakeSession : null;
    const mw  = makeRequireAdmin(() => adminToken, verifySession);
    const res = mockRes();
    const req = mockReq(sessionToken);
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.deepEqual(req.session, fakeSession);
  });
});
