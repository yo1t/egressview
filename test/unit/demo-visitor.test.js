// Anonymous visitor for the public read-only demo.
// Run: node --test test/unit/demo-visitor.test.js
//
// The demo authenticates every caller as a fixed viewer so the UI is reachable
// without a credential. That is only safe while two things hold: it takes both
// demo flags to switch on, and the identity it grants can read but not write.
// Both are asserted here rather than left to review.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DEMO_VISITOR_SESSION, demoVisitorFor } = require('../../src/demo-visitor');
const { createAuthMiddleware } = require('../../src/auth-middleware');
const { PERMISSIONS } = require('../../src/permissions');
const { permissionsForRole, ROLES } = require('../../src/roles');

function authFor(demoVisitor) {
  return createAuthMiddleware({
    appState: { adminToken: 'real-admin-token' },
    sessions: { verifySession: () => null, verifyCsrf: () => true },
    authCookies: { sessionToken: () => '', verifyCookieCsrf: () => true },
    authAudit: { append() {} },
    demoVisitor,
  });
}

const bareRequest = { get: () => '', headers: {} };

describe('demo visitor: 有効化の条件', () => {
  it('両方のフラグが立っているときだけ visitor を返す', () => {
    assert.equal(demoVisitorFor({ demoMode: true, demoReadOnly: true }), DEMO_VISITOR_SESSION);
  });

  it('DEMO_READ_ONLY だけでは匿名アクセスを許さない', () => {
    // This is the dangerous combination: a real deployment that happens to set
    // the read-only flag must not become publicly readable.
    assert.equal(demoVisitorFor({ demoMode: false, demoReadOnly: true }), null);
  });

  it('DEMO_MODE だけでも匿名アクセスを許さない', () => {
    // Demo mode alone is used by CI and by contributors locally, where the
    // fixed admin token is the intended way in.
    assert.equal(demoVisitorFor({ demoMode: true, demoReadOnly: false }), null);
  });

  it('未設定・非boolean値では有効化しない', () => {
    for (const value of [undefined, null, 'true', 1, {}]) {
      assert.equal(demoVisitorFor({ demoMode: value, demoReadOnly: value }), null, String(value));
    }
  });
});

describe('demo visitor: 権限', () => {
  it('viewer ロールであり、読み取り権限だけを持つ', () => {
    assert.equal(DEMO_VISITOR_SESSION.role, ROLES.VIEWER);
    const granted = permissionsForRole(DEMO_VISITOR_SESSION.role);
    assert.deepEqual([...granted], [PERMISSIONS.NETWORK_READ]);
  });

  it('書き込み系の権限を一切持たない', () => {
    const granted = new Set(permissionsForRole(DEMO_VISITOR_SESSION.role));
    for (const [name, value] of Object.entries(PERMISSIONS)) {
      if (value === PERMISSIONS.NETWORK_READ) continue;
      assert.equal(granted.has(value), false, `${name} を持ってはいけない`);
    }
  });

  it('凍結されており、実行時に権限を書き換えられない', () => {
    assert.throws(() => { DEMO_VISITOR_SESSION.role = ROLES.ADMIN; }, TypeError);
    assert.equal(DEMO_VISITOR_SESSION.role, ROLES.VIEWER);
  });
});

describe('demo visitor: 認証境界での扱い', () => {
  it('資格情報なしのリクエストを viewer として認証する', () => {
    const { authenticateRequest } = authFor(DEMO_VISITOR_SESSION);
    const result = authenticateRequest(bareRequest);
    assert.equal(result.auth, DEMO_VISITOR_SESSION);
    assert.equal(result.source, 'demo');
  });

  it('visitor が無ければ資格情報なしは従来どおり未認証', () => {
    const { authenticateRequest } = authFor(null);
    assert.equal(authenticateRequest(bareRequest), null);
  });

  it('本物の管理トークンは visitor に上書きされない', () => {
    // Order matters: if the anonymous fallback ran first, an administrator
    // would silently be demoted to viewer on the demo.
    const { authenticateRequest } = authFor(DEMO_VISITOR_SESSION);
    const req = { get: name => (name === 'X-Admin-Token' ? 'real-admin-token' : ''), headers: {} };
    const result = authenticateRequest(req);
    assert.equal(result.auth, 'admin');
    assert.equal(result.source, 'header');
  });

  it('誤った資格情報を出しても visitor へフォールバックする', () => {
    // A wrong token is not an escalation here: the caller gets exactly what an
    // anonymous visitor gets, which is read-only.
    const { authenticateRequest } = authFor(DEMO_VISITOR_SESSION);
    const req = { get: name => (name === 'X-Admin-Token' ? 'wrong' : ''), headers: {} };
    assert.equal(authenticateRequest(req).auth, DEMO_VISITOR_SESSION);
  });

  it('WebSocket handshake で使う authenticate も匿名を通す', () => {
    // The socket boundary calls authenticate() directly with whatever the
    // handshake carried; without this the demo UI would load but never receive
    // live updates.
    const { authenticate } = authFor(DEMO_VISITOR_SESSION);
    assert.equal(authenticate(''), DEMO_VISITOR_SESSION);
    assert.equal(authenticate('real-admin-token'), 'admin');
  });
});
