// Unit tests for mcp-server.js — auth middleware, apiPost helper, and server construction
'use strict';

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
  _buildMcpServer,
  _apiPost,
  _resolveHttpAuthConfig,
  _resolveMcpPort,
  _startHttp,
} = require('../../mcp-server');

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
    });
    assert.deepEqual(config, { mode: 'token', token: 'mcp-token' });
  });

  it('rejects an explicit MCP_TOKEN that equals the admin API token', () => {
    assert.throws(
      () => _resolveHttpAuthConfig({
        MCP_AUTH_MODE: 'token',
        EGRESSVIEW_TOKEN: 'shared-token',
        MCP_TOKEN: 'shared-token',
      }),
      /must differ from EGRESSVIEW_TOKEN/
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
    });
    assert.deepEqual(config, {
      mode: 'oauth',
      issuer: 'https://idp.example.test/realms/egressview',
      resource: 'https://monitor.example.test/mcp',
      requiredScope: 'egressview:read',
      scopesSupported: ['egressview:read'],
    });
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
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MCP_TOKEN must be set explicitly/);
    assert.doesNotMatch(result.stderr, /legacy-admin-token/);
  });

  it('serves both PRM routes and challenges unauthenticated MCP requests', async () => {
    const server = await _startHttp(0, {
      mode: 'oauth',
      issuer: 'https://idp.example.test/realms/egressview',
      resource: 'https://monitor.example.test/egressview/mcp',
      requiredScope: 'egressview:read',
      scopesSupported: ['egressview:read'],
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
        assert.deepEqual(body.scopes_supported, ['egressview:read']);
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
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
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
