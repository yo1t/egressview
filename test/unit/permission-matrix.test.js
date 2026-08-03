'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ACCESS,
  HTTP_ROUTE_MATRIX,
  MCP_TOOL_PERMISSIONS,
  classifyHttpRequest,
  permissionForMcpTool,
} = require('../../src/permission-matrix');
const {
  ALL_PERMISSIONS,
  PERMISSIONS,
  checkPermissions,
} = require('../../src/permissions');

const root = path.join(__dirname, '..', '..');

function implementedHttpRoutes() {
  const routes = [];
  const routeDir = path.join(root, 'src', 'routes');
  for (const file of fs.readdirSync(routeDir).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(routeDir, file), 'utf8');
    for (const match of source.matchAll(/router\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)) {
      routes.push(`${match[1].toUpperCase()} /api${match[2]}`);
    }
  }
  routes.push('GET /healthz', 'GET /readyz');
  return [...new Set(routes)].sort();
}

function registeredMcpTools() {
  // Tool definitions live in src/mcp-tools.js since P2-68; this scan is the
  // drift guard between the registered tools and the permission matrix, so it
  // has to follow them.
  const source = fs.readFileSync(path.join(root, 'src', 'mcp-tools.js'), 'utf8');
  return [...source.matchAll(/registerTool\(\s*server,\s*['"]([^'"]+)['"]/g)]
    .map(match => match[1])
    .sort();
}

describe('permission checker', () => {
  it('requires every requested permission', () => {
    assert.deepEqual(
      checkPermissions(
        [PERMISSIONS.NETWORK_READ, PERMISSIONS.NOTES_WRITE],
        [PERMISSIONS.NETWORK_READ]
      ),
      { allowed: true, missing: [] }
    );
    assert.deepEqual(
      checkPermissions([PERMISSIONS.NETWORK_READ], [PERMISSIONS.NOTES_WRITE]),
      { allowed: false, missing: [PERMISSIONS.NOTES_WRITE] }
    );
  });

  it('rejects unknown permissions instead of treating them as metadata', () => {
    assert.throws(
      () => checkPermissions(ALL_PERMISSIONS, ['future.unclassified']),
      /Unknown permission/
    );
  });
});

describe('HTTP permission matrix', () => {
  it('classifies every implemented endpoint exactly once', () => {
    const classified = HTTP_ROUTE_MATRIX
      .map(entry => `${entry.method} ${entry.path}`)
      .sort();
    assert.deepEqual(classified, implementedHttpRoutes());
    assert.equal(new Set(classified).size, classified.length);
  });

  it('keeps the public surface explicit and minimal', () => {
    const publicRoutes = HTTP_ROUTE_MATRIX
      .filter(entry => entry.access === ACCESS.PUBLIC)
      .map(entry => `${entry.method} ${entry.path}`)
      .sort();
    assert.deepEqual(publicRoutes, [
      'GET /api/auth/methods',
      'GET /api/auth/oidc/callback',
      'GET /api/auth/oidc/start',
      'GET /api/auth/status',
      'GET /healthz',
      'GET /readyz',
      'POST /api/admin/verify',
      'POST /api/auth/login',
    ]);
  });

  it('matches parameters, query strings, and an optional deployment subpath', () => {
    assert.equal(
      classifyHttpRequest('PUT', '/api/routers/router-1?probe=1').permissions[0],
      PERMISSIONS.SETTINGS_WRITE
    );
    assert.equal(
      classifyHttpRequest('GET', '/egressview/api/backup/download/nightly.db').permissions[0],
      PERMISSIONS.SETTINGS_WRITE
    );
    assert.equal(classifyHttpRequest('GET', '/api/unclassified'), null);
  });
});

describe('MCP permission matrix', () => {
  it('classifies every registered tool and no nonexistent tool', () => {
    assert.deepEqual(Object.keys(MCP_TOOL_PERMISSIONS).sort(), registeredMcpTools());
    for (const tool of registeredMcpTools()) {
      assert(ALL_PERMISSIONS.includes(permissionForMcpTool(tool)));
    }
  });

  it('limits note mutation to notes.write', () => {
    assert.equal(permissionForMcpTool('set_device_note'), PERMISSIONS.NOTES_WRITE);
    assert.equal(permissionForMcpTool('get_device_notes'), PERMISSIONS.NETWORK_READ);
    assert.equal(permissionForMcpTool('future_tool'), null);
  });
});
