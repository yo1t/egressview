'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const agentIdentities = require('../../src/agent-identities');
const { AGENT_PERMISSIONS } = require('../../src/permissions');

const BASE_TIME = Date.parse('2026-08-11T12:00:00Z');
const metadata = Object.freeze({
  hostName: 'test-mac',
  platform: 'macos',
  osVersion: '26.5.2',
  agentVersion: '0.1.13',
});

beforeEach(() => agentIdentities._initForTest());
after(() => agentIdentities.closeDb());

function enroll(options = {}) {
  const created = agentIdentities.createEnrollment(
    { createdBy: 'local:admin' },
    { now: BASE_TIME }
  );
  return {
    enrollment: created,
    result: agentIdentities.enroll(
      { code: created.code, metadata },
      { now: options.now || BASE_TIME + 1 }
    ),
  };
}

describe('Agent enrollment', () => {
  it('returns both credentials exactly once without exposing their hashes', () => {
    const { enrollment, result } = enroll();
    assert.match(enrollment.code, /^egve_[0-9a-f]{48}$/);
    assert.match(result.token, /^egva_[0-9a-f]{64}$/);
    assert.match(result.agent.agentId, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(result.agent).includes(result.token), false);
    assert.equal(Object.hasOwn(result.agent, 'tokenHash'), false);
    assert.equal(agentIdentities.enroll({ code: enrollment.code, metadata }), null);
  });

  it('rejects expired, malformed, and unknown enrollment codes', () => {
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    assert.equal(agentIdentities.enroll({
      code: created.code,
      metadata,
    }, { now: BASE_TIME + agentIdentities.ENROLLMENT_TTL_MS + 1 }), null);
    assert.equal(agentIdentities.enroll({ code: 'invalid', metadata }), null);
    assert.equal(agentIdentities.enroll({ code: `egve_${'f'.repeat(48)}`, metadata }), null);
  });

  it('caps simultaneously active enrollment codes', () => {
    for (let i = 0; i < agentIdentities.MAX_ACTIVE_ENROLLMENTS; i++) {
      agentIdentities.createEnrollment({}, { now: BASE_TIME });
    }
    assert.throws(
      () => agentIdentities.createEnrollment({}, { now: BASE_TIME }),
      /At most 20 active/
    );
  });
});

describe('Agent credential lifecycle', () => {
  it('grants only agent.ingest and records last use', () => {
    const { result } = enroll();
    const verified = agentIdentities.verifyAgentToken(result.token, { now: BASE_TIME + 2 });
    assert.deepEqual(verified.permissions, [AGENT_PERMISSIONS.INGEST]);
    assert.equal(verified.lastSeenAt, BASE_TIME + 2);
    assert.equal(agentIdentities.listAgents()[0].lastSeenAt, BASE_TIME + 2);
  });

  it('throttles last-seen writes without reporting an unpersisted timestamp', () => {
    const { result } = enroll();
    const first = agentIdentities.verifyAgentToken(result.token, { now: BASE_TIME + 2 });
    const second = agentIdentities.verifyAgentToken(result.token, { now: BASE_TIME + 3 });
    assert.equal(second.lastSeenAt, first.lastSeenAt);
    assert.equal(agentIdentities.listAgents()[0].lastSeenAt, first.lastSeenAt);
  });

  it('rotation invalidates the old token immediately', () => {
    const { result } = enroll();
    const rotated = agentIdentities.rotateAgentToken(
      result.agent.agentId,
      result.token,
      { now: BASE_TIME + 10 }
    );
    assert.match(rotated.token, /^egva_[0-9a-f]{64}$/);
    assert.equal(agentIdentities.verifyAgentToken(result.token), null);
    assert.ok(agentIdentities.verifyAgentToken(rotated.token));
  });

  it('allows only one winner when the same old token is rotated twice', () => {
    const { result } = enroll();
    const first = agentIdentities.rotateAgentToken(result.agent.agentId, result.token);
    const second = agentIdentities.rotateAgentToken(result.agent.agentId, result.token);
    assert.ok(first);
    assert.equal(second, null);
    assert.ok(agentIdentities.verifyAgentToken(first.token));
  });

  it('revocation denies the token without deleting public identity metadata', () => {
    const { result } = enroll();
    assert.equal(agentIdentities.revokeAgent(result.agent.agentId, { now: BASE_TIME + 10 }), true);
    assert.equal(agentIdentities.verifyAgentToken(result.token), null);
    const listed = agentIdentities.listAgents()[0];
    assert.equal(listed.revokedAt, BASE_TIME + 10);
    assert.equal(Object.hasOwn(listed, 'tokenHash'), false);
    assert.equal(agentIdentities.revokeAgent(result.agent.agentId), false);
  });

  it('a different pepper cannot verify an existing token', () => {
    const { result } = enroll();
    agentIdentities.setPepper('b'.repeat(64));
    assert.equal(agentIdentities.verifyAgentToken(result.token), null);
  });

  it('rejects malformed agent bearer values without throwing', () => {
    enroll();
    for (const value of ['', null, undefined, {}, 'egva_short']) {
      assert.equal(agentIdentities.verifyAgentToken(value), null);
    }
  });
});

describe('Agent credential separation', () => {
  const { createAuthMiddleware } = require('../../src/auth-middleware');

  function boundary(audits = []) {
    return createAuthMiddleware({
      appState: { adminToken: 'local-admin-value' }, // pragma: allowlist secret
      sessions: { verifySession: () => null },
      authCookies: { sessionToken: () => '', verifyCookieCsrf: () => true },
      authAudit: { append: event => audits.push(event) },
      agentIdentities,
    });
  }

  function response() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      on() {},
    };
  }

  function request(path, headers = {}) {
    return {
      method: 'POST',
      originalUrl: path,
      get: name => headers[name] || '',
    };
  }

  it('accepts Agent bearer only on Agent-classified routes', () => {
    const { result } = enroll();
    let allowed = false;
    const req = request('/api/agent/token/rotate', { Authorization: `Bearer ${result.token}` });
    boundary().enforceApiPermissions(req, response(), () => { allowed = true; });
    assert.equal(allowed, true);
    assert.equal(req.agentIdentity.agentId, result.agent.agentId);
  });

  it('does not accept browser/API credentials at the Agent boundary', () => {
    const audits = [];
    const res = response();
    boundary(audits).enforceApiPermissions(
      request('/api/agent/token/rotate', { 'X-Admin-Token': 'local-admin-value' }),
      res,
      () => assert.fail('admin credential must not become an Agent credential')
    );
    assert.equal(res.statusCode, 401);
    assert.equal(audits[0].eventType, 'agent_authentication');
    assert.equal(JSON.stringify(audits).includes('local-admin-value'), false);
  });

  it('does not accept an Agent bearer on a browser management route', () => {
    const { result } = enroll();
    const res = response();
    boundary().enforceApiPermissions(
      { ...request('/api/agents'), method: 'GET', get: name => (
        name === 'Authorization' ? `Bearer ${result.token}` : ''
      ) },
      res,
      () => assert.fail('Agent credential must not manage Agents')
    );
    assert.equal(res.statusCode, 401);
  });
});
