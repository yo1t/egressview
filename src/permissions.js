'use strict';

const PERMISSIONS = Object.freeze({
  NETWORK_READ: 'network.read',
  NOTES_WRITE: 'notes.write',
  AI_RUN: 'ai.run',
  SETTINGS_WRITE: 'settings.write',
  BACKUP_RESTORE: 'backup.restore',
  AUTH_ADMIN: 'auth.admin',
  AUDIT_READ: 'audit.read',
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
const AGENT_PERMISSIONS = Object.freeze({
  INGEST: 'agent.ingest',
});
const KNOWN_PERMISSIONS = new Set([
  ...ALL_PERMISSIONS,
  ...Object.values(AGENT_PERMISSIONS),
]);

function normalizePermissions(permissions) {
  if (!permissions) return [];
  if (typeof permissions === 'string') return [permissions];
  return Array.from(permissions);
}

function assertKnownPermissions(permissions) {
  for (const permission of normalizePermissions(permissions)) {
    if (!KNOWN_PERMISSIONS.has(permission)) {
      throw new Error(`Unknown permission: ${permission}`);
    }
  }
}

function checkPermissions(grantedPermissions, requiredPermissions) {
  const granted = new Set(normalizePermissions(grantedPermissions));
  const required = normalizePermissions(requiredPermissions);
  assertKnownPermissions(granted);
  assertKnownPermissions(required);

  const missing = required.filter((permission) => !granted.has(permission));
  return Object.freeze({
    allowed: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

module.exports = {
  PERMISSIONS,
  AGENT_PERMISSIONS,
  ALL_PERMISSIONS,
  assertKnownPermissions,
  checkPermissions,
};
