'use strict';

const crypto = require('node:crypto');

function createAuthMiddleware({ appState, sessions, authCookies, authAudit }) {
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
      if (auth && auth !== 'admin') return { auth, source: 'cookie' };
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

  function requireAdmin(req, res, next) {
    if (!appState.adminToken) return res.status(503).json({ error: '認証未初期化' });
    const result = authenticateRequest(req);
    if (!result) return res.status(401).json({ error: '認証エラー' });
    req.session = result.auth === 'admin' ? null : result.auth;
    req.authSource = result.source;
    req.authMethod = result.auth === 'admin' ? 'api-token' : result.auth.authMethod || 'local';
    req.actor = result.auth === 'admin' ? 'admin-api-token' : `session:${result.auth.id}`;
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
    next();
  }

  return { authenticate, authenticateRequest, requireAdmin };
}

module.exports = { createAuthMiddleware };
