'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { parseConntrack } = require('../../src/pollers/conntrack');
const { parseNatTranslations } = require('../../src/pollers/cisco-adapter');

const ROOT = path.resolve(__dirname, '../..');
const NETWORK_GUARD = path.join(ROOT, 'test/fixtures/deny-external-network.js');
const ADMIN_TOKEN = 'phase3-portability-admin-token';
const MCP_TOKEN = 'phase3-private-endpoint-token';
const AUDIT_KEY = 'phase3-portability-dedicated-audit-hmac-key';

let dir;
let web;
let webPort;
let baseUrl;
let egressAudit;
let dbPath;
let configPath;
let backupDir;

function childEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_OPTIONS: `--require=${NETWORK_GUARD}`,
    EGRESSVIEW_EGRESS_AUDIT_PATH: egressAudit,
    EGRESSVIEW_OFFLINE_MODE: 'true',
    EGRESSVIEW_DB_PATH: dbPath,
    EGRESSVIEW_CONFIG_PATH: configPath,
    EGRESSVIEW_BACKUP_DIR: backupDir,
    EGRESSVIEW_URL: baseUrl,
    EGRESSVIEW_TOKEN: ADMIN_TOKEN,
    AWS_EC2_METADATA_DISABLED: 'true',
    ...extra,
  };
  for (const key of Object.keys(process.env)) {
    if (/^(AWS|GOOGLE|OPENAI|ANTHROPIC)_/.test(key)) delete env[key];
  }
  return env;
}

function spawnChild(file, env) {
  const child = spawn(process.execPath, [file], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Process exited before readiness:\n${child.output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${child.output}`);
}

async function waitForMcp(endpoint, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`MCP process exited before readiness:\n${child.output}`);
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${endpoint}:\n${child.output}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'X-Admin-Token': ADMIN_TOKEN,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

async function startWeb() {
  web = spawnChild(path.join(ROOT, 'server.js'), childEnv({
    DEMO_MODE: 'true',
    DEMO_ADMIN_TOKEN: ADMIN_TOKEN,
    HOST: '127.0.0.1',
    PORT: String(webPort),
  }));
  await waitFor(`${baseUrl}/readyz`, web);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-portability-'));
  dbPath = path.join(dir, 'runtime.db');
  configPath = path.join(dir, 'config.json');
  backupDir = path.join(dir, 'backups');
  egressAudit = path.join(dir, 'egress-attempts.jsonl');
  fs.copyFileSync(path.join(ROOT, '.egressview.demo.db'), dbPath);
  fs.writeFileSync(configPath, '{}\n', { mode: 0o600 });
  webPort = await unusedPort();
  baseUrl = `http://127.0.0.1:${webPort}`;
  await startWeb();
});

after(async () => {
  await stop(web);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('P2-65 Phase 3 portability gate', { timeout: 90_000 }, () => {
  it('serves the offline Web runtime with self-hosted assets and data', async () => {
    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    assert.doesNotMatch(root.headers.get('content-security-policy'), /https?:/);

    for (const asset of [
      '/vendor/d3-7.9.0.min.js',
      '/vendor/topojson-client-3.1.0.min.js',
      '/vendor/world-atlas-countries-110m-2.0.2.json',
    ]) {
      assert.equal((await fetch(`${baseUrl}${asset}`)).status, 200);
    }

    const status = await api('/api/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.body.offlineMode, true);
    const devices = await api('/api/devices');
    const connections = await api('/api/connections?limit=10');
    assert.equal(devices.response.status, 200);
    assert.ok(devices.body.devices.length > 0);
    assert.equal(connections.response.status, 200);
    assert.ok(connections.body.connections.length > 0);
  });

  it('parses representative Cisco and conntrack router acquisitions', () => {
    const cisco = fs.readFileSync(
      path.join(ROOT, 'test/fixtures/cisco/nat-translations-verbose-real.txt'),
      'utf8'
    );
    const conntrack = fs.readFileSync(
      path.join(ROOT, 'test/fixtures/conntrack/procfs.txt'),
      'utf8'
    );
    assert.ok(parseNatTranslations(cisco).length > 0);
    assert.ok(parseConntrack(conntrack).length > 0);
  });

  it('creates, restores, and reopens a verified SQLite backup', async () => {
    const created = await api('/api/backup/create', { method: 'POST' });
    assert.equal(created.response.status, 200);
    assert.match(created.body.name, /^egressview_.*\.db$/);

    const restored = await api('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify({ name: created.body.name }),
    });
    assert.equal(restored.response.status, 200);

    await stop(web);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
    await startWeb();
    assert.equal((await api('/api/devices')).response.status, 200);
  });

  it('serves stdio MCP from the same offline artifact', async () => {
    const client = new Client({ name: 'phase3-stdio', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'mcp-server.js')],
      cwd: ROOT,
      env: childEnv({ EGRESSVIEW_DEPLOYMENT_PROFILE: 'local-stdio' }),
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 11);
      const result = await client.callTool({ name: 'get_devices', arguments: {} });
      assert.equal(result.isError, undefined);
    } finally {
      await client.close();
    }
  });

  it('enforces authentication and audits private HTTP MCP', async () => {
    const identity = await api('/api/auth/api-identities', {
      method: 'POST',
      body: JSON.stringify({
        label: 'phase3-private-mcp',
        permissions: ['network.read', 'notes.write'],
        expiresInMs: 3_600_000,
      }),
    });
    assert.equal(identity.response.status, 201);

    const mcpPort = await unusedPort();
    const auditDb = path.join(dir, 'mcp-audit.db');
    const mcp = spawnChild(path.join(ROOT, 'mcp-server.js'), childEnv({
      EGRESSVIEW_DEPLOYMENT_PROFILE: 'private-http',
      MCP_PORT: String(mcpPort),
      MCP_BIND_ADDRESS: '127.0.0.1',
      MCP_AUTH_MODE: 'token',
      MCP_TOKEN,
      MCP_SERVICE_TOKEN: identity.body.token,
      MCP_AUDIT_HMAC_KEY: AUDIT_KEY,
      MCP_AUDIT_DB_PATH: auditDb,
    }));
    const endpoint = new URL(`http://127.0.0.1:${mcpPort}/mcp`);
    try {
      await waitForMcp(endpoint, mcp);
      const unauthorized = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      assert.equal(unauthorized.status, 401);

      const adminCredential = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      assert.equal(adminCredential.status, 401);

      const client = new Client({ name: 'phase3-private-http', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      });
      try {
        await client.connect(transport);
        assert.equal((await client.listTools()).tools.length, 11);
        const result = await client.callTool({ name: 'get_devices', arguments: {} });
        assert.equal(result.isError, undefined);
      } finally {
        await client.close();
      }
    } finally {
      await stop(mcp);
    }

    const audit = new Database(auditDb, { readonly: true, fileMustExist: true });
    assert.equal(audit.pragma('integrity_check', { simple: true }), 'ok');
    const rows = audit.prepare('SELECT COUNT(*) AS count FROM mcp_audit_events').get().count;
    audit.close();
    assert.ok(rows >= 3);
    assert.equal(fs.readFileSync(auditDb).includes(Buffer.from(MCP_TOKEN)), false);
  });

  it('records no public DNS or socket attempt and proves the guard is active', () => {
    assert.equal(fs.existsSync(egressAudit), false);
    const controlAudit = path.join(dir, 'positive-control.jsonl');
    const control = spawnSync(process.execPath, [
      '-e',
      "require('node:dns').lookup('phase3.invalid', () => process.exit(7))",
    ], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--require=${NETWORK_GUARD}`,
        EGRESSVIEW_EGRESS_AUDIT_PATH: controlAudit,
      },
      encoding: 'utf8',
    });
    assert.equal(control.status, 7);
    assert.match(fs.readFileSync(controlAudit, 'utf8'), /"kind":"dns".*"phase3\.invalid"/);
  });
});
