'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const logger = require('../logger');
const { t } = require('../i18n-server');

module.exports = function authSessionRoutes(ctx) {
  const {
    requireAdmin, getAdminToken, saveConfig,
    appState, io, sessions, authPassword,
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

  router.post('/auth/login', (req, res) => {
    const { password, deviceLabel } = req.body || {};
    if (!appState.authPasswordHash) return res.status(503).json({ error: t('auth.not-init') });
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: t('auth.enter-password') });
    }
    if (password.length > 256) return res.status(400).json({ error: t('auth.password-too-long') });
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitError = checkRateLimit(clientIp);
    if (rateLimitError) return res.status(429).json({ error: rateLimitError });
    if (!authPassword.verifyPassword(password, appState.authPasswordSalt, appState.authPasswordHash)) {
      recordFailure(clientIp);
      logger.warn('[auth] Login failed');
      return delayedUnauthorized(res, { error: t('auth.wrong-password') });
    }
    loginAttempts.delete(clientIp);
    const session = sessions.createSession(typeof deviceLabel === 'string' ? deviceLabel : '');
    if (!session) return res.status(500).json({ error: t('auth.session-failed') });
    logger.info(`[auth] Login OK (session ${session.id}: ${deviceLabel || 'unknown device'})`);
    res.json({ success: true, token: session.token, expiresAt: session.expiresAt });
  });

  router.post('/auth/logout', requireAdmin, (req, res) => {
    if (req.session) sessions.revokeSession(req.session.id);
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
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    if (!sessions.revokeSession(id)) return res.status(404).json({ error: 'session not found' });
    res.json({ success: true });
  });

  router.post('/auth/sessions/revoke-all', requireAdmin, (req, res) => {
    const keepSelf = req.body?.includeSelf !== true && req.session;
    const revoked = sessions.revokeAll(keepSelf ? req.session.id : null);
    res.json({ success: true, revoked });
  });

  router.post('/auth/change-password', requireAdmin, (req, res) => {
    const { currentPassword, newPassword, revokeOtherSessions } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 256) {
      return res.status(400).json({ error: t('auth.password-too-short') });
    }
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitError = checkRateLimit(clientIp);
    if (rateLimitError) return res.status(429).json({ error: rateLimitError });
    if (!newPassword.trim()) return res.status(400).json({ error: t('auth.password-whitespace') });
    if (!authPassword.verifyPassword(currentPassword, appState.authPasswordSalt, appState.authPasswordHash)) {
      recordFailure(clientIp);
      return delayedUnauthorized(res, { error: t('auth.current-wrong') });
    }
    loginAttempts.delete(clientIp);
    const previousAuth = { salt: appState.authPasswordSalt, hash: appState.authPasswordHash };
    const { salt, hash } = authPassword.hashPassword(newPassword);
    appState.authPasswordSalt = salt;
    appState.authPasswordHash = hash;
    try {
      saveConfig();
    } catch (err) {
      appState.authPasswordSalt = previousAuth.salt;
      appState.authPasswordHash = previousAuth.hash;
      logger.error('[auth] Password save failed:', err.message);
      return res.status(500).json({ error: 'Password was not saved. Check server logs.' });
    }
    let revoked = 0;
    if (revokeOtherSessions === true) {
      revoked = sessions.revokeAll(req.session ? req.session.id : null);
      if (io) io.disconnectSockets(true);
    }
    logger.info(`[auth] Password changed (${revoked} other session(s) revoked)`);
    res.json({ success: true, revoked });
  });

  router.post('/admin/regenerate-token', requireAdmin, (req, res) => {
    const { currentPassword } = req.body || {};
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitError = checkRateLimit(clientIp);
    if (rateLimitError) return res.status(429).json({ error: rateLimitError });
    if (!authPassword.verifyPassword(currentPassword, appState.authPasswordSalt, appState.authPasswordHash)) {
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
    const provided = req.body?.token || '';
    if (typeof provided !== 'string') {
      return res.status(400).json({ ok: false, error: t('auth.token-invalid') });
    }
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
