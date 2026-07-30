'use strict';

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');

process.env.EGRESSVIEW_URL = process.env.EGRESSVIEW_URL || 'http://localhost:9999';
process.env.EGRESSVIEW_TOKEN = process.env.EGRESSVIEW_TOKEN || 'test-egressview-token';
delete process.env.MCP_PORT;

const { _startHttp } = require('../../mcp-server');
const mcpAudit = require('../../src/mcp-audit');

const MCP_TOKEN = 'dual-era-test-token';
const SERVICE_TOKEN = `egv_${'a'.repeat(64)}`;
const AUDIT_HASH_KEY = 'dual-era-test-audit-key-that-is-stable';
const MODERN_VERSION = '2026-07-28';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
let httpServer;
let auditDir;
const clients = [];

function privateAuthConfig() {
  return {
    mode: 'token',
    token: MCP_TOKEN,
    serviceToken: SERVICE_TOKEN,
    auditHashKey: AUDIT_HASH_KEY,
  };
}

function endpointUrl() {
  return new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
}

async function startClient(versionNegotiation) {
  const client = new Client(
    { name: 'egressview-dual-era-test', version: '1.0.0' },
    versionNegotiation ? { versionNegotiation } : {}
  );
  const transport = new StreamableHTTPClientTransport(endpointUrl(), {
    requestInit: {
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
    },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function postModern({
  version = MODERN_VERSION,
  method = 'server/discover',
  methodHeader = method,
}) {
  return fetch(endpointUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': version,
      'Mcp-Method': methodHeader,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${version}:${method}`,
      method,
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: version,
          [CLIENT_INFO_META_KEY]: { name: 'egressview-negative-test', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
}

beforeEach(() => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-mcp-dual-era-'));
  process.env.MCP_AUDIT_DB_PATH = path.join(auditDir, 'audit.db');
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  if (httpServer) {
    await new Promise((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    httpServer = null;
  }
  mcpAudit.closeDb();
  delete process.env.MCP_AUDIT_DB_PATH;
  if (auditDir) fs.rmSync(auditDir, { recursive: true, force: true });
});

describe('MCP dual-era HTTP compatibility', () => {
  it('serves the 2025-11-25 initialize era', async () => {
    httpServer = await _startHttp(0, privateAuthConfig());
    const client = await startClient();

    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 11);
    assert.ok(tools.tools.some((tool) => tool.name === 'set_device_note'));
  });

  it('serves the 2026-07-28 discover era from the same tool factory', async () => {
    httpServer = await _startHttp(0, privateAuthConfig());
    const client = await startClient({ mode: { pin: '2026-07-28' } });

    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 11);
    assert.ok(tools.tools.some((tool) => tool.name === 'set_device_note'));
  });

  it('negotiates the modern era automatically without tool drift', async () => {
    httpServer = await _startHttp(0, privateAuthConfig());
    const client = await startClient({ mode: 'auto' });

    assert.equal(client.getProtocolEra(), 'modern');
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
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
      ]
    );
  });

  it('rejects a modern header/body method mismatch with the standard error', async () => {
    httpServer = await _startHttp(0, privateAuthConfig());
    const response = await postModern({
      method: 'tools/list',
      methodHeader: 'tools/call',
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error?.code, -32020);
  });

  it('rejects an unsupported modern protocol version with the standard error', async () => {
    httpServer = await _startHttp(0, privateAuthConfig());
    const response = await postModern({ version: '2099-01-01' });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error?.code, -32022);
    assert.deepEqual(body.error?.data?.supported, [MODERN_VERSION]);
  });
});
