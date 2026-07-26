// Unit tests for scoped API identities (P2-61 Phase 2).
'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const apiIdentities = require('../../src/api-identities');
const { PERMISSIONS, ALL_PERMISSIONS } = require('../../src/permissions');

const HOUR = 60 * 60 * 1000;

beforeEach(() => apiIdentities._initForTest());
after(() => apiIdentities.closeDb());

function create(overrides = {}) {
  return apiIdentities.createIdentity({
    label: 'ci',
    permissions: [PERMISSIONS.NETWORK_READ],
    expiresInMs: HOUR,
    ...overrides,
  });
}

describe('API identity issuance', () => {
  it('returns the plaintext token exactly once and never stores it', () => {
    const { token, identity } = create();
    assert.match(token, /^egv_[0-9a-f]{64}$/);

    const listed = apiIdentities.listIdentities();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, identity.id);
    // The token must not be recoverable from any later read.
    assert.equal(JSON.stringify(listed).includes(token), false);
    assert.equal(Object.prototype.hasOwnProperty.call(listed[0], 'tokenHash'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(listed[0], 'token'), false);
  });

  it('stores only a hash of the token', () => {
    const { token } = create();
    // Verification succeeds for the plaintext, proving the stored hash matches,
    // while the plaintext itself is absent from every public projection.
    assert.ok(apiIdentities.verifyToken(token));
    assert.equal(JSON.stringify(apiIdentities.listIdentities()).includes(token), false);
  });

  it('issues independent tokens for separate identities', () => {
    const a = create({ label: 'a' });
    const b = create({ label: 'b' });
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.identity.id, b.identity.id);
    assert.equal(apiIdentities.listIdentities().length, 2);
  });

  it('refuses an identity with no permissions', () => {
    assert.throws(() => create({ permissions: [] }), /at least one permission/);
  });

  it('refuses an unknown permission instead of dropping it', () => {
    assert.throws(() => create({ permissions: ['network.read', 'not.a.permission'] }), /Unknown permission/);
    assert.deepEqual(apiIdentities.listIdentities(), []);
  });

  it('requires an expiry and rejects one beyond the maximum', () => {
    assert.throws(() => create({ expiresInMs: undefined }), /requires an expiry/);
    assert.throws(() => create({ expiresInMs: apiIdentities.MAX_TTL_MS + 1 }), /exceeds the maximum/);
    assert.throws(() => create({ expiresInMs: 1 }), /too short/);
  });

  it('requires a label within bounds', () => {
    assert.throws(() => create({ label: '   ' }), /label is required/);
    assert.throws(() => create({ label: 'x'.repeat(101) }), /at most 100 characters/);
  });

  it('caps the number of active identities', () => {
    for (let i = 0; i < apiIdentities.MAX_ACTIVE_IDENTITIES; i++) create({ label: `id-${i}` });
    assert.throws(() => create({ label: 'one-too-many' }), /At most 25 active/);
  });
});

describe('API identity verification', () => {
  it('resolves only the granted permissions', () => {
    const { token } = create({ permissions: [PERMISSIONS.NETWORK_READ, PERMISSIONS.NOTES_WRITE] });
    const resolved = apiIdentities.verifyToken(token);
    assert.deepEqual([...resolved.permissions].sort(), ['network.read', 'notes.write']);
    assert.equal(resolved.permissions.length !== ALL_PERMISSIONS.length, true);
  });

  it('rejects an unknown token', () => {
    create();
    assert.equal(apiIdentities.verifyToken(`egv_${crypto.randomBytes(32).toString('hex')}`), null);
  });

  it('rejects empty and malformed input without throwing', () => {
    create();
    for (const value of ['', null, undefined, 0, {}, []]) {
      assert.equal(apiIdentities.verifyToken(value), null);
    }
  });

  it('rejects a revoked token immediately', () => {
    const { token, identity } = create();
    assert.ok(apiIdentities.verifyToken(token));
    assert.equal(apiIdentities.revokeIdentity(identity.id), true);
    assert.equal(apiIdentities.verifyToken(token), null);
  });

  it('rejects an expired token', () => {
    const { token } = create({ expiresInMs: HOUR });
    const afterExpiry = Date.now() + 2 * HOUR;
    assert.equal(apiIdentities.verifyToken(token, { now: afterExpiry }), null);
  });

  it('revokes one identity without affecting the others', () => {
    const keep = create({ label: 'keep' });
    const drop = create({ label: 'drop' });
    apiIdentities.revokeIdentity(drop.identity.id);
    assert.equal(apiIdentities.verifyToken(drop.token), null);
    assert.ok(apiIdentities.verifyToken(keep.token));
  });

  it('reports revocation of an unknown or already revoked identity', () => {
    const { identity } = create();
    assert.equal(apiIdentities.revokeIdentity('no-such-id'), false);
    assert.equal(apiIdentities.revokeIdentity(identity.id), true);
    assert.equal(apiIdentities.revokeIdentity(identity.id), false);
  });

  it('records last use without exposing the token', () => {
    const { token, identity } = create();
    assert.equal(apiIdentities.listIdentities().find(i => i.id === identity.id).lastUsedAt, null);
    apiIdentities.verifyToken(token);
    const used = apiIdentities.listIdentities().find(i => i.id === identity.id);
    assert.equal(typeof used.lastUsedAt, 'number');
    assert.equal(JSON.stringify(used).includes(token), false);
  });
});

describe('API identity fail-closed behaviour', () => {
  it('denies a record whose stored permissions are not valid JSON', () => {
    const { token, identity } = create();
    assert.ok(apiIdentities.verifyToken(token));
    apiIdentities._writeRawPermissionsForTest(identity.id, 'not json');
    assert.equal(apiIdentities.verifyToken(token), null);
  });

  it('denies a record naming a permission this build does not define', () => {
    const { token, identity } = create();
    apiIdentities._writeRawPermissionsForTest(identity.id, JSON.stringify(['network.read', 'future.capability']));
    assert.equal(apiIdentities.verifyToken(token), null);
  });

  it('denies a record whose permission list is empty or the wrong shape', () => {
    const { token, identity } = create();
    for (const raw of ['[]', '{}', '"network.read"', '[1,2]', 'null']) {
      apiIdentities._writeRawPermissionsForTest(identity.id, raw);
      assert.equal(apiIdentities.verifyToken(token), null, `raw permissions ${raw} must not grant access`);
    }
  });

  it('surfaces an untrusted record as granting nothing when listed', () => {
    const { identity } = create();
    apiIdentities._writeRawPermissionsForTest(identity.id, 'not json');
    const listed = apiIdentities.listIdentities().find(i => i.id === identity.id);
    assert.deepEqual(listed.permissions, []);
    assert.equal(listed.permissionsValid, false);
  });

  it('denies a token once the store is closed', () => {
    const { token } = create();
    apiIdentities.closeDb();
    assert.equal(apiIdentities.verifyToken(token), null);
    assert.deepEqual(apiIdentities.listIdentities(), []);
    assert.equal(apiIdentities.revokeIdentity('any'), false);
  });

  it('prunes only long-expired records', () => {
    create({ label: 'live', expiresInMs: HOUR });
    const now = Date.now();
    assert.equal(apiIdentities.pruneExpired({ now }), 0);
    assert.equal(apiIdentities.listIdentities().length, 1);
    const farFuture = now + 400 * 24 * HOUR;
    assert.equal(apiIdentities.pruneExpired({ now: farFuture }), 1);
    assert.deepEqual(apiIdentities.listIdentities(), []);
  });
});

describe('API identity credential separation', () => {
  const { createAuthMiddleware } = require('../../src/auth-middleware');

  function makeBoundary() {
    return createAuthMiddleware({
      appState: { adminToken: 'legacy-admin-token' }, // pragma: allowlist secret
      sessions: { verifySession: () => null },
      authCookies: { sessionToken: req => req.cookieToken || '', verifyCookieCsrf: () => true },
      authAudit: { append: () => {} },
      apiIdentities,
    });
  }

  function request(headers = {}, cookieToken = '') {
    return {
      method: 'GET',
      originalUrl: '/api/devices',
      get: name => headers[name] || '',
      cookieToken,
    };
  }

  it('accepts an API identity presented as a header credential', () => {
    const { token } = create();
    const auth = makeBoundary().authenticateRequest(request({ 'X-Admin-Token': token }));
    assert.equal(auth.source, 'header');
    assert.equal(auth.auth.kind, 'api-identity');
    assert.deepEqual(auth.auth.identity.permissions, ['network.read']);
  });

  it('enforces auth.admin on API identity management routes', () => {
    function response() {
      return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        on() {},
      };
    }

    const readOnly = create({ permissions: [PERMISSIONS.NETWORK_READ] });
    const denied = response();
    makeBoundary().enforceApiPermissions({
      ...request({ 'X-Admin-Token': readOnly.token }),
      originalUrl: '/api/auth/api-identities',
    }, denied, () => assert.fail('read-only identity must not manage credentials'));
    assert.equal(denied.statusCode, 403);

    const administrator = create({ permissions: [PERMISSIONS.AUTH_ADMIN] });
    let allowed = false;
    makeBoundary().enforceApiPermissions({
      ...request({ 'X-Admin-Token': administrator.token }),
      originalUrl: '/api/auth/api-identities',
    }, response(), () => { allowed = true; });
    assert.equal(allowed, true);
  });

  it('refuses to accept an API identity as a browser session cookie', () => {
    const { token } = create();
    assert.equal(makeBoundary().authenticateRequest(request({}, token)), null);
  });

  it('keeps the legacy admin token working during the expand phase', () => {
    const auth = makeBoundary().authenticateRequest(request({ 'X-Admin-Token': 'legacy-admin-token' }));
    assert.equal(auth.auth, 'admin');
  });

  it('resolves a scoped identity to fewer permissions than the legacy token', () => {
    const { checkPermissions } = require('../../src/permissions');
    const { token } = create({ permissions: [PERMISSIONS.NETWORK_READ] });
    const identity = apiIdentities.verifyToken(token);
    assert.equal(checkPermissions(identity.permissions, [PERMISSIONS.NETWORK_READ]).allowed, true);
    assert.equal(checkPermissions(identity.permissions, [PERMISSIONS.AUTH_ADMIN]).allowed, false);
    assert.equal(checkPermissions(ALL_PERMISSIONS, [PERMISSIONS.AUTH_ADMIN]).allowed, true);
  });
});
