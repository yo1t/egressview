'use strict';

const { ROLES } = require('../roles');
const crypto = require('crypto');
const { Router } = require('express');
const { z } = require('zod');
const logger = require('../logger');
const { t } = require('../i18n-server');
const { parseRequest } = require('../http-validation');

const loginSchema = z.object({
  password: z.string().min(1).max(256),
  deviceLabel: z.string().max(200).optional(),
}).strict();
const sessionIdSchema = z.object({ id: z.coerce.number().int().positive() }).strict();
const revokeAllSchema = z.object({ includeSelf: z.boolean().optional() }).strict();
const changePasswordSchema = z.object({
  currentPassword: z.string().max(256),
  newPassword: z.string().min(14).max(256),
  revokeOtherSessions: z.boolean().optional(),
}).strict();
const currentPasswordSchema = z.object({ currentPassword: z.string().max(256) }).strict();
const tokenSchema = z.object({ token: z.string().max(4096) }).strict();

module.exports = function authSessionRoutes(ctx) {
  const {
    requireAdmin, getAdminToken, saveConfig,
    appState, io, sessions, authPassword, authAudit, authCookies,
    configFile, fs, subpath = '',
  } = ctx;
  const router = Router();
  const loginAttempts = new Map();
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_LOCK_MS = 5 * 60_000;
  const LOGIN_WINDOW_MS = 10 * 60_000;

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginAttempts) {
      const expiry = entry.lockedUntil || (entry.firstFail + LOGIN_WINDOW_MS);
      if (now > expiry) loginAttempts.delete(ip);
    }
  }, 60 * 60_000).unref();

  function checkRateLimit(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry) return null;
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return t('auth.rate-limited', { n: Math.ceil((entry.lockedUntil - now) / 1000) });
    }
    if (now - entry.firstFail > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
    return null;
  }

  function recordFailure(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, firstFail: now };
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_FAILS) entry.lockedUntil = now + LOGIN_LOCK_MS;
    loginAttempts.set(ip, entry);
  }

  function delayedUnauthorized(res, body) {
    return setTimeout(() => {
      if (!res.headersSent) res.status(401).json(body);
    }, 500);
  }

  function audit(req, eventType, outcome = 'success', metadata) {
    authAudit?.append({
      eventType,
      outcome,
      authMethod: req.authMethod || 'local',
      actor: req.actor,
      requestId: req.id,
      clientIp: req.ip || req.socket?.remoteAddress || '',
      httpMethod: req.method,
      path: req.originalUrl,
      metadata,
    });
  }

  function verifyLocalPassword(password) {
    return authPassword.verifyPassword(
      password,
      appState.authPasswordRecord || appState.authPasswordSalt,
      appState.authPasswordHash
    );
  }

  router.post('/auth/login', (req, res) => {
    if (!appState.authPasswordHash) return res.status(503).json({ error: t('auth.not-init') });
    const parsed = parseRequest(loginSchema, req.body, res, { error: t('auth.enter-password') });
    if (!parsed.ok) return;
    const { password, deviceLabel } = parsed.data;
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitError = checkRateLimit(clientIp);
    if (rateLimitError) {
      audit(req, 'login', 'failure', { reason: 'rate_limited' });
      return res.status(429).json({ error: rateLimitError });
    }
    if (!verifyLocalPassword(password)) {
      recordFailure(clientIp);
      logger.warn('[auth] Login failed');
      audit(req, 'login', 'failure', { reason: 'invalid_credentials' });
      return delayedUnauthorized(res, { error: t('auth.wrong-password') });
    }
    loginAttempts.delete(clientIp);
    if (authPassword.needsRehash?.(appState.authPasswordRecord)) {
      const previous = {
        salt: appState.authPasswordSalt,
        hash: appState.authPasswordHash,
        record: appState.authPasswordRecord,
      };
      const next = authPassword.hashPassword(password);
      appState.authPasswordSalt = next.salt;
      appState.authPasswordHash = next.hash;
      appState.authPasswordRecord = next.record;
      try {
        saveConfig();
      } catch (error) {
        appState.authPasswordSalt = previous.salt;
        appState.authPasswordHash = previous.hash;
        appState.authPasswordRecord = previous.record;
        logger.warn('[auth] Password KDF record migration deferred:', error.message);
      }
    }
    const session = sessions.createSession(
      typeof deviceLabel === 'string' ? deviceLabel : '',
      // The emergency local administrator is always admin: it is the recovery
      // path that has to work when an IdP is unreachable.
      { authMethod: 'local', role: ROLES.ADMIN }
    );
    if (!session) return res.status(500).json({ error: t('auth.session-failed') });
    const cookieSubpath = authCookies?.resolveCookieSubpath(req, subpath) || '';
    authCookies?.setSessionCookies(req, res, session, cookieSubpath);
    if (configFile && fs) {
      try { fs.unlinkSync(configFile + '.initial-login-password'); } catch {}
    }
    logger.info(`[auth] Login OK (session ${session.id}: ${deviceLabel || 'unknown device'})`);
    audit(req, 'login', 'success', { sessionId: Number(session.id) });
    // The bearer token lives only in the HttpOnly cookie. Returning the same
    // value in JSON would make it readable to browser JavaScript and defeat
    // the main XSS containment property of the cookie.
    res.json({ success: true, expiresAt: session.expiresAt });
  });

  router.post('/auth/logout', requireAdmin, (req, res) => {
    if (req.session) sessions.revokeSession(req.session.id);
    const cookieSubpath = authCookies?.resolveCookieSubpath(req, subpath) || '';
    authCookies?.clearSessionCookies(req, res, cookieSubpath);
    audit(req, 'logout');
    res.json({ success: true });
  });

  router.get('/auth/sessions', requireAdmin, (req, res) => {
    const list = sessions.listSessions().map(session => ({
      ...session,
      current: req.session ? session.id === req.session.id : false,
    }));
    res.json({ sessions: list });
  });

  router.post('/auth/sessions/:id/revoke', requireAdmin, (req, res) => {
    const parsed = parseRequest(sessionIdSchema, req.params, res, { error: 'invalid id' });
    if (!parsed.ok) return;
    const { id } = parsed.data;
    if (!sessions.revokeSession(id)) return res.status(404).json({ error: 'session not found' });
    res.json({ success: true });
  });

  router.post('/auth/sessions/revoke-all', requireAdmin, (req, res) => {
    const parsed = parseRequest(revokeAllSchema, req.body, res);
    if (!parsed.ok) return;
    const keepSelf = parsed.data.includeSelf !== true && req.session;
    const revoked = sessions.revokeAll(keepSelf ? req.session.id : null);
    res.json({ success: true, revoked });
  });

  router.post('/auth/change-password', requireAdmin, (req, res) => {
    const parsed = parseRequest(changePasswordSchema, req.body, res, { error: t('auth.password-too-short') });
    if (!parsed.ok) return;
    const { currentPassword, newPassword, revokeOtherSessions } = parsed.data;
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitError = checkRateLimit(clientIp);
    if (rateLimitError) return res.status(429).json({ error: rateLimitError });
    if (!newPassword.trim()) return res.status(400).json({ error: t('auth.password-whitespace') });
    if (!verifyLocalPassword(currentPassword)) {
      recordFailure(clientIp);
      return delayedUnauthorized(res, { error: t('auth.current-wrong') });
    }
    loginAttempts.delete(clientIp);
    const previousAuth = {
      salt: appState.authPasswordSalt,
      hash: appState.authPasswordHash,
      record: appState.authPasswordRecord,
    };
    const { salt, hash, record } = authPassword.hashPassword(newPassword);
    appState.authPasswordSalt = salt;
    appState.authPasswordHash = hash;
    appState.authPasswordRecord = record;
    try {
      saveConfig();
    } catch (err) {
      appState.authPasswordSalt = previousAuth.salt;
      appState.authPasswordHash = previousAuth.hash;
      appState.authPasswordRecord = previousAuth.record;
      logger.error('[auth] Password save failed:', err.message);
      return res.status(500).json({ error: 'Password was not saved. Check server logs.' });
    }
    let revoked = 0;
    if (revokeOtherSessions === true) {
      revoked = sessions.revokeAll(req.session ? req.session.id : null);
      if (io) io.disconnectSockets(true);
    }
    logger.info(`[auth] Password changed (${revoked} other session(s) revoked)`);
    audit(req, 'password_changed', 'success', { revoked });
    res.json({ success: true, revoked });
  });

  router.post('/admin/regenerate-token', requireAdmin, (req, res) => {
    const parsed = parseRequest(currentPasswordSchema, req.body, res);
    if (!parsed.ok) return;
    const { currentPassword } = parsed.data;
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitError = checkRateLimit(clientIp);
    if (rateLimitError) return res.status(429).json({ error: rateLimitError });
    if (!verifyLocalPassword(currentPassword)) {
      recordFailure(clientIp);
      logger.warn('[auth] Token regeneration rejected (password check failed)');
      return delayedUnauthorized(res, { error: t('auth.current-wrong') });
    }
    loginAttempts.delete(clientIp);
    const newToken = crypto.randomBytes(24).toString('hex');
    const previousToken = appState.adminToken;
    appState.adminToken = newToken;
    try {
      saveConfig();
    } catch (err) {
      appState.adminToken = previousToken;
      logger.error('[auth] Admin token save failed:', err.message);
      return res.status(500).json({ error: 'Admin token was not saved. Check server logs.' });
    }
    logger.warn('[auth] Admin token regenerated; all clients must re-authenticate');
    res.json({ success: true, token: newToken });
    if (io) io.disconnectSockets(true);
  });

  router.post('/admin/verify', (req, res) => {
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitError = checkRateLimit(clientIp);
    if (rateLimitError) return res.status(429).json({ ok: false, error: rateLimitError });
    const parsed = parseRequest(tokenSchema, req.body, res, { ok: false, error: t('auth.token-invalid') });
    if (!parsed.ok) return;
    const provided = parsed.data.token;
    const adminToken = getAdminToken();
    if (!adminToken) return res.status(503).json({ ok: false, error: t('auth.not-init-verify') });
    const a = Buffer.from(provided);
    const b = Buffer.from(adminToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      loginAttempts.delete(clientIp);
      return res.json({ ok: true });
    }
    recordFailure(clientIp);
    return delayedUnauthorized(res, { ok: false, error: t('auth.token-invalid') });
  });

  return router;
};
