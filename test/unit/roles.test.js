// Browser session roles and their permission table (P2-61 Phase 3).
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLES,
  ALL_ROLES,
  ROLE_PERMISSIONS,
  isKnownRole,
  permissionsForRole,
  normalizeRole,
  roleForOidcMatch,
} = require('../../src/roles');
const { PERMISSIONS, ALL_PERMISSIONS, checkPermissions } = require('../../src/permissions');
const { HTTP_ROUTE_MATRIX, ACCESS } = require('../../src/permission-matrix');

describe('role permission table', () => {
  it('pins exactly what each role may do', () => {
    assert.deepEqual([...ROLE_PERMISSIONS[ROLES.VIEWER]].sort(), ['network.read']);
    assert.deepEqual([...ROLE_PERMISSIONS[ROLES.OPERATOR]].sort(), ['ai.run', 'network.read', 'notes.write']);
    assert.deepEqual([...ROLE_PERMISSIONS[ROLES.ADMIN]].sort(), [...ALL_PERMISSIONS].sort());
  });

  it('keeps every role permission inside the registry', () => {
    for (const role of ALL_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        assert.ok(ALL_PERMISSIONS.includes(permission), `${role} references unknown ${permission}`);
      }
    }
  });

  it('nests viewer inside operator inside admin', () => {
    for (const permission of ROLE_PERMISSIONS[ROLES.VIEWER]) {
      assert.ok(ROLE_PERMISSIONS[ROLES.OPERATOR].includes(permission));
    }
    for (const permission of ROLE_PERMISSIONS[ROLES.OPERATOR]) {
      assert.ok(ROLE_PERMISSIONS[ROLES.ADMIN].includes(permission));
    }
  });

  it('withholds settings, backup, auth and audit from viewer and operator', () => {
    for (const role of [ROLES.VIEWER, ROLES.OPERATOR]) {
      for (const permission of [
        PERMISSIONS.SETTINGS_WRITE,
        PERMISSIONS.BACKUP_RESTORE,
        PERMISSIONS.AUTH_ADMIN,
        PERMISSIONS.AUDIT_READ,
      ]) {
        assert.equal(
          checkPermissions(permissionsForRole(role), [permission]).allowed,
          false,
          `${role} must not hold ${permission}`
        );
      }
    }
  });

  it('withholds mutation from viewer', () => {
    for (const permission of [PERMISSIONS.NOTES_WRITE, PERMISSIONS.AI_RUN]) {
      assert.equal(checkPermissions(permissionsForRole(ROLES.VIEWER), [permission]).allowed, false);
    }
  });
});

describe('role resolution is fail-closed', () => {
  it('grants nothing for an unknown, missing, or malformed role', () => {
    for (const value of [undefined, null, '', 'superuser', 'ADMIN', 0, {}, []]) {
      assert.deepEqual(permissionsForRole(value), [], `role ${JSON.stringify(value)} must grant nothing`);
    }
  });

  it('never widens an unknown role to a broader one', () => {
    assert.equal(checkPermissions(permissionsForRole('not-a-role'), [PERMISSIONS.NETWORK_READ]).allowed, false);
  });

  it('refuses to normalize a role this build does not define', () => {
    assert.equal(normalizeRole('admin'), 'admin');
    assert.equal(normalizeRole('viewer'), 'viewer');
    assert.equal(normalizeRole('root'), null);
    assert.equal(normalizeRole(undefined), null);
    assert.equal(isKnownRole('operator'), true);
    assert.equal(isKnownRole('Operator'), false);
  });
});

describe('OIDC role assignment', () => {
  it('makes an explicitly listed email an administrator', () => {
    assert.equal(roleForOidcMatch('email'), ROLES.ADMIN);
  });

  it('defaults a bulk domain grant to viewer', () => {
    assert.equal(roleForOidcMatch('domain'), ROLES.VIEWER);
  });

  it('refuses to assign a role without a match', () => {
    for (const value of [null, undefined, '', 'admin', 'other']) {
      assert.equal(roleForOidcMatch(value), null);
    }
  });

  it('cannot be steered by a caller-supplied role value', () => {
    // Only 'email' and 'domain' produce a role; anything a caller could inject
    // resolves to null and therefore to no session at all.
    assert.equal(roleForOidcMatch('viewer'), null);
    assert.equal(roleForOidcMatch({ role: 'admin' }), null);
  });
});

describe('role coverage of the route matrix', () => {
  it('lets an admin reach every permission-gated route', () => {
    const adminPermissions = permissionsForRole(ROLES.ADMIN);
    for (const entry of HTTP_ROUTE_MATRIX) {
      if (entry.access !== ACCESS.PERMISSION) continue;
      assert.equal(
        checkPermissions(adminPermissions, entry.permissions).allowed,
        true,
        `admin must reach ${entry.method} ${entry.path}`
      );
    }
  });

  it('leaves at least one route unreachable for viewer and operator', () => {
    for (const role of [ROLES.VIEWER, ROLES.OPERATOR]) {
      const denied = HTTP_ROUTE_MATRIX.filter(
        entry => entry.access === ACCESS.PERMISSION &&
          !checkPermissions(permissionsForRole(role), entry.permissions).allowed
      );
      assert.ok(denied.length > 0, `${role} must not reach every route`);
    }
  });

  it('keeps viewer out of every route that writes', () => {
    const writeRoutes = HTTP_ROUTE_MATRIX.filter(
      entry => entry.access === ACCESS.PERMISSION && entry.method !== 'GET'
    );
    assert.ok(writeRoutes.length > 0);
    for (const entry of writeRoutes) {
      assert.equal(
        checkPermissions(permissionsForRole(ROLES.VIEWER), entry.permissions).allowed,
        false,
        `viewer must not reach ${entry.method} ${entry.path}`
      );
    }
  });
});

describe('role enforcement through the API boundary', () => {
  const { createAuthMiddleware } = require('../../src/auth-middleware');

  function boundary(session) {
    return createAuthMiddleware({
      appState: { adminToken: 'legacy-admin-token' }, // pragma: allowlist secret
      sessions: { verifySession: token => (token === 'session-token' ? session : null) },
      authCookies: { sessionToken: req => req.cookieToken || '', verifyCookieCsrf: () => true },
      authAudit: { append: () => {} },
    });
  }

  function run(session, method, url, headers = {}) {
    const req = {
      method,
      originalUrl: url,
      get: name => headers[name] || '',
      cookieToken: headers.cookie || '',
    };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
      on() {},
    };
    let reached = false;
    boundary(session).enforceApiPermissions(req, res, () => { reached = true; });
    return { statusCode: reached ? 200 : res.statusCode, reached, body: res.body, req };
  }

  const viewer = { id: 1, role: 'viewer', authMethod: 'oidc' };
  const operator = { id: 2, role: 'operator', authMethod: 'oidc' };
  const admin = { id: 3, role: 'admin', authMethod: 'local' };
  const cookie = { cookie: 'session-token' };

  it('lets a viewer read but returns 403 on every write', () => {
    assert.equal(run(viewer, 'GET', '/api/devices', cookie).reached, true);
    for (const [method, url] of [
      ['POST', '/api/notes'],
      ['POST', '/api/auth/security-config'],
      ['GET', '/api/auth/sessions'],
    ]) {
      const result = run(viewer, method, url, cookie);
      assert.equal(result.statusCode, 403, `viewer ${method} ${url} must be 403`);
      assert.equal(result.reached, false);
    }
  });

  it('lets an operator write notes but not touch settings or auth', () => {
    assert.equal(run(operator, 'POST', '/api/notes', cookie).reached, true);
    assert.equal(run(operator, 'GET', '/api/auth/sessions', cookie).statusCode, 403);
    assert.equal(run(operator, 'POST', '/api/auth/security-config', cookie).statusCode, 403);
  });

  it('lets an admin through everywhere a viewer is refused', () => {
    for (const [method, url] of [
      ['POST', '/api/notes'],
      ['GET', '/api/auth/sessions'],
      ['POST', '/api/auth/security-config'],
    ]) {
      assert.equal(run(admin, method, url, cookie).reached, true, `admin ${method} ${url}`);
    }
  });

  it('keeps the legacy admin token at full access', () => {
    const headers = { 'X-Admin-Token': 'legacy-admin-token' }; // pragma: allowlist secret
    assert.equal(run(null, 'GET', '/api/auth/sessions', headers).reached, true);
    assert.equal(run(null, 'POST', '/api/auth/security-config', headers).reached, true);
  });

  it('denies a session whose stored role is unreadable', () => {
    const broken = { id: 4, role: 'superuser', authMethod: 'oidc' };
    assert.equal(run(broken, 'GET', '/api/devices', cookie).statusCode, 403);
    const missing = { id: 5, authMethod: 'oidc' };
    assert.equal(run(missing, 'GET', '/api/devices', cookie).statusCode, 403);
  });

  it('ignores a role supplied on the request itself', () => {
    const result = run(viewer, 'GET', '/api/auth/sessions', { ...cookie, 'X-Role': 'admin' });
    assert.equal(result.statusCode, 403);
    // The resolved permissions come from the stored session, not the header.
    assert.deepEqual([...result.req.permissions], ['network.read']);
  });

  it('keeps unclassified routes denied regardless of role', () => {
    assert.equal(run(admin, 'GET', '/api/unclassified', cookie).statusCode, 404);
    assert.equal(run(viewer, 'GET', '/api/unclassified', cookie).statusCode, 404);
  });
});
