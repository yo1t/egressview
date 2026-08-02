// End-to-end checks of the public MCP middleware chain (P2-60 PR 4 review).
//
// The component tests cover the limiter and the audit store in isolation, which
// is exactly why they missed a wiring bug: per-identity limits read fields the
// OAuth layer never set, and ran before authentication anyway. These tests
// drive the real HTTP chain so the order of the middleware is what is asserted.
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mcpAudit = require('../../src/mcp-audit');
const mcpServer = require('../../mcp-server.js');

const SERVICE_TOKEN = `egv_${'a'.repeat(64)}`;
const AUDIT_HASH_KEY = 'test-audit-hmac-key-that-is-independent';
const ISSUER = 'https://issuer.example';
const RESOURCE = 'https://mcp.example/mcp';

let dir;
let server;
let baseUrl;

function authConfig(overrides = {}) {
  return {
    mode: 'oauth',
    issuer: ISSUER,
    resource: RESOURCE,
    requiredScope: 'egressview:read',
    readScope: 'egressview:read',
    notesWriteScope: 'egressview:notes.write',
    serviceToken: SERVICE_TOKEN,
    auditHashKey: AUDIT_HASH_KEY,
    scopesSupported: ['egressview:read', 'egressview:notes.write'],
    ...overrides,
  };
}

function privateAuthConfig(overrides = {}) {
  return {
    mode: 'token',
    token: 'private-http-endpoint-token',
    serviceToken: SERVICE_TOKEN,
    auditHashKey: AUDIT_HASH_KEY,
    ...overrides,
  };
}

/**
 * Start the real chain against a fake issuer.
 *
 * Nothing is stubbed inside EgressView: the shipped OAuth verifier runs, mints
 * req.mcpAuth from a genuinely signed token, and the middleware order under
 * test is the production one. Only the network calls to the issuer are served
 * locally, through the fetchImpl seam the resource server already exposes.
 */
const { generateKeyPairSync, createSign } = require('node:crypto');

const KEY_ID = 'test-key-1';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, kty: 'RSA', alg: 'RS256', use: 'sig' };

function b64(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

/** Mint a real RS256 access token for the fake issuer. */
function mintToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    sub: 'user-1',
    client_id: 'client-default',
    aud: RESOURCE,
    exp: now + 300,
    iat: now,
    scope: 'egressview:read',
    ...claims,
  };
  const signingInput = `${b64({ alg: 'RS256', typ: 'JWT', kid: KEY_ID })}.${b64(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function issuerFetch(url) {
  const target = String(url);
  const body = target.includes('jwks')
    ? { keys: [jwk] }
    : {
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/jwks`,
        token_endpoint: `${ISSUER}/token`,
        // The resource server refuses an issuer that does not advertise PKCE
        // S256 — the same check that rules Cognito out.
        code_challenge_methods_supported: ['S256'],
      };
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

async function start({ limits = {}, env = {} } = {}) {
  const previous = {};
  const applied = {
    MCP_RATE_LIMIT_GLOBAL: String(limits.global ?? 1000),
    MCP_RATE_LIMIT_SUBJECT: String(limits.subject ?? 1000),
    MCP_RATE_LIMIT_CLIENT: String(limits.client ?? 1000),
    MCP_MAX_CONCURRENT: String(limits.concurrent ?? 50),
    MCP_AUDIT_DB_PATH: path.join(dir, 'audit.db'),
    ...env,
  };
  for (const [key, value] of Object.entries(applied)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  server = await mcpServer._startHttp(0, authConfig({ fetchImpl: issuerFetch }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function startPrivate({ limits = {}, env = {} } = {}) {
  const previous = {};
  const applied = {
    MCP_RATE_LIMIT_GLOBAL: String(limits.global ?? 1000),
    MCP_RATE_LIMIT_SUBJECT: String(limits.subject ?? 1000),
    MCP_RATE_LIMIT_CLIENT: String(limits.client ?? 1000),
    MCP_MAX_CONCURRENT: String(limits.concurrent ?? 50),
    MCP_AUDIT_DB_PATH: path.join(dir, 'audit.db'),
    ...env,
  };
  for (const [key, value] of Object.entries(applied)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  server = await mcpServer._startHttp(0, privateAuthConfig());
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function call(token, body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_devices' } }, extra = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-mcp-http-'));
  mcpAudit._resetForTest(path.join(dir, 'audit.db'));
});

afterEach(async () => {
  if (server) { server.close(); server = null; }
  mcpAudit.closeDb();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP HTTP boundary: per-identity limits', () => {
  it('applies the per-subject limit, which needs the identity the OAuth layer sets', async () => {
    const restore = await start({ limits: { subject: 2, global: 1000 } });
    try {
      const token = mintToken({ sub: 'user-1', client_id: 'client-a' });
      assert.notEqual((await call(token)).status, 429);
      assert.notEqual((await call(token)).status, 429);
      const third = await call(token);
      assert.equal(third.status, 429, 'the third call from one subject must be limited');
      assert.ok(third.headers.get('Retry-After'));
    } finally { restore(); }
  });

  it('limits one subject without affecting another', async () => {
    const restore = await start({ limits: { subject: 1, client: 1000, global: 1000 } });
    try {
      const a = mintToken({ sub: 'user-a', client_id: 'c' });
      const b = mintToken({ sub: 'user-b', client_id: 'c' });
      await call(a);
      assert.equal((await call(a)).status, 429);
      assert.notEqual((await call(b)).status, 429, 'a different subject keeps working');
    } finally { restore(); }
  });

  it('applies the per-client limit across different subjects', async () => {
    const restore = await start({ limits: { client: 2, subject: 1000, global: 1000 } });
    try {
      await call(mintToken({ sub: 'u1', client_id: 'shared' }));
      await call(mintToken({ sub: 'u2', client_id: 'shared' }));
      const third = await call(mintToken({ sub: 'u3', client_id: 'shared' }));
      assert.equal(third.status, 429, 'one client is limited even across subjects');
    } finally { restore(); }
  });

  it('accepts Keycloak azp as the client identifier', async () => {
    const restore = await start({ limits: { client: 1, subject: 1000, global: 1000 } });
    try {
      await call(mintToken({ sub: 'u1', client_id: undefined, azp: 'kc-client' }));
      const second = await call(mintToken({ sub: 'u2', client_id: undefined, azp: 'kc-client' }));
      assert.equal(second.status, 429, 'azp must identify the client when client_id is absent');
    } finally { restore(); }
  });

  it('rejects a token without a client identifier instead of bypassing the client limit', async () => {
    const restore = await start();
    try {
      const res = await call(mintToken({ client_id: undefined, azp: undefined }));
      assert.equal(res.status, 401);
      assert.match(res.headers.get('WWW-Authenticate'), /invalid_token/);
    } finally { restore(); }
  });

  it('counts the global budget once per request, not twice', async () => {
    const restore = await start({ limits: { global: 2, subject: 1000, client: 1000 } });
    try {
      const token = mintToken({ client_id: 'c' });
      assert.notEqual((await call(token)).status, 429);
      assert.notEqual((await call(token)).status, 429, 'two requests must fit a budget of two');
      assert.equal((await call(token)).status, 429);
    } finally { restore(); }
  });
});

describe('MCP private HTTP boundary', () => {
  it('applies global and credential limits to token-authenticated requests', async () => {
    const restore = await startPrivate({ limits: { global: 10, subject: 1, client: 10 } });
    try {
      const token = privateAuthConfig().token;
      assert.notEqual((await call(token)).status, 429);
      const second = await call(token);
      assert.equal(second.status, 429);
      assert.ok(second.headers.get('Retry-After'));
    } finally { restore(); }
  });

  it('audits the private credential without storing its token', async () => {
    const restore = await startPrivate();
    try {
      const token = privateAuthConfig().token;
      await call(token, undefined, { 'X-Request-Id': 'private-probe-1' });
      await new Promise(r => setTimeout(r, 120));
      const row = mcpAudit.list().find(r => r.requestId === 'private-probe-1');
      assert.ok(row);
      assert.match(row.subjectHash, /^[0-9a-f]{64}$/);
      assert.match(row.clientIdHash, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(mcpAudit.list()).includes(token), false);
    } finally { restore(); }
  });

  it('uses only the scoped service identity for private internal API calls', async () => {
    const restore = await startPrivate();
    const realFetch = global.fetch;
    const presentedTokens = [];
    global.fetch = (url, options = {}) => {
      if (!String(url).startsWith('http://localhost:3000/api/')) {
        return realFetch(url, options);
      }
      presentedTokens.push(options.headers?.['X-Admin-Token']);
      const body = String(url).endsWith('/api/auth/api-identities/self')
        ? { identity: { permissions: ['network.read', 'notes.write'] } }
        : { devices: [] };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    };
    try {
      const response = await call(privateAuthConfig().token, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_devices', arguments: {} },
      }, { 'X-Request-Id': 'tool-audit-probe' });
      await response.text();
      assert.ok(presentedTokens.length >= 2);
      assert.ok(presentedTokens.every(token => token === SERVICE_TOKEN));
      assert.equal(presentedTokens.includes(process.env.EGRESSVIEW_TOKEN), false);
      const rows = mcpAudit.list().filter(row => row.requestId === 'tool-audit-probe');
      assert.equal(rows.length, 1, 'handler and HTTP finish must not double-audit one tool call');
      assert.equal(rows[0].eventType, 'mcp_tool_call');
      assert.equal(rows[0].toolName, 'get_devices');
      assert.equal(rows[0].mcpMethod, 'tools/call');
      assert.equal(rows[0].outcome, 'success');
    } finally {
      global.fetch = realFetch;
      restore();
    }
  });

  it('fails closed when the private audit store is unavailable', async () => {
    mcpAudit.closeDb();
    const previous = process.env.MCP_AUDIT_DB_PATH;
    process.env.MCP_AUDIT_DB_PATH = path.join(dir, 'missing', 'audit.db');
    try {
      await assert.rejects(
        () => mcpServer._startHttp(0, privateAuthConfig()),
        'private HTTP must not run without its audit trail'
      );
    } finally {
      if (previous === undefined) delete process.env.MCP_AUDIT_DB_PATH;
      else process.env.MCP_AUDIT_DB_PATH = previous;
    }
  });
});

describe('MCP HTTP boundary: audit identity', () => {
  it('records a non-null subject and client hash for an authenticated call', async () => {
    const restore = await start();
    try {
      await call(mintToken({ sub: 'user-1', client_id: 'client-a' }), undefined, { 'X-Request-Id': 'probe-1' });
      await new Promise(r => setTimeout(r, 120));
      const row = mcpAudit.list().find(r => r.requestId === 'probe-1');
      assert.ok(row, 'the call should be audited');
      assert.match(row.subjectHash, /^[0-9a-f]{64}$/, 'subject hash must not be null');
      assert.match(row.clientIdHash, /^[0-9a-f]{64}$/, 'client hash must not be null');
      assert.equal(row.scopes, 'egressview:read');
    } finally { restore(); }
  });

  it('gives two subjects different hashes and one subject a stable hash', async () => {
    const restore = await start();
    try {
      await call(mintToken({ sub: 'same', client_id: 'c' }), undefined, { 'X-Request-Id': 'p-a' });
      await call(mintToken({ sub: 'same', client_id: 'c' }), undefined, { 'X-Request-Id': 'p-b' });
      await call(mintToken({ sub: 'other', client_id: 'c' }), undefined, { 'X-Request-Id': 'p-c' });
      await new Promise(r => setTimeout(r, 120));
      const rows = mcpAudit.list();
      const find = id => rows.find(r => r.requestId === id);
      assert.equal(find('p-a').subjectHash, find('p-b').subjectHash);
      assert.notEqual(find('p-a').subjectHash, find('p-c').subjectHash);
    } finally { restore(); }
  });

  it('leaves the hashes null for an unauthenticated call, by design', async () => {
    const restore = await start();
    try {
      const res = await call('not-a-token', undefined, { 'X-Request-Id': 'probe-2' });
      assert.equal(res.status, 401);
      await new Promise(r => setTimeout(r, 120));
      const row = mcpAudit.list().find(r => r.requestId === 'probe-2');
      assert.equal(row.subjectHash, null);
      assert.equal(row.outcome, 'failure');
    } finally { restore(); }
  });

  it('never stores the presented bearer token', async () => {
    const restore = await start();
    try {
      const token = mintToken({ sub: 'user-1', client_id: 'client-a' });
      await call(token);
      await new Promise(r => setTimeout(r, 120));
      const serialized = JSON.stringify(mcpAudit.list());
      assert.equal(serialized.includes(token), false);
      assert.equal(serialized.includes(token.split('.')[1]), false, 'not even the payload segment');
    } finally { restore(); }
  });
});

describe('MCP HTTP boundary: body handling runs after the limits', () => {
  it('rate limits malformed JSON instead of letting it bypass the limiter', async () => {
    const restore = await start({ limits: { global: 2 } });
    try {
      await call(null, '{ this is not json');
      await call(null, '{ still not json');
      const third = await call(null, '{ nor is this');
      assert.equal(third.status, 429, 'malformed bodies must consume the global budget');
    } finally { restore(); }
  });

  it('rejects an oversized body', async () => {
    const restore = await start({ env: { MCP_MAX_BODY: '1kb' } });
    try {
      const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', pad: 'x'.repeat(5000) });
      const res = await call(mintToken(), huge);
      assert.equal(res.status, 413, 'an oversized body must be refused');
      await new Promise(r => setTimeout(r, 120));
      const row = mcpAudit.list().find(r => r.httpStatus === 413);
      assert.equal(row?.reason, 'payload_too_large');
    } finally { restore(); }
  });

  it('audits a malformed request even though it never reaches a tool', async () => {
    const restore = await start();
    try {
      await call(null, '{ broken', { 'X-Request-Id': 'probe-3' });
      await new Promise(r => setTimeout(r, 120));
      const row = mcpAudit.list().find(r => r.requestId === 'probe-3');
      assert.ok(row);
      assert.equal(row.reason, 'bad_request');
      assert.equal(row.httpStatus, 400);
      assert.equal(row.mcpMethod, null);
    } finally { restore(); }
  });
});

describe('MCP HTTP boundary: audit availability', () => {
  it('refuses to start the public endpoint when the audit store is unwritable', async () => {
    mcpAudit.closeDb();
    const unwritable = path.join(dir, 'no-such-directory', 'audit.db');
    const previous = process.env.MCP_AUDIT_DB_PATH;
    process.env.MCP_AUDIT_DB_PATH = unwritable;
    try {
      await assert.rejects(
        () => mcpServer._startHttp(0, authConfig({ fetchImpl: issuerFetch })),
        'an internet-facing endpoint that cannot record calls must not accept them'
      );
    } finally {
      if (previous === undefined) delete process.env.MCP_AUDIT_DB_PATH;
      else process.env.MCP_AUDIT_DB_PATH = previous;
    }
  });

  it('reports write failures instead of swallowing them', () => {
    const reported = [];
    mcpAudit.setWriteFailureHandler((error, total) => reported.push(total));
    mcpAudit.closeDb();
    assert.equal(mcpAudit.append({ eventType: 'x', outcome: 'success' }), null);
    assert.equal(mcpAudit.health().open, false);
  });

  it('proves writability rather than trusting that the file opened', () => {
    mcpAudit._resetForTest(path.join(dir, 'probe.db'));
    assert.doesNotThrow(() => mcpAudit.assertWritable());
    assert.ok(mcpAudit.list().some(r => r.eventType === 'mcp_audit_startup'));
  });
});

describe('MCP HTTP boundary: timeout accounting', () => {
  it('writes exactly one audit row for a timed-out request', async () => {
    // The deadline only bites once the exchange is slow, so stall the upstream
    // API the tool proxies to rather than relying on incidental latency.
    const realFetch = global.fetch;
    let abortCount = 0;
    global.fetch = (url, options = {}) => {
      if (!String(url).includes('/api/')) return realFetch(url, options);
      return new Promise((resolve, reject) => {
        const rejectAborted = () => {
          abortCount += 1;
          reject(options.signal?.reason || new Error('aborted'));
        };
        if (options.signal?.aborted) rejectAborted();
        else options.signal?.addEventListener('abort', rejectAborted, { once: true });
      });
    };
    const restore = await start({ env: { MCP_REQUEST_TIMEOUT_MS: '30' } });
    try {
      // Valid arguments, so the call actually reaches the stalled upstream API
      // instead of failing schema validation before the deadline matters.
      const startedAt = Date.now();
      const res = await call(
        mintToken({ client_id: 'c' }),
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_devices', arguments: {} } },
        { 'X-Request-Id': 'timeout-1' }
      );
      // The transport streams, so headers are already sent and the status can
      // no longer become 504. What must hold is the audit record.
      await res.text();
      assert.ok(Date.now() - startedAt < 1_000, 'the deadline must abort work, not only label it');
      assert.ok(abortCount > 0, 'the request signal must reach the internal API fetch');
      await new Promise(r => setTimeout(r, 200));
      const rows = mcpAudit.list().filter(r => r.requestId === 'timeout-1');
      assert.equal(rows.length, 1, 'a timeout must not be recorded twice');
      assert.equal(rows[0].reason, 'request_timeout',
        'and must not be downgraded to a generic server error');
      assert.equal(rows[0].outcome, 'failure',
        'a streamed 200 that blew its deadline is still a failure');
    } finally {
      restore();
      global.fetch = realFetch;
    }
  });

  it('rejects a non-positive timeout rather than disabling the deadline', async () => {
    const restore = await start({ env: { MCP_REQUEST_TIMEOUT_MS: '0' } });
    try {
      const res = await call(mintToken({ client_id: 'c' }), undefined, { 'X-Request-Id': 'zero-timeout' });
      await res.text();
      await new Promise(r => setTimeout(r, 150));
      const row = mcpAudit.list().find(r => r.requestId === 'zero-timeout');
      // A deadline of zero would expire instantly; falling back to the default
      // means this ordinary request is not marked as timed out.
      assert.notEqual(row?.reason, 'request_timeout');
    } finally { restore(); }
  });

  it('keeps serving after a timeout, with the concurrency slot returned', async () => {
    const realFetch = global.fetch;
    global.fetch = (url, options = {}) => {
      if (!String(url).includes('/api/')) return realFetch(url, options);
      return new Promise((resolve, reject) => {
        const rejectAborted = () => reject(options.signal?.reason || new Error('aborted'));
        if (options.signal?.aborted) rejectAborted();
        else options.signal?.addEventListener('abort', rejectAborted, { once: true });
      });
    };
    const restore = await start({
      env: { MCP_REQUEST_TIMEOUT_MS: '20' },
      limits: { concurrent: 2 },
    });
    try {
      const token = mintToken({ client_id: 'c' });
      for (let i = 0; i < 4; i++) {
        const res = await call(
          token,
          { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_devices', arguments: {} } }
        );
        await res.text();
        // A leaked slot would surface as 429 concurrency_limit once the cap
        // filled; every request must still be served.
        assert.notEqual(res.status, 429, `request ${i} must not hit the concurrency cap`);
      }
    } finally {
      restore();
      global.fetch = realFetch;
    }
  });
});
