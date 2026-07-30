'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  loadGateConfig,
  validateEvidence,
  validateFixtureTokens,
  verifyLocalCollection,
  verifyAuditRows,
  requestJson,
  runPublicationGate,
  writeReport,
} = require('../../src/mcp-publication-gate');

const NOW = Date.parse('2026-07-29T00:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const RESOURCE = 'https://mcp.example.test/mcp';
const ISSUER = 'https://auth.example.test/realms/egressview';
const READ_SCOPE = 'egressview:read';
const WRITE_SCOPE = 'egressview:notes.write';
const TOOL_NAMES = [
  'get_alerts',
  'get_device_notes',
  'get_device_traffic',
  'get_devices',
  'get_new_nodes',
  'get_threat_connections',
  'get_threat_summary',
  'get_top_destinations',
  'get_traffic_summary',
  'query_connections',
  'set_device_note',
];

function token(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', kid: 'test' })}.${encode(claims)}.signature`;
}

function tokens() {
  const base = {
    iss: ISSUER,
    sub: 'user',
    azp: 'client',
    aud: RESOURCE,
    exp: NOW / 1000 + 300,
    scope: READ_SCOPE,
  };
  return {
    read: token(base),
    write: token({ ...base, scope: `${READ_SCOPE} ${WRITE_SCOPE}` }),
    expired: token({ ...base, exp: NOW / 1000 - 60 }),
    wrongAudience: token({ ...base, aud: 'https://other.example.test/mcp' }),
    revokedExpired: token({ ...base, exp: NOW / 1000 - 1 }),
  };
}

function evidence(overrides = {}) {
  const entry = { passed: true, testedAt: '2026-07-28T00:00:00.000Z' };
  return {
    schemaVersion: 2,
    deployedCommit: COMMIT,
    publishDns: false,
    directIngress: { ...entry, portsClosed: true },
    reverseProxyLimits: { ...entry },
    rollback: { ...entry },
    credentialRotation: { ...entry },
    keycloakBackupRestore: { ...entry },
    jwksOutage: {
      ...entry,
      mcpFailedClosed: true,
      localCollectionContinued: true,
    },
    refreshRevocation: {
      ...entry,
      oldRefreshRejected: true,
      latestRefreshWorked: true,
    },
    clientCompatibility: {
      ...entry,
      claudeCode: true,
      copilotCli: true,
      claudeCodeProtocolVersion: '2026-07-28',
      copilotCliProtocolVersion: '2026-07-28',
      legacyClient: true,
      legacyProtocolVersion: '2025-11-25',
    },
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    endpoint: new URL(RESOURCE),
    resource: RESOURCE,
    issuer: ISSUER,
    connectAddress: 'private-alb.example.test',
    readScope: READ_SCOPE,
    writeScope: WRITE_SCOPE,
    deployedCommit: COMMIT,
    evidencePath: '/unused/evidence.json',
    reportPath: '/unused/report.json',
    auditDbPath: '/unused/audit.db',
    localBase: new URL('http://127.0.0.1:3002'),
    localToken: 'local-test-token',
    tokens: tokens(),
    rateProbeRequests: 5,
    routerMaxAgeMs: 300_000,
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('MCP publication gate configuration', () => {
  it('requires canonical HTTPS URLs, a pinned connect target, and full commit', () => {
    const fixtureTokens = tokens();
    const loaded = loadGateConfig({
      MCP_GATE_ENDPOINT: RESOURCE,
      MCP_GATE_RESOURCE: RESOURCE,
      MCP_GATE_ISSUER: ISSUER,
      MCP_GATE_CONNECT_ADDRESS: 'private-alb.example.test',
      MCP_GATE_READ_SCOPE: READ_SCOPE,
      MCP_GATE_WRITE_SCOPE: WRITE_SCOPE,
      MCP_GATE_DEPLOYED_COMMIT: COMMIT,
      MCP_GATE_EVIDENCE_PATH: './evidence.json',
      MCP_GATE_AUDIT_DB_PATH: './audit.db',
      MCP_GATE_EGRESSVIEW_URL: 'http://127.0.0.1:3002',
      MCP_GATE_EGRESSVIEW_TOKEN: 'local-token',
      MCP_GATE_READ_TOKEN: fixtureTokens.read,
      MCP_GATE_WRITE_TOKEN: fixtureTokens.write,
      MCP_GATE_EXPIRED_TOKEN: fixtureTokens.expired,
      MCP_GATE_WRONG_AUDIENCE_TOKEN: fixtureTokens.wrongAudience,
      MCP_GATE_REVOKED_EXPIRED_TOKEN: fixtureTokens.revokedExpired,
    });
    assert.equal(loaded.endpoint.toString(), RESOURCE);
    assert.equal(loaded.rateProbeRequests, 70);

    assert.throws(
      () => loadGateConfig({
        MCP_GATE_ENDPOINT: 'http://mcp.example.test/mcp',
      }),
      /must use HTTPS/
    );
  });

  it('checks fixture semantics before sending any bearer token', () => {
    assert.doesNotThrow(() => validateFixtureTokens(config(), NOW));
    assert.throws(
      () => validateFixtureTokens(config({
        tokens: { ...tokens(), wrongAudience: tokens().read },
      }), NOW),
      /target another audience/
    );
  });
});

describe('MCP publication gate evidence', () => {
  it('requires recent, matching, fail-closed operational evidence', () => {
    assert.deepEqual(validateEvidence(evidence(), { deployedCommit: COMMIT, now: NOW }), []);
    const failures = validateEvidence(evidence({
      publishDns: true,
      jwksOutage: {
        passed: true,
        testedAt: '2026-07-28T00:00:00.000Z',
        mcpFailedClosed: false,
        localCollectionContinued: true,
      },
    }), { deployedCommit: COMMIT, now: NOW });
    assert.ok(failures.some((item) => item.includes('publishDns')));
    assert.ok(failures.some((item) => item.includes('jwksOutage')));
  });

  it('rejects stale evidence and evidence for another build', () => {
    const failures = validateEvidence(evidence({
      deployedCommit: 'b'.repeat(40),
      rollback: { passed: true, testedAt: '2026-01-01T00:00:00.000Z' },
    }), { deployedCommit: COMMIT, now: NOW });
    assert.ok(failures.some((item) => item.includes('deployedCommit')));
    assert.ok(failures.some((item) => item.includes('rollback.testedAt')));
  });

  it('requires explicit modern clients and a retained legacy client', () => {
    const failures = validateEvidence(evidence({
      clientCompatibility: {
        passed: true,
        testedAt: '2026-07-28T00:00:00.000Z',
        claudeCode: true,
        copilotCli: true,
        claudeCodeProtocolVersion: '2025-11-25',
        copilotCliProtocolVersion: '2026-07-28',
        legacyClient: false,
      },
    }), { deployedCommit: COMMIT, now: NOW });
    assert.ok(failures.some((item) => item.includes('must select 2026-07-28')));
    assert.ok(failures.some((item) => item.includes('retain a 2025-11-25')));
  });
});

describe('MCP publication gate active probes', () => {
  it('pins the connection target while preserving the canonical Host header', async () => {
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ host: request.headers.host }));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const port = server.address().port;
      const result = await requestJson(
        new URL(`http://canonical.invalid:${port}/probe`),
        { connectRecords: [{ address: '127.0.0.1', family: 4 }] }
      );
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.text), { host: `canonical.invalid:${port}` });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('accepts the epoch-millisecond router timestamps returned by the real API', async () => {
    const responses = new Map([
      ['/healthz', response(200, { status: 'ok' })],
      ['/readyz', response(200, { status: 'ready' })],
      ['/api/routers', response(200, {
        routers: [
          { id: 'r1', kind: 'yamaha', enabled: true, ready: true, lastSuccessAt: Date.now() - 1_000 },
          { id: 'r2', kind: 'cisco', enabled: true, ready: true, lastSuccessAt: Date.now() - 2_000 },
        ],
      })],
    ]);
    const result = await verifyLocalCollection(
      config(),
      async (url) => responses.get(url.pathname)
    );
    assert.equal(result.enabledRouters, 2);
  });

  it('passes only after metadata, token, scope, rate, audit, and local checks', async () => {
    let unauthenticatedRequests = 0;
    let auditArguments = null;
    const wireRequests = {};
    const requester = async (url, options = {}) => {
      if (url.pathname.startsWith('/.well-known/')) {
        return response(200, {
          resource: RESOURCE,
          authorization_servers: [ISSUER],
          scopes_supported: [READ_SCOPE, WRITE_SCOPE],
        });
      }
      const authorization = options.headers?.Authorization;
      const requestId = options.headers?.['X-Request-Id'];
      const requestBody = JSON.parse(options.body);
      for (const name of [
        'legacyInitialize',
        'legacyTools',
        'modernDiscover',
        'modernTools',
        'protocolMismatch',
        'unsupportedVersion',
        'read',
      ]) {
        if (requestId?.includes(name)) {
          wireRequests[name] = { headers: options.headers, body: requestBody };
        }
      }
      if (!authorization) {
        unauthenticatedRequests += 1;
        if (unauthenticatedRequests >= 4) {
          return response(429, { error: 'rate_limited' }, { 'retry-after': '60' });
        }
        return response(401, { error: 'unauthorized' }, {
          'www-authenticate': `Bearer resource_metadata="${RESOURCE}" scope="${READ_SCOPE}"`,
        });
      }
      if (authorization.includes('not-a-jwt')
          || requestId.includes('expired')
          || requestId.includes('wrongAudience')
          || requestId.includes('revokedExpired')) {
        return response(401, { error: 'invalid_token' }, {
          'www-authenticate': 'Bearer error="invalid_token"',
        });
      }
      if (requestId.includes('insufficientScope')) {
        return response(403, { error: 'insufficient_scope' }, {
          'www-authenticate': `Bearer error="insufficient_scope" scope="${READ_SCOPE} ${WRITE_SCOPE}"`,
        });
      }
      if (requestId.includes('protocolMismatch')) {
        return response(400, {
          jsonrpc: '2.0',
          id: requestBody.id,
          error: { code: -32020, message: 'header/body mismatch' },
        });
      }
      if (requestId.includes('unsupportedVersion')) {
        return response(400, {
          jsonrpc: '2.0',
          id: requestBody.id,
          error: { code: -32022, message: 'unsupported protocol version' },
        });
      }
      if (requestBody.method === 'initialize') {
        return response(200, {
          jsonrpc: '2.0',
          id: requestBody.id,
          result: { protocolVersion: '2025-11-25' },
        });
      }
      if (requestBody.method === 'server/discover') {
        return response(200, {
          jsonrpc: '2.0',
          id: requestBody.id,
          result: { supportedVersions: ['2026-07-28'] },
        });
      }
      if (requestBody.method === 'tools/list') {
        return response(200, `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: requestBody.id,
          result: { tools: TOOL_NAMES.map((name) => ({ name })) },
        })}\n\n`, { 'content-type': 'text/event-stream' });
      }
      return response(200, `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: requestBody.id,
        result: { content: [{ type: 'text', text: '{}' }] },
      })}\n\n`, { 'content-type': 'text/event-stream' });
    };

    const report = await runPublicationGate(config(), {
      evidence: evidence(),
      now: () => NOW,
      resolvePublic: async () => [],
      resolveTarget: async () => [{ address: '192.0.2.10', family: 4 }],
      tokenVerifier: async () => {},
      requester,
      localVerifier: async () => ({ enabledRouters: 2 }),
      auditVerifier: (dbPath, requestIds) => {
        auditArguments = { dbPath, requestIds };
      },
    });

    assert.equal(report.status, 'ready_for_manual_dns_review');
    assert.equal(report.dnsPublished, false);
    assert.equal(report.enabledRouters, 2);
    assert.deepEqual(report.checks.protocolRevisions, {
      '2025-11-25': 'pass',
      '2026-07-28': 'pass',
    });
    assert.equal(report.checks.protocolErrors, 'pass');
    assert.equal(auditArguments.dbPath, '/unused/audit.db');
    assert.ok(auditArguments.requestIds.rateLimited.startsWith('mcp-gate-rate-'));
    assert.equal(wireRequests.legacyInitialize.headers['MCP-Protocol-Version'], undefined);
    assert.equal(wireRequests.legacyInitialize.body.method, 'initialize');
    assert.equal(wireRequests.modernDiscover.headers['MCP-Protocol-Version'], '2026-07-28');
    assert.equal(wireRequests.modernDiscover.headers['Mcp-Method'], 'server/discover');
    assert.equal(
      wireRequests.modernDiscover.body.params._meta['io.modelcontextprotocol/protocolVersion'],
      '2026-07-28'
    );
    assert.equal(wireRequests.modernTools.headers['Mcp-Method'], 'tools/list');
    assert.equal(wireRequests.read.headers['Mcp-Name'], 'get_devices');
    assert.equal(wireRequests.protocolMismatch.headers['Mcp-Method'], 'tools/call');
    assert.equal(wireRequests.protocolMismatch.body.method, 'tools/list');
    assert.equal(wireRequests.unsupportedVersion.headers['MCP-Protocol-Version'], '2099-01-01');
  });

  it('fails before probing when public DNS already resolves', async () => {
    let requested = false;
    await assert.rejects(
      () => runPublicationGate(config(), {
        evidence: evidence(),
        now: () => NOW,
        resolvePublic: async () => ['203.0.113.10'],
        tokenVerifier: async () => {},
        requester: async () => { requested = true; },
      }),
      /public MCP DNS already resolves/
    );
    assert.equal(requested, false);
  });
});

describe('MCP publication gate report', () => {
  it('requires the expected audit reasons and pseudonymized success identity', () => {
    const Database = require('better-sqlite3');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-mcp-gate-audit-'));
    const file = path.join(dir, 'audit.db');
    const requestIds = {
      malformed: 'malformed',
      expired: 'expired',
      wrongAudience: 'wrong-audience',
      revokedExpired: 'revoked-expired',
      insufficientScope: 'scope',
      rateLimited: 'rate',
      protocolMismatch: 'protocol-mismatch',
      unsupportedVersion: 'unsupported-version',
      read: 'read',
    };
    try {
      const db = new Database(file);
      db.exec(`
        CREATE TABLE mcp_audit_events (
          id INTEGER PRIMARY KEY,
          createdAt INTEGER NOT NULL,
          eventType TEXT NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT,
          subjectHash TEXT,
          clientIdHash TEXT,
          toolName TEXT,
          scopes TEXT,
          requestId TEXT,
          durationMs INTEGER
        )
      `);
      const insert = db.prepare(`
        INSERT INTO mcp_audit_events
          (createdAt, eventType, outcome, reason, subjectHash, clientIdHash, requestId)
        VALUES (?, 'mcp_request', ?, ?, ?, ?, ?)
      `);
      for (const [name, reason] of Object.entries({
        malformed: 'invalid_token',
        expired: 'invalid_token',
        wrongAudience: 'invalid_token',
        revokedExpired: 'invalid_token',
        insufficientScope: 'insufficient_scope',
        rateLimited: 'global_rate_limit',
        protocolMismatch: null,
        unsupportedVersion: null,
      })) {
        insert.run(Date.now(), 'failure', reason, null, null, requestIds[name]);
      }
      insert.run(Date.now(), 'success', null, 'a'.repeat(64), 'b'.repeat(64), requestIds.read);
      db.close();
      assert.doesNotThrow(() => verifyAuditRows(file, requestIds));

      const damaged = new Database(file);
      damaged.prepare('DELETE FROM mcp_audit_events WHERE requestId = ?').run(requestIds.expired);
      damaged.close();
      assert.throws(() => verifyAuditRows(file, requestIds), /expired is missing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes an atomic mode-0600 JSON report without tokens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-mcp-gate-'));
    const file = path.join(dir, 'report.json');
    try {
      writeReport(file, { status: 'ready_for_manual_dns_review' });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
        status: 'ready_for_manual_dns_review',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function response(status, body, headers = {}) {
  return {
    status,
    headers,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  };
}
