'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PERMISSIONS } = require('../../src/permissions');
const { createMcpScopeMapping } = require('../../src/mcp-scope-mapping');

function mapping() {
  return createMcpScopeMapping({
    readScope: 'provider.example/egressview.read',
    notesWriteScope: 'provider.example/egressview.notes.write',
  });
}

describe('MCP OAuth scope mapping', () => {
  it('maps provider scopes to the shared internal permission vocabulary', () => {
    const policy = mapping();
    assert.deepEqual(
      policy.permissionsForScopes([
        'openid',
        'provider.example/egressview.read',
        'unknown-provider-scope',
      ]),
      [PERMISSIONS.NETWORK_READ]
    );
    assert.deepEqual(
      policy.permissionsForScopes([
        'provider.example/egressview.read',
        'provider.example/egressview.notes.write',
      ]),
      [PERMISSIONS.NETWORK_READ, PERMISSIONS.NOTES_WRITE]
    );
  });

  it('allows read tools with read scope and denies the write tool', () => {
    const policy = mapping();
    const scopes = ['provider.example/egressview.read'];
    assert.equal(policy.authorizeTool('get_devices', scopes).allowed, true);
    const denied = policy.authorizeTool('set_device_note', scopes);
    assert.equal(denied.allowed, false);
    assert.deepEqual(denied.requiredScopes, [
      'provider.example/egressview.read',
      'provider.example/egressview.notes.write',
    ]);
  });

  it('allows set_device_note only after the write scope is present', () => {
    const policy = mapping();
    const authorized = policy.authorizeTool('set_device_note', [
      'provider.example/egressview.read',
      'provider.example/egressview.notes.write',
    ]);
    assert.equal(authorized.allowed, true);
    assert.equal(authorized.requiredPermission, PERMISSIONS.NOTES_WRITE);
  });

  it('fails closed for unclassified tools and unmapped permissions', () => {
    const policy = mapping();
    assert.deepEqual(policy.authorizeTool('future_tool', policy.scopesSupported), {
      classified: false,
      allowed: false,
      requiredPermission: null,
      requiredScope: null,
    });
  });

  it('rejects missing or overlapping configured scopes', () => {
    assert.throws(
      () => createMcpScopeMapping({ readScope: '', notesWriteScope: 'write' }),
      /required/
    );
    assert.throws(
      () => createMcpScopeMapping({ readScope: 'same', notesWriteScope: 'same' }),
      /must differ/
    );
  });
});
