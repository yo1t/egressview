'use strict';

const { PERMISSIONS, assertKnownPermissions } = require('./permissions');

const ACCESS = Object.freeze({
  PUBLIC: 'public',
  AUTHENTICATED: 'authenticated',
  PERMISSION: 'permission',
});

function httpRoute(method, path, access, permissions = []) {
  assertKnownPermissions(permissions);
  if (!Object.values(ACCESS).includes(access)) {
    throw new Error(`${method} ${path} has an unknown access classification: ${access}`);
  }
  if (access === ACCESS.PERMISSION && permissions.length === 0) {
    throw new Error(`${method} ${path} requires at least one permission`);
  }
  if (access !== ACCESS.PERMISSION && permissions.length > 0) {
    throw new Error(`${method} ${path} cannot mix ${access} access with permissions`);
  }
  return Object.freeze({
    method,
    path,
    access,
    permissions: Object.freeze([...permissions]),
  });
}

const R = PERMISSIONS;

const HTTP_ROUTE_MATRIX = Object.freeze([
  httpRoute('GET', '/healthz', ACCESS.PUBLIC),
  httpRoute('GET', '/readyz', ACCESS.PUBLIC),

  httpRoute('GET', '/api/auth/status', ACCESS.PUBLIC),
  httpRoute('GET', '/api/auth/methods', ACCESS.PUBLIC),
  httpRoute('POST', '/api/auth/login', ACCESS.PUBLIC),
  httpRoute('POST', '/api/admin/verify', ACCESS.PUBLIC),
  httpRoute('GET', '/api/auth/oidc/start', ACCESS.PUBLIC),
  httpRoute('GET', '/api/auth/oidc/callback', ACCESS.PUBLIC),

  httpRoute('POST', '/api/auth/logout', ACCESS.AUTHENTICATED),

  httpRoute('GET', '/api/status', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/connections', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/connections/export', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/connections/memory', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/connections/new-nodes', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/connections/summary', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/connections/threat-connections', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/connections/threat-counts', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/devices', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/devices/merge-candidates', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/notes', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/notification-log', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/routers', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/beacons', ACCESS.PERMISSION, [R.NETWORK_READ]),

  httpRoute('POST', '/api/notes', ACCESS.PERMISSION, [R.NOTES_WRITE]),
  httpRoute('POST', '/api/notes/draft', ACCESS.PERMISSION, [R.NOTES_WRITE]),

  httpRoute('GET', '/api/ai/conversations', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('GET', '/api/ai/conversations/:id', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('DELETE', '/api/ai/conversations/:id', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('GET', '/api/ai/facts', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('GET', '/api/ai/pricing/diagnostics', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('GET', '/api/ai/usage/monthly', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('POST', '/api/ai/analyze', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('POST', '/api/ai/chat', ACCESS.PERMISSION, [R.AI_RUN]),
  httpRoute('POST', '/api/ai/notification-run-now', ACCESS.PERMISSION, [R.AI_RUN]),

  httpRoute('GET', '/api/config/ai', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/config/datasources', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/config/manual-threat', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/config/slack', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/config/detection-notifications', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/ai/notification-config', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/beacons/config', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/backup/list', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/backup/download/:name', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('GET', '/api/backup/prune/:jobId', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('DELETE', '/api/backup/prune/:jobId', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/ai/guardrails', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/ai/models', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/ai/notification-config', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/ai/notification-test', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/ai/pricing/check', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/ai/test', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/backup/config', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/backup/create', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/backup/prune', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/beacons/:id/dismiss', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/beacons/config', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/cisco/detect', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/config/ai', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/config/datasources', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/config/general', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/config/manual-threat', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/config/slack', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/config/detection-notifications', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/devices/archive', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/devices/merge', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/devices/reject', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/devices/unarchive', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/login', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/nonce', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/routers', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/routers/detect', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('PUT', '/api/routers/:id', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('DELETE', '/api/routers/:id', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/slack/lookup-user', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/slack/test', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/slack/verify', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/threat/manual-lookup', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),
  httpRoute('POST', '/api/yamaha/detect', ACCESS.PERMISSION, [R.SETTINGS_WRITE]),

  httpRoute('POST', '/api/backup/restore', ACCESS.PERMISSION, [R.BACKUP_RESTORE]),
  httpRoute('POST', '/api/backup/upload', ACCESS.PERMISSION, [R.BACKUP_RESTORE]),

  httpRoute('GET', '/api/auth/api-identities', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/auth/api-identities', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/auth/api-identities/:id/revoke', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('GET', '/api/auth/api-identities/self', ACCESS.PERMISSION, [R.NETWORK_READ]),
  httpRoute('GET', '/api/auth/security-config', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('GET', '/api/auth/sessions', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/admin/regenerate-token', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/auth/change-password', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/auth/oidc/test', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/auth/security-config', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/auth/sessions/:id/revoke', ACCESS.PERMISSION, [R.AUTH_ADMIN]),
  httpRoute('POST', '/api/auth/sessions/revoke-all', ACCESS.PERMISSION, [R.AUTH_ADMIN]),

  httpRoute('GET', '/api/auth/audit-events', ACCESS.PERMISSION, [R.AUDIT_READ]),
  httpRoute('GET', '/api/ai/notification-events', ACCESS.PERMISSION, [R.AUDIT_READ]),
]);

const MCP_TOOL_PERMISSIONS = Object.freeze({
  get_threat_summary: R.NETWORK_READ,
  get_traffic_summary: R.NETWORK_READ,
  get_top_destinations: R.NETWORK_READ,
  get_device_traffic: R.NETWORK_READ,
  get_new_nodes: R.NETWORK_READ,
  get_threat_connections: R.NETWORK_READ,
  get_alerts: R.NETWORK_READ,
  get_devices: R.NETWORK_READ,
  query_connections: R.NETWORK_READ,
  get_device_notes: R.NETWORK_READ,
  set_device_note: R.NOTES_WRITE,
});

assertKnownPermissions(Object.values(MCP_TOOL_PERMISSIONS));

const routePatternCache = new Map();

function canonicalHttpPath(value) {
  const path = String(value || '/').split('?')[0];
  const apiIndex = path.indexOf('/api/');
  if (apiIndex >= 0) return path.slice(apiIndex);
  if (path.endsWith('/api')) return '/api';
  return path;
}

function routePattern(path) {
  let pattern = routePatternCache.get(path);
  if (!pattern) {
    const escaped = path
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    pattern = new RegExp(`^${escaped}/?$`);
    routePatternCache.set(path, pattern);
  }
  return pattern;
}

function classifyHttpRequest(method, path) {
  const normalizedMethod = String(method || '').toUpperCase();
  const normalizedPath = canonicalHttpPath(path);
  return HTTP_ROUTE_MATRIX.find(
    (entry) => entry.method === normalizedMethod && routePattern(entry.path).test(normalizedPath)
  ) || null;
}

function permissionForMcpTool(name) {
  return MCP_TOOL_PERMISSIONS[name] || null;
}

module.exports = {
  ACCESS,
  HTTP_ROUTE_MATRIX,
  MCP_TOOL_PERMISSIONS,
  canonicalHttpPath,
  classifyHttpRequest,
  permissionForMcpTool,
};
