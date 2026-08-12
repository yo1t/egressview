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

/**
 * Runs the whole three-step flow: issue a code, apply with it, approve.
 *
 * Enrolment is no longer a single call, so a helper keeps the lifecycle tests
 * readable while the enrolment tests below exercise the steps individually.
 */
function enroll(options = {}) {
  const created = agentIdentities.createEnrollment(
    { createdBy: 'local:admin' },
    { now: BASE_TIME }
  );
  const request = agentIdentities.requestEnrollment(
    { code: created.code, metadata },
    { now: options.now || BASE_TIME + 1 }
  );
  agentIdentities.approveRequest(
    request.requestId,
    { decidedBy: 'local:admin' },
    { now: options.now || BASE_TIME + 2 }
  );
  const claimed = agentIdentities.claimApproved(
    { requestId: request.requestId, claimSecret: request.claimSecret },
    { now: options.now || BASE_TIME + 3 }
  );
  return {
    enrollment: created,
    request,
    result: { token: claimed.token, agent: agentIdentities.listAgents()[0] },
  };
}

describe('Agent enrollment', () => {
  it('六文字の英数字コードを発行し、紛らわしい文字を含めない', () => {
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    assert.match(created.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    // 0/O と 1/I は転記ミスを試行回数の消費に変えるため除外している。
    assert.equal(/[01OI]/.test(created.code), false);
  });

  it('コードだけでは登録が完了せず、申請にとどまる', () => {
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    const request = agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 1 });
    assert.equal(request.ok, true);
    // ここが本specの要。承認前にagentが生えてはいけない。
    assert.deepEqual(agentIdentities.listAgents(), []);
    assert.equal(
      agentIdentities.claimApproved(
        { requestId: request.requestId, claimSecret: request.claimSecret },
        { now: BASE_TIME + 2 }
      ).status,
      'pending'
    );
  });

  it('承認して初めてtokenが発行され、受け取れるのは一度きり', () => {
    const { request, result } = enroll();
    assert.match(result.token, /^egva_[0-9a-f]{64}$/);
    assert.equal(
      agentIdentities.claimApproved({ requestId: request.requestId, claimSecret: request.claimSecret }).status,
      'collected'
    );
  });

  it('claim secretが違えば、requestIdを知っていても取得できない', () => {
    const { request } = enroll();
    assert.equal(
      agentIdentities.claimApproved({ requestId: request.requestId, claimSecret: `egvc_${'0'.repeat(64)}` }).status,
      'unknown'
    );
  });

  it('五回失敗したコードは、その後正しく入力しても使えない', () => {
    // 6文字コードが成立する唯一の理由がこれ。上限が無ければ10分間の総当たりが現実的になる。
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    for (let i = 1; i < agentIdentities.MAX_CODE_ATTEMPTS; i++) {
      assert.equal(agentIdentities.recordCodeAttempt(created.code, { now: BASE_TIME + 1 }).locked, false);
    }
    assert.equal(agentIdentities.recordCodeAttempt(created.code, { now: BASE_TIME + 1 }).locked, true);
    assert.equal(
      agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 1 }).reason,
      'locked'
    );
  });

  it('存在しないコードへの失敗は、他人の有効なコードを巻き添えにしない', () => {
    // 未知のコードを数えると、周辺を総当たりして他人のコードをロックできてしまう。
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    for (let i = 0; i < agentIdentities.MAX_CODE_ATTEMPTS + 3; i++) {
      agentIdentities.recordCodeAttempt('ZZZZZZ');
    }
    assert.equal(agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 1 }).ok, true);
  });

  it('期限切れ・不正形式のコードを拒否する', () => {
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    assert.equal(
      agentIdentities.requestEnrollment({ code: created.code, metadata },
        { now: BASE_TIME + agentIdentities.ENROLLMENT_TTL_MS + 1 }).reason,
      'invalid_code'
    );
    assert.equal(agentIdentities.requestEnrollment({ code: 'bad', metadata }).reason, 'invalid_code');
    assert.equal(agentIdentities.requestEnrollment({ code: '000000', metadata }).reason, 'invalid_code');
  });

  it('未承認の申請は10分で失効する', () => {
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    const request = agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 1 });
    const expired = agentIdentities.expireStaleRequests({ now: BASE_TIME + agentIdentities.REQUEST_TTL_MS + 2 });
    assert.equal(expired, 1);
    assert.equal(
      agentIdentities.claimApproved({ requestId: request.requestId, claimSecret: request.claimSecret }).status,
      'expired'
    );
  });

  it('却下された申請はtokenを渡さない', () => {
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    const request = agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 1 });
    assert.equal(agentIdentities.rejectRequest(request.requestId, { decidedBy: 'local:admin' }), true);
    assert.equal(
      agentIdentities.claimApproved({ requestId: request.requestId, claimSecret: request.claimSecret }).status,
      'rejected'
    );
    assert.deepEqual(agentIdentities.listAgents(), []);
  });

  it('同じホスト名の既存端末を承認画面へ知らせる', () => {
    enroll();
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME + 10 });
    agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 11 });
    assert.equal(agentIdentities.listPendingRequests({ now: BASE_TIME + 12 })[0].duplicateHostName, true);
  });

  it('置き換え承認は旧agentをrevokeするが、行は消さない', () => {
    // 観測データは旧agentIdへ紐づいている。行を消すと履歴の帰属が失われる。
    const first = enroll();
    const created = agentIdentities.createEnrollment({}, { now: BASE_TIME + 10 });
    const request = agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 11 });
    agentIdentities.approveRequest(request.requestId, { replaceExisting: true }, { now: BASE_TIME + 12 });
    const agents = agentIdentities.listAgents();
    assert.equal(agents.length, 2);
    assert.equal(agents.filter(a => a.revokedAt).length, 1);
    assert.equal(agentIdentities.verifyAgentToken(first.result.token), null);
  });

  it('同時に有効なコード数を制限する', () => {
    for (let i = 0; i < agentIdentities.MAX_ACTIVE_ENROLLMENTS; i++) {
      agentIdentities.createEnrollment({}, { now: BASE_TIME });
    }
    assert.throws(
      () => agentIdentities.createEnrollment({}, { now: BASE_TIME }),
      /At most 20 active/
    );
  });

  it('保留中の申請数に上限がある', () => {
    for (let i = 0; i < agentIdentities.MAX_PENDING_REQUESTS; i++) {
      const created = agentIdentities.createEnrollment({}, { now: BASE_TIME });
      agentIdentities.requestEnrollment({ code: created.code, metadata }, { now: BASE_TIME + 1 });
    }
    const extra = agentIdentities.createEnrollment({}, { now: BASE_TIME });
    assert.equal(
      agentIdentities.requestEnrollment({ code: extra.code, metadata }, { now: BASE_TIME + 1 }).reason,
      'too_many_pending'
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
