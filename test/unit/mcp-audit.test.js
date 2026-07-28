// Append-only audit for the remote MCP endpoint (P2-60 PR 4).
'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const mcpAudit = require('../../src/mcp-audit');

beforeEach(() => mcpAudit._resetForTest());
after(() => mcpAudit.closeDb());

describe('MCP audit records', () => {
  it('records who, which tool, which scopes and how long it took', () => {
    mcpAudit.append({
      eventType: 'mcp_tool_call',
      outcome: 'success',
      subject: 'https://issuer.example|user-1',
      clientId: 'https://client.example/metadata.json',
      toolName: 'get_devices',
      scopes: ['egressview:read'],
      requestId: 'req-1',
      durationMs: 42,
    });
    const [row] = mcpAudit.list();
    assert.equal(row.eventType, 'mcp_tool_call');
    assert.equal(row.outcome, 'success');
    assert.equal(row.toolName, 'get_devices');
    assert.equal(row.scopes, 'egressview:read');
    assert.equal(row.requestId, 'req-1');
    assert.equal(row.durationMs, 42);
  });

  it('pseudonymises the subject and client, storing neither in the clear', () => {
    const subject = 'https://issuer.example|user-1';
    const clientId = 'https://client.example/metadata.json';
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success', subject, clientId });
    const [row] = mcpAudit.list();
    assert.match(row.subjectHash, /^[0-9a-f]{64}$/);
    assert.match(row.clientIdHash, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes(subject), false);
    assert.equal(serialized.includes(clientId), false);
    assert.equal(serialized.includes('issuer.example'), false);
  });

  it('gives the same subject the same pseudonym so activity correlates', () => {
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success', subject: 'same' });
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'failure', subject: 'same' });
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success', subject: 'other' });
    // Newest first: 'other', then the two 'same' rows.
    const rows = mcpAudit.list();
    assert.equal(rows[1].subjectHash, rows[2].subjectHash, 'one subject correlates across events');
    assert.notEqual(rows[0].subjectHash, rows[1].subjectHash, 'a different subject does not');
  });

  it('never stores tool arguments, note bodies, tokens or raw JWTs', () => {
    // These fields are not part of the accepted shape; passing them must not
    // smuggle anything into the row.
    mcpAudit.append({
      eventType: 'mcp_tool_call',
      outcome: 'success',
      toolName: 'set_device_note',
      args: { ip: '198.51.100.7', note: 'personal note body' },
      token: 'egv_secret_token_value',
      rawJwt: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
      providerError: 'token signature mismatch for kid=abc',
    });
    const serialized = JSON.stringify(mcpAudit.list());
    for (const forbidden of [
      '198.51.100.7', 'personal note body', 'egv_secret_token_value',
      'eyJhbGciOiJSUzI1NiJ9', 'kid=abc',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must not be stored`);
    }
  });

  it('bounds free-text fields so one caller cannot inflate the store', () => {
    mcpAudit.append({
      eventType: 'mcp_tool_call',
      outcome: 'failure',
      toolName: 'x'.repeat(500),
      reason: 'y'.repeat(500),
      requestId: 'z'.repeat(500),
      scopes: Array.from({ length: 200 }, (_, i) => `scope-${i}`),
    });
    const [row] = mcpAudit.list();
    assert.ok(row.toolName.length <= 100);
    assert.ok(row.reason.length <= 60);
    assert.ok(row.requestId.length <= 100);
    assert.ok(row.scopes.length <= 300);
  });
});

describe('MCP audit failure classification', () => {
  it('keeps a reason code for each rejection type', () => {
    for (const reason of [
      'invalid_token', 'insufficient_scope', 'global_rate_limit',
      'subject_rate_limit', 'client_rate_limit', 'concurrency_limit',
    ]) {
      mcpAudit.append({ eventType: 'mcp_rate_limited', outcome: 'failure', reason });
    }
    const reasons = mcpAudit.list().map(r => r.reason).sort();
    assert.deepEqual(reasons, [
      'client_rate_limit', 'concurrency_limit', 'global_rate_limit',
      'insufficient_scope', 'invalid_token', 'subject_rate_limit',
    ]);
  });

  it('counts failures by type and reason for spotting a run of them', () => {
    for (let i = 0; i < 3; i++) {
      mcpAudit.append({ eventType: 'mcp_request', outcome: 'failure', reason: 'invalid_token' });
    }
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success' });
    const summary = mcpAudit.summary();
    const invalid = summary.find(s => s.reason === 'invalid_token');
    assert.equal(invalid.count, 3);
    assert.equal(invalid.outcome, 'failure');
  });

  it('coerces an unexpected outcome to failure rather than storing it', () => {
    mcpAudit.append({ eventType: 'mcp_request', outcome: 'maybe' });
    assert.equal(mcpAudit.list()[0].outcome, 'failure');
  });
});

describe('MCP audit resilience', () => {
  it('never throws when the store is unavailable', () => {
    mcpAudit.closeDb();
    assert.doesNotThrow(() => mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success' }));
    assert.equal(mcpAudit.append({ eventType: 'x', outcome: 'success' }), null);
    assert.deepEqual(mcpAudit.list(), []);
    assert.equal(mcpAudit.prune(), 0);
    assert.deepEqual(mcpAudit.summary(), []);
  });

  it('stores nothing identifying when no hash key is configured', () => {
    mcpAudit._resetForTest(':memory:', { withoutHashKey: true });
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success', subject: 'user-1' });
    const [row] = mcpAudit.list();
    // A bare SHA-256 of a short identifier would be trivially reversible, so
    // the field stays empty instead.
    assert.equal(row.subjectHash, null);
  });

  it('prunes only entries older than the retention window', () => {
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success' });
    assert.equal(mcpAudit.prune({ retentionDays: 90 }), 0);
    assert.equal(mcpAudit.list().length, 1);
    // Evaluate retention from a point well past the window.
    const later = Date.now() + 91 * 24 * 60 * 60 * 1000;
    assert.equal(mcpAudit.prune({ retentionDays: 90, now: later }), 1);
    assert.deepEqual(mcpAudit.list(), []);
  });

  it('returns newest first and honours the limit', () => {
    for (let i = 0; i < 5; i++) {
      mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success', requestId: `r${i}` });
    }
    assert.equal(mcpAudit.list({ limit: 2 }).length, 2);
    assert.equal(mcpAudit.list()[0].requestId, 'r4');
  });
});

describe('audit correlation between the two stores', () => {
  const { _createApiClient: createApiClient } = require('../../mcp-server.js');

  function captureFetch() {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), headers: options.headers || {} });
      return { ok: true, json: async () => ({}) };
    };
    return { calls, restore: () => { global.fetch = original; } };
  }

  it('forwards the MCP request id to EgressView so both trails can be joined', async () => {
    const { calls, restore } = captureFetch();
    try {
      const client = createApiClient({ base: 'http://api.test', token: 'tkn' }); // pragma: allowlist secret
      await client.withRequestId('req-join-1').get('/devices');
      await client.withRequestId('req-join-1').post('/notes', { ip: '10.0.0.1' });
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.headers['X-Request-Id'], 'req-join-1');
      }
    } finally {
      restore();
    }
  });

  it('omits the header when no request id is bound', async () => {
    const { calls, restore } = captureFetch();
    try {
      await createApiClient({ base: 'http://api.test', token: 'tkn' }).get('/devices'); // pragma: allowlist secret
      assert.equal('X-Request-Id' in calls[0].headers, false);
    } finally {
      restore();
    }
  });

  it('keeps the audited request id in the same shape that is forwarded', () => {
    mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success', requestId: 'req-join-1' });
    assert.equal(mcpAudit.list()[0].requestId, 'req-join-1');
  });
});
