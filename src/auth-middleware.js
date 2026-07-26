'use strict';

const crypto = require('node:crypto');
const { ALL_PERMISSIONS, checkPermissions } = require('./permissions');
const { ACCESS, classifyHttpRequest } = require('./permission-matrix');

// Credential kinds are kept separate on purpose: a browser session is never
// usable as an API credential and a scoped API identity is never usable as a
// browser session. Only the permission decision is shared between them.
function isApiIdentity(auth) {
  return Boolean(auth) && typeof auth === 'object' && auth.kind === 'api-identity';
}

function defaultResolvePermissions({ auth }) {
  // Scoped identities carry exactly what was granted at issue time.
  if (isApiIdentity(auth)) return auth.identity.permissions;
  // Browser sessions and the legacy admin token stay full-access during the
  // expand phase; Phase 3 narrows browser sessions by role.
  return ALL_PERMISSIONS;
}

function createAuthMiddleware({
  appState,
  sessions,
  authCookies,
  authAudit,
  apiIdentities = null,
  resolvePermissions = defaultResolvePermissions,
}) {
  function authenticate(provided) {
    if (!provided) return null;
    const session = sessions.verifySession(provided);
    if (session) return session;
    if (appState.adminToken) {
      const candidate = Buffer.from(provided);
      const stored = Buffer.from(appState.adminToken);
      if (candidate.length === stored.length &&
          crypto.timingSafeEqual(candidate, stored)) {
        return 'admin';
      }
    }
    // Scoped API identities are verified last so an existing deployment keeps
    // its current behaviour unchanged until identities are actually issued.
    if (apiIdentities) {
      const identity = apiIdentities.verifyToken(provided);
      if (identity) return { kind: 'api-identity', identity };
    }
    return null;
  }

  function authenticateRequest(req) {
    const headerToken = req.get?.('X-Admin-Token') || '';
    if (headerToken) {
      const auth = authenticate(headerToken);
      if (auth) return { auth, source: 'header' };
    }
    const cookieToken = authCookies.sessionToken(req);
    if (cookieToken) {
      const auth = authenticate(cookieToken);
      // Cookies carry browser sessions only. Refusing the other kinds here
      // stops an API credential from being replayed as a browser session.
      if (auth && auth !== 'admin' && !isApiIdentity(auth)) return { auth, source: 'cookie' };
    }
    return null;
  }

  function appendAudit(req, eventType, outcome, metadata) {
    authAudit.append({
      eventType,
      outcome,
      authMethod: req.authMethod,
      actor: req.actor,
      requestId: req.id,
      clientIp: req.ip,
      httpMethod: req.method,
      path: req.originalUrl,
      metadata,
    });
  }

  function authorizeRequest(req, res, next, requiredPermissions) {
    if (!appState.adminToken) return res.status(503).json({ error: '認証未初期化' });
    const result = authenticateRequest(req);
    if (!result) return res.status(401).json({ error: '認証エラー' });
    const identity = isApiIdentity(result.auth) ? result.auth.identity : null;
    req.session = result.auth === 'admin' || identity ? null : result.auth;
    req.apiIdentity = identity;
    req.authSource = result.source;
    if (identity) {
      req.authMethod = 'api-identity';
      req.actor = `api:${identity.id}`;
    } else if (result.auth === 'admin') {
      req.authMethod = 'api-token';
      req.actor = 'admin-api-token';
    } else {
      req.authMethod = result.auth.authMethod || 'local';
      req.actor = `session:${result.auth.id}`;
    }
    req.permissions = Object.freeze([...resolvePermissions({
      auth: result.auth,
      source: result.source,
      req,
    })]);
    const permissionCheck = checkPermissions(req.permissions, requiredPermissions);
    if (!permissionCheck.allowed) {
      appendAudit(req, 'permission_denied', 'failure', {
        requiredPermissions,
        missingPermissions: permissionCheck.missing,
      });
      return res.status(403).json({ error: 'Permission denied' });
    }
    if (!authCookies.verifyCookieCsrf(req, sessions)) {
      appendAudit(req, 'csrf_rejected', 'failure');
      return res.status(403).json({ error: 'CSRF validation failed' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.on('finish', () => {
        appendAudit(
          req,
          'api_mutation',
          res.statusCode < 400 ? 'success' : 'failure',
          { statusCode: res.statusCode }
        );
      });
    }
    req.permissionAuthorized = true;
    next();
  }

  function enforceApiPermissions(req, res, next) {
    const policy = classifyHttpRequest(req.method, req.originalUrl);
    if (!policy) {
      return res.status(404).json({ error: 'Not found' });
    }
    req.permissionPolicy = policy;
    if (policy.access === ACCESS.PUBLIC) return next();
    return authorizeRequest(req, res, next, policy.permissions);
  }

  function requireAdmin(req, res, next) {
    if (req.permissionAuthorized) return next();
    const policy = classifyHttpRequest(req.method, req.originalUrl);
    const requiredPermissions = policy && policy.access !== ACCESS.PUBLIC
      ? policy.permissions
      : ALL_PERMISSIONS;
    return authorizeRequest(req, res, next, requiredPermissions);
  }

  return {
    authenticate,
    authenticateRequest,
    enforceApiPermissions,
    requireAdmin,
  };
}

module.exports = { createAuthMiddleware };
