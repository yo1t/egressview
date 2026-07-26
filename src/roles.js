// Browser session roles (P2-61 Phase 3).
//
// A role is a named bundle of the Phase 1 permissions. It is always derived on
// the server from how the caller authenticated — never read from request
// bodies, query strings, cookies, or unverified identity-provider claims — so
// a caller cannot name the role it wants.
//
// Compatibility rules that must not regress:
//   - the emergency local administrator is always `admin`; it is the recovery
//     path and must keep working when an IdP is unreachable
//   - the legacy X-Admin-Token is always `admin` during the expand phase
//   - an OIDC user matched by the *domain* allowlist defaults to `viewer`,
//     because a domain grant is a bulk grant nobody reviewed per person
//   - an OIDC user matched by an explicit *email* entry is `admin`, because
//     someone listed that person deliberately
'use strict';

const { PERMISSIONS, ALL_PERMISSIONS } = require('./permissions');

const ROLES = Object.freeze({
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  ADMIN: 'admin',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

// Read-only monitoring.
const VIEWER_PERMISSIONS = Object.freeze([
  PERMISSIONS.NETWORK_READ,
]);

// Day-to-day operation: viewer plus the mutations that do not touch
// credentials, settings, or backups.
const OPERATOR_PERMISSIONS = Object.freeze([
  ...VIEWER_PERMISSIONS,
  PERMISSIONS.NOTES_WRITE,
  PERMISSIONS.AI_RUN,
]);

// Everything, including routers, authentication, secrets and backup restore.
const ADMIN_PERMISSIONS = Object.freeze([...ALL_PERMISSIONS]);

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.VIEWER]: VIEWER_PERMISSIONS,
  [ROLES.OPERATOR]: OPERATOR_PERMISSIONS,
  [ROLES.ADMIN]: ADMIN_PERMISSIONS,
});

function isKnownRole(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

/**
 * Resolve a stored role to its permissions.
 * An unknown or missing role grants nothing rather than falling back to a
 * broader role, so a record this build cannot interpret cannot escalate.
 */
function permissionsForRole(role) {
  if (!isKnownRole(role)) return Object.freeze([]);
  return ROLE_PERMISSIONS[role];
}

/**
 * Normalize a role that is about to be stored. Returns null for anything this
 * build does not define, so callers refuse instead of guessing.
 */
function normalizeRole(role) {
  return isKnownRole(role) ? role : null;
}

/**
 * Decide the role for a completed OIDC login from how the allowlist matched.
 * `match` comes from the server-side allowlist comparison, never from a claim
 * the caller could influence.
 * @param {'email'|'domain'|null} match
 */
function roleForOidcMatch(match) {
  if (match === 'email') return ROLES.ADMIN;
  if (match === 'domain') return ROLES.VIEWER;
  return null; // no match means no session at all
}

module.exports = {
  ROLES,
  ALL_ROLES,
  ROLE_PERMISSIONS,
  isKnownRole,
  permissionsForRole,
  normalizeRole,
  roleForOidcMatch,
};
