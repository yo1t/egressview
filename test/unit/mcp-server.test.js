// Unit tests for mcp-server.js — auth middleware, apiPost helper, and server construction
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Set env vars before requiring to prevent startup side-effects
process.env.EGRESSVIEW_URL   = process.env.EGRESSVIEW_URL   || 'http://localhost:9999';
process.env.EGRESSVIEW_TOKEN = process.env.EGRESSVIEW_TOKEN || 'test-egressview-token';
// MCP_PORT must be unset so the module does not try to bind a port
delete process.env.MCP_PORT;

const {
  _createAuthMiddleware,
  _createToolScopeMiddleware,
  _buildMcpServer,
  _apiPost,
  _createApiClient,
  _createMcpServiceApiClient,
  _wrapToolHandler,
  _resolveHttpAuthConfig,
  _resolveMcpPort,
  _startHttp,
} = require('../../mcp-server');
const { createMcpScopeMapping } = require('../../src/mcp-scope-mapping');

const SERVICE_TOKEN = `egv_${'a'.repeat(64)}`;
const AUDIT_HASH_KEY = 'test-audit-hmac-key-that-is-independent';

describe('mcp-server: tool audit boundary', () => {
  it('audits a successful handler without exposing its arguments or result', async () => {
    const events = [];
    const wrapped = _wrapToolHandler(
      'get_devices',
      async args => ({ content: [{ type: 'text', text: args.secret }] }),
      event => events.push(event)
    );
    const result = await wrapped({ secret: 'must-not-enter-audit' });
    assert.equal(result.content[0].text, 'must-not-enter-audit');
    assert.equal(events.length, 1);
    assert.deepEqual(
      { ...events[0], durationMs: 0 },
      {
        toolName: 'get_devices', outcome: 'success', reason: null, durationMs: 0,
      }
    );
    assert.equal(JSON.stringify(events).includes('must-not-enter-audit'), false);
  });

  it('records only a fixed reason when a handler throws', async () => {
    const events = [];
    const error = new Error('provider returned a sensitive error');
    const wrapped = _wrapToolHandler(
      'get_devices',
      async () => { throw error; },
      event => events.push(event)
    );
    await assert.rejects(() => wrapped({ token: 'secret' }), error);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'failure');
    assert.equal(events[0].reason, 'tool_error');
    assert.equal(JSON.stringify(events).includes(error.message), false);
  });

  it('treats an MCP isError result as a failed tool call', async () => {
    const events = [];
    const wrapped = _wrapToolHandler(
      'get_devices',
      async () => ({ isError: true, content: [] }),
      event => events.push(event)
    );
    await wrapped({});
    assert.equal(events[0].outcome, 'failure');
    assert.equal(events[0].reason, 'tool_error');
  });
});

// ─── createAuthMiddleware ─────────────────────────────────────────────────────

describe('mcp-server: createAuthMiddleware', () => {
  const TOKEN = 'super-secret-mcp-token';

  function makeReq(headers = {}) { return { headers }; }
  function makeRes() {
    const r = { _status: null, _body: null };
    r.status = (code) => { r._status = code; return r; };
    r.json   = (body) => { r._body  = body; return r; };
    return r;
  }

  it('rejects with 401 when no token provided', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({}), res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
    assert.equal(res._body?.error, 'unauthorized');
  });

  it('rejects with 401 for wrong X-Admin-Token', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    mw(makeReq({ 'x-admin-token': 'wrong-token' }), res, () => {});
    assert.equal(res._status, 401);
  });

  it('rejects with 401 for wrong Bearer token', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    mw(makeReq({ authorization: 'Bearer wrong' }), res, () => {});
    assert.equal(res._status, 401);
  });

  it('accepts valid token via X-Admin-Token header', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ 'x-admin-token': TOKEN }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res._status, null, 'should not set status on success');
  });

  it('accepts valid token via Authorization: Bearer header', () => {
    const mw = _createAuthMiddleware(TOKEN);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ authorization: `Bearer ${TOKEN}` }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('rejects empty provided token (prevents auth bypass when server token non-empty)', () => {
    const mw = _createAuthMiddleware('non-empty-server-token');
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ 'x-admin-token': '' }), res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });

  it('MCP_TOKEN separation: EgressView token does not work for MCP when tokens differ', () => {
    const egressviewToken = 'egressview-api-token';
    const mcpToken        = 'mcp-only-token';
    const mw = _createAuthMiddleware(mcpToken);
    const res = makeRes();
    mw(makeReq({ 'x-admin-token': egressviewToken }), res, () => {});
    assert.equal(res._status, 401, 'EgressView token must not pass MCP auth when MCP_TOKEN differs');
  });

  it('MCP_TOKEN separation: MCP token is accepted when set separately', () => {
    const mcpToken = 'mcp-only-token';
    const mw = _createAuthMiddleware(mcpToken);
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq({ 'x-admin-token': mcpToken }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});

describe('mcp-server: HTTP auth configuration', () => {
  it('requires a dedicated MCP_TOKEN in private HTTP token mode', () => {
    assert.throws(
      () => _resolveHttpAuthConfig({
        MCP_AUTH_MODE: 'token',
        EGRESSVIEW_TOKEN: 'admin-token',
      }),
      /MCP_TOKEN must be set explicitly/
    );
  });

  it('does not accept EGRESSVIEW_TOKEN as an implicit MCP endpoint token', () => {
    const config = _resolveHttpAuthConfig({
      MCP_AUTH_MODE: 'token',
      EGRESSVIEW_TOKEN: 'admin-token',
      MCP_TOKEN: 'mcp-token',
      MCP_SERVICE_TOKEN: SERVICE_TOKEN,
      MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
    });
    assert.deepEqual(config, {
      mode: 'token',
      token: 'mcp-token',
      serviceToken: SERVICE_TOKEN,
      auditHashKey: AUDIT_HASH_KEY,
    });
  });

  it('rejects an explicit MCP_TOKEN that equals the admin API token', () => {
    assert.throws(
      () => _resolveHttpAuthConfig({
        MCP_AUTH_MODE: 'token',
        EGRESSVIEW_TOKEN: 'shared-token',
        MCP_TOKEN: 'shared-token',
        MCP_SERVICE_TOKEN: SERVICE_TOKEN,
        MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
      }),
      /must differ from EGRESSVIEW_TOKEN/
    );
  });

  it('requires a scoped service identity and audit key in private token mode', () => {
    const base = {
      MCP_AUTH_MODE: 'token',
      MCP_TOKEN: 'private-endpoint-token',
      EGRESSVIEW_TOKEN: 'admin-token',
    };
    assert.throws(
      () => _resolveHttpAuthConfig(base),
      /MCP_SERVICE_TOKEN/
    );
    assert.throws(
      () => _resolveHttpAuthConfig({
        ...base,
        MCP_SERVICE_TOKEN: 'legacy-admin-token',
        MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
      }),
      /scoped EgressView API identity/
    );
    assert.throws(
      () => _resolveHttpAuthConfig({
        ...base,
        MCP_SERVICE_TOKEN: SERVICE_TOKEN,
        MCP_AUDIT_HMAC_KEY: 'too-short',
      }),
      /at least 32 characters/
    );
  });

  it('requires complete OAuth Resource Server configuration', () => {
    assert.throws(
      () => _resolveHttpAuthConfig({ MCP_AUTH_MODE: 'oauth' }),
      /MCP_OAUTH_ISSUER/
    );
    const config = _resolveHttpAuthConfig({
      MCP_AUTH_MODE: 'oauth',
      MCP_OAUTH_ISSUER: 'https://idp.example.test/realms/egressview',
      MCP_OAUTH_RESOURCE: 'https://monitor.example.test/mcp',
      MCP_OAUTH_READ_SCOPE: 'egressview:read',
      MCP_OAUTH_NOTES_WRITE_SCOPE: 'egressview:notes.write',
      MCP_SERVICE_TOKEN: SERVICE_TOKEN,
      MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
    });
    assert.deepEqual(config, {
      mode: 'oauth',
      issuer: 'https://idp.example.test/realms/egressview',
      resource: 'https://monitor.example.test/mcp',
      compatibilityProfile: 'strict',
      requiredScope: 'egressview:read',
      readScope: 'egressview:read',
      notesWriteScope: 'egressview:notes.write',
      scopesSupported: ['egressview:read', 'egressview:notes.write'],
      serviceToken: SERVICE_TOKEN,
      auditHashKey: AUDIT_HASH_KEY,
    });
  });

  it('enables Cognito compatibility only for an exact regional pool issuer', () => {
    const base = {
      MCP_AUTH_MODE: 'oauth',
      MCP_OAUTH_RESOURCE: 'https://monitor.example.test/mcp',
      MCP_OAUTH_READ_SCOPE: 'https://monitor.example.test/mcp/read',
      MCP_OAUTH_NOTES_WRITE_SCOPE: 'https://monitor.example.test/mcp/notes.write',
      MCP_SERVICE_TOKEN: SERVICE_TOKEN,
      MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
      MCP_OAUTH_COMPATIBILITY_PROFILE: 'cognito',
    };
    const config = _resolveHttpAuthConfig({
      ...base,
      MCP_OAUTH_ISSUER: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TestPool123',
    });
    assert.equal(config.compatibilityProfile, 'cognito');
    assert.throws(
      () => _resolveHttpAuthConfig({
        ...base,
        MCP_OAUTH_ISSUER: 'https://idp.example.test/realms/egressview',
      }),
      /exact AWS Cognito regional user-pool issuer/
    );
  });

  it('requires a scoped API identity for OAuth internal API calls', () => {
    const base = {
      MCP_AUTH_MODE: 'oauth',
      MCP_OAUTH_ISSUER: 'https://idp.example.test/realms/egressview',
      MCP_OAUTH_RESOURCE: 'https://monitor.example.test/mcp',
      MCP_OAUTH_READ_SCOPE: 'egressview:read',
      MCP_OAUTH_NOTES_WRITE_SCOPE: 'egressview:notes.write',
      MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
    };
    assert.throws(
      () => _resolveHttpAuthConfig({ ...base, MCP_SERVICE_TOKEN: 'legacy-admin-token' }),
      /scoped EgressView API identity/
    );
    assert.throws(
      () => _resolveHttpAuthConfig({
        ...base,
        MCP_SERVICE_TOKEN: SERVICE_TOKEN,
        MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
        EGRESSVIEW_TOKEN: SERVICE_TOKEN,
      }),
      /must differ from EGRESSVIEW_TOKEN/
    );
  });

  it('rejects overlapping external OAuth scopes', () => {
    assert.throws(
      () => _resolveHttpAuthConfig({
        MCP_AUTH_MODE: 'oauth',
        MCP_OAUTH_ISSUER: 'https://idp.example.test/realms/egressview',
        MCP_OAUTH_RESOURCE: 'https://monitor.example.test/mcp',
        MCP_OAUTH_READ_SCOPE: 'egressview:shared',
        MCP_OAUTH_NOTES_WRITE_SCOPE: 'egressview:shared',
        MCP_SERVICE_TOKEN: SERVICE_TOKEN,
        MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
      }),
      /scopes must differ/
    );
  });

  it('requires a dedicated stable audit HMAC key in OAuth mode', () => {
    const base = {
      MCP_AUTH_MODE: 'oauth',
      MCP_OAUTH_ISSUER: 'https://idp.example.test/realms/egressview',
      MCP_OAUTH_RESOURCE: 'https://monitor.example.test/mcp',
      MCP_OAUTH_READ_SCOPE: 'egressview:read',
      MCP_OAUTH_NOTES_WRITE_SCOPE: 'egressview:notes.write',
      MCP_SERVICE_TOKEN: SERVICE_TOKEN,
    };
    assert.throws(
      () => _resolveHttpAuthConfig({ ...base, MCP_AUDIT_HMAC_KEY: 'too-short' }),
      /at least 32 characters/
    );
    assert.throws(
      () => _resolveHttpAuthConfig({ ...base, MCP_AUDIT_HMAC_KEY: SERVICE_TOKEN }),
      /dedicated/
    );
  });

  it('rejects unknown HTTP authentication modes', () => {
    assert.throws(
      () => _resolveHttpAuthConfig({ MCP_AUTH_MODE: 'none' }),
      /must be either/
    );
  });

  it('rejects invalid MCP_PORT values instead of falling back to stdio', () => {
    for (const value of ['not-a-port', '0', '65536', '3010.5']) {
      assert.throws(() => _resolveMcpPort(value), /MCP_PORT must be an integer/);
    }
    assert.equal(_resolveMcpPort('3010'), 3010);
  });

  it('exits fail-closed when HTTP token mode has only EGRESSVIEW_TOKEN', () => {
    const result = spawnSync(process.execPath, ['mcp-server.js'], {
      cwd: require('node:path').join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        MCP_PORT: '3010',
        MCP_AUTH_MODE: 'token',
        EGRESSVIEW_TOKEN: 'legacy-admin-token',
        MCP_TOKEN: '',
        MCP_SERVICE_TOKEN: SERVICE_TOKEN,
        MCP_AUDIT_HMAC_KEY: AUDIT_HASH_KEY,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MCP_TOKEN must be set explicitly/);
    assert.doesNotMatch(result.stderr, /legacy-admin-token/);
  });

  it('serves both PRM routes and challenges unauthenticated MCP requests', async () => {
    // Keep the audit store out of the repository root: OAuth mode now opens it
    // at startup, and the default path would leave a stray database behind.
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-mcp-audit-'));
    const previousAuditPath = process.env.MCP_AUDIT_DB_PATH;
    process.env.MCP_AUDIT_DB_PATH = path.join(auditDir, 'audit.db');
    const server = await _startHttp(0, {
      mode: 'oauth',
      issuer: 'https://idp.example.test/realms/egressview',
      resource: 'https://monitor.example.test/egressview/mcp',
      requiredScope: 'egressview:read',
      readScope: 'egressview:read',
      notesWriteScope: 'egressview:notes.write',
      scopesSupported: ['egressview:read', 'egressview:notes.write'],
      serviceToken: SERVICE_TOKEN,
      auditHashKey: AUDIT_HASH_KEY,
    });
    try {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-protected-resource/egressview/mcp',
      ]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.resource, 'https://monitor.example.test/egressview/mcp');
        assert.deepEqual(body.scopes_supported, ['egressview:read', 'egressview:notes.write']);
      }

      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
      assert.match(response.headers.get('www-authenticate'), /scope="egressview:read"/);
    } finally {
      if (previousAuditPath === undefined) delete process.env.MCP_AUDIT_DB_PATH;
      else process.env.MCP_AUDIT_DB_PATH = previousAuditPath;
      fs.rmSync(auditDir, { recursive: true, force: true });
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('mcp-server: OAuth tool scope enforcement', () => {
  const scopeMapping = createMcpScopeMapping({
    readScope: 'egressview:read',
    notesWriteScope: 'egressview:notes.write',
  });
  const oauth = {
    challenge: (error, scope) => `Bearer error="${error}", scope="${scope}"`,
  };

  function response() {
    const res = { statusCode: null, body: null, headers: {} };
    res.set = (name, value) => { res.headers[name] = value; return res; };
    res.status = (statusCode) => { res.statusCode = statusCode; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  }

  it('returns 403 with both current and required scopes for a write tool', () => {
    const middleware = _createToolScopeMiddleware(scopeMapping, oauth);
    const req = {
      method: 'POST',
      body: { method: 'tools/call', params: { name: 'set_device_note' } },
      mcpAuth: { scopes: ['egressview:read'] },
    };
    const res = response();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'insufficient_scope' });
    assert.match(
      res.headers['WWW-Authenticate'],
      /scope="egressview:read egressview:notes\.write"/
    );
  });

  it('allows the write tool when both scopes are granted', () => {
    const middleware = _createToolScopeMiddleware(scopeMapping, oauth);
    const req = {
      method: 'POST',
      body: { method: 'tools/call', params: { name: 'set_device_note' } },
      mcpAuth: { scopes: ['egressview:read', 'egressview:notes.write'] },
    };
    let nextCalled = false;
    middleware(req, response(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('leaves unknown methods and tools to the MCP protocol handler', () => {
    const middleware = _createToolScopeMiddleware(scopeMapping, oauth);
    for (const body of [
      { method: 'tools/list' },
      { method: 'tools/call', params: { name: 'future_tool' } },
    ]) {
      let nextCalled = false;
      middleware({ method: 'POST', body, mcpAuth: { scopes: [] } }, response(), () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    }
  });
});

// ─── apiPost helper ───────────────────────────────────────────────────────────

describe('mcp-server: apiPost', () => {
  let originalFetch;

  before(() => { originalFetch = globalThis.fetch; });

  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockFetch(status, body) {
    globalThis.fetch = async () => ({
      ok:   status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }

  it('sends POST with JSON body and X-Admin-Token header', async () => {
    let capturedUrl, capturedOpts;
    globalThis.fetch = async (url, opts) => {
      capturedUrl  = url;
      capturedOpts = opts;
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    await _apiPost('/notes', { ip: '192.168.1.1', note: 'test' });
    assert.ok(capturedUrl.endsWith('/api/notes'), 'should POST to /api/notes');
    assert.equal(capturedOpts.method, 'POST');
    assert.equal(capturedOpts.headers['Content-Type'], 'application/json');
    assert.ok(capturedOpts.headers['X-Admin-Token'], 'should include auth token');
    assert.deepEqual(JSON.parse(capturedOpts.body), { ip: '192.168.1.1', note: 'test' });
  });

  it('uses only the injected service identity for internal API calls', async () => {
    let capturedOpts;
    globalThis.fetch = async (_url, opts) => {
      capturedOpts = opts;
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    const client = _createApiClient({
      base: 'http://localhost:9999',
      token: SERVICE_TOKEN,
    });
    await client.get('/devices');
    assert.equal(capturedOpts.headers['X-Admin-Token'], SERVICE_TOKEN);
    assert.notEqual(capturedOpts.headers['X-Admin-Token'], process.env.EGRESSVIEW_TOKEN);
  });

  it('verifies exact service permissions before forwarding an MCP API call', async () => {
    const requests = [];
    globalThis.fetch = async (url, opts) => {
      requests.push({ url, opts });
      if (url.endsWith('/api/auth/api-identities/self')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            identity: { permissions: ['notes.write', 'network.read'] },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ devices: [] }) };
    };
    const client = _createMcpServiceApiClient({
      base: 'http://localhost:9999',
      token: SERVICE_TOKEN,
    });
    await client.get('/devices');
    await client.get('/connections');
    assert.equal(requests.length, 3, 'identity permissions should be verified once');
    assert(requests.every(({ opts }) => opts.headers['X-Admin-Token'] === SERVICE_TOKEN));
  });

  it('rejects an over-privileged service identity before the requested API call', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          identity: {
            permissions: ['network.read', 'notes.write', 'auth.admin'],
          },
        }),
      };
    };
    const client = _createMcpServiceApiClient({
      base: 'http://localhost:9999',
      token: SERVICE_TOKEN,
    });
    await assert.rejects(
      () => client.get('/devices'),
      /must grant exactly network\.read and notes\.write/
    );
    assert.equal(requestCount, 1);
  });

  it('returns parsed JSON on success', async () => {
    mockFetch(200, { success: true });
    const result = await _apiPost('/notes', {});
    assert.deepEqual(result, { success: true });
  });

  it('throws on non-2xx response', async () => {
    mockFetch(400, { error: 'bad request' });
    await assert.rejects(
      () => _apiPost('/notes', {}),
      /returned 400/
    );
  });

  it('throws on non-JSON response', async () => {
    globalThis.fetch = async () => ({
      ok:   true,
      status: 200,
      json: async () => { throw new SyntaxError('not json'); },
    });
    await assert.rejects(
      () => _apiPost('/notes', {}),
      /non-JSON response/
    );
  });
});

// ─── buildMcpServer ───────────────────────────────────────────────────────────

describe('mcp-server: buildMcpServer', () => {
  it('returns an object with a connect method (valid McpServer)', () => {
    const server = _buildMcpServer();
    assert.ok(server != null, 'should return a server instance');
    assert.equal(typeof server.connect, 'function', 'should expose connect()');
  });

  it('does not throw during construction', () => {
    assert.doesNotThrow(() => _buildMcpServer());
  });
});
