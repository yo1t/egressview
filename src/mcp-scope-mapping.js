'use strict';

const { checkPermissions, PERMISSIONS } = require('./permissions');
const { permissionForMcpTool } = require('./permission-matrix');

function createMcpScopeMapping({ readScope, notesWriteScope }) {
  const normalizedReadScope = String(readScope || '').trim();
  const normalizedNotesWriteScope = String(notesWriteScope || '').trim();
  if (!normalizedReadScope || !normalizedNotesWriteScope) {
    throw new Error('MCP OAuth read and notes.write scopes are required');
  }
  if (normalizedReadScope === normalizedNotesWriteScope) {
    throw new Error('MCP OAuth read and notes.write scopes must differ');
  }

  const scopeToPermission = new Map([
    [normalizedReadScope, PERMISSIONS.NETWORK_READ],
    [normalizedNotesWriteScope, PERMISSIONS.NOTES_WRITE],
  ]);
  const permissionToScope = new Map(
    [...scopeToPermission].map(([scope, permission]) => [permission, scope])
  );

  function permissionsForScopes(scopes) {
    const permissions = new Set();
    for (const scope of scopes || []) {
      const permission = scopeToPermission.get(scope);
      if (permission) permissions.add(permission);
    }
    return Object.freeze([...permissions]);
  }

  function authorizeTool(toolName, scopes) {
    const requiredPermission = permissionForMcpTool(toolName);
    if (!requiredPermission) {
      return Object.freeze({
        classified: false,
        allowed: false,
        requiredPermission: null,
        requiredScope: null,
      });
    }
    const requiredScope = permissionToScope.get(requiredPermission) || null;
    if (!requiredScope) {
      return Object.freeze({
        classified: true,
        allowed: false,
        requiredPermission,
        requiredScope: null,
      });
    }
    const grantedPermissions = permissionsForScopes(scopes);
    const requiredScopes = requiredPermission === PERMISSIONS.NOTES_WRITE
      ? Object.freeze([normalizedReadScope, requiredScope])
      : Object.freeze([requiredScope]);
    return Object.freeze({
      classified: true,
      allowed: checkPermissions(grantedPermissions, requiredPermission).allowed,
      requiredPermission,
      requiredScope,
      requiredScopes,
    });
  }

  return Object.freeze({
    readScope: normalizedReadScope,
    notesWriteScope: normalizedNotesWriteScope,
    scopesSupported: Object.freeze([normalizedReadScope, normalizedNotesWriteScope]),
    permissionsForScopes,
    authorizeTool,
  });
}

module.exports = { createMcpScopeMapping };
