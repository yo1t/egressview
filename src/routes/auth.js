// Routes: admin token verification, ASUS nonce, router login/setup
'use strict';
const logger = require('../logger');

const { Router } = require('express');
const crypto = require('crypto');
const axios  = require('axios');
const { isAllowedRouterIp } = require('../utils');
const { t } = require('../i18n-server');

/**
 * @param {{
 *   requireAdmin, getAdminToken: () => string,
 *   asus, yamaha,
 *   saveConfig: () => void,
 *   persistSecret: (section: string, updates: object) => void,
 *   configFile: string,
 *   loadConfig: () => object,
 *   DEFAULT_ROUTER_IP: string, POLL_INTERVAL: number,
 *   setLatestConnections: (arr: any[]) => void
 * }} ctx
 */
module.exports = function authRoutes(ctx) {
  const {
    requireAdmin, getAdminToken,
    asus, yamaha,
    saveConfig, persistSecret, loadConfig,
    DEFAULT_ROUTER_IP, POLL_INTERVAL,
    setLatestConnections,
    appState, io,
    sessions, authPassword,
  } = ctx;

  const router = Router();

  // ── Brute-force guard for /auth/login ─────────────────────────────────────
  // Tracks failed attempts per IP: { count, lockedUntil }
  const loginAttempts = new Map();
  const LOGIN_MAX_FAILS  = 5;
  const LOGIN_LOCK_MS    = 5 * 60_000;  // 5 minutes
  const LOGIN_WINDOW_MS  = 10 * 60_000;

  function checkLoginRateLimit(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry) return null;
    if (entry.lockedUntil && now < entry.lockedUntil) {
      const secsLeft = Math.ceil((entry.lockedUntil - now) / 1000);
      return t('auth.rate-limited', { n: secsLeft });
    }
    if (now - entry.firstFail > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
      return null;
    }
    return null;
  }

  function recordLoginFail(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, firstFail: now };
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_FAILS) entry.lockedUntil = now + LOGIN_LOCK_MS;
    loginAttempts.set(ip, entry);
  }

  function clearLoginFails(ip) { loginAttempts.delete(ip); }

  // Reuse the same guard for endpoints that also verify the admin password
  function checkPasswordRateLimit(ip) { return checkLoginRateLimit(ip); }
  function recordPasswordFail(ip)     { recordLoginFail(ip); }
  function clearPasswordFails(ip)     { clearLoginFails(ip); }

  // ── Password login → per-device session (P2-23) ────────────────────────────
  router.post('/auth/login', (req, res) => {
    const { password, deviceLabel } = req.body || {};
    if (!appState.authPasswordHash) return res.status(503).json({ error: t('auth.not-init') });
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: t('auth.enter-password') });
    }
    if (password.length > 256) {
      return res.status(400).json({ error: t('auth.password-too-long') });
    }
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitErr = checkLoginRateLimit(clientIp);
    if (rateLimitErr) return res.status(429).json({ error: rateLimitErr });

    const ok = authPassword.verifyPassword(password, appState.authPasswordSalt, appState.authPasswordHash);
    if (!ok) {
      recordLoginFail(clientIp);
      logger.warn('[auth] Login failed');
      return setTimeout(() => res.status(401).json({ error: t('auth.wrong-password') }), 500);
    }
    clearLoginFails(clientIp);
    const session = sessions.createSession(typeof deviceLabel === 'string' ? deviceLabel : '');
    if (!session) return res.status(500).json({ error: t('auth.session-failed') });
    logger.info(`[auth] Login OK (session ${session.id}: ${deviceLabel || 'unknown device'})`);
    res.json({ success: true, token: session.token, expiresAt: session.expiresAt });
  });

  // ── Logout (revoke own session) ─────────────────────────────────────────────
  router.post('/auth/logout', requireAdmin, (req, res) => {
    if (req.session) sessions.revokeSession(req.session.id);
    res.json({ success: true });
  });

  // ── Session management ──────────────────────────────────────────────────────
  router.get('/auth/sessions', requireAdmin, (req, res) => {
    const list = sessions.listSessions().map(s => ({
      ...s,
      current: req.session ? s.id === req.session.id : false,
    }));
    res.json({ sessions: list });
  });

  router.post('/auth/sessions/:id/revoke', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    const ok = sessions.revokeSession(id);
    if (!ok) return res.status(404).json({ error: 'session not found' });
    res.json({ success: true });
  });

  router.post('/auth/sessions/revoke-all', requireAdmin, (req, res) => {
    // Keep the caller's own session unless they explicitly ask to drop it too
    const keepSelf = req.body?.includeSelf !== true && req.session;
    const revoked  = sessions.revokeAll(keepSelf ? req.session.id : null);
    res.json({ success: true, revoked });
  });

  // ── Change password ─────────────────────────────────────────────────────────
  router.post('/auth/change-password', requireAdmin, (req, res) => {
    const { currentPassword, newPassword, revokeOtherSessions } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 256) {
      return res.status(400).json({ error: t('auth.password-too-short') });
    }
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitErr = checkPasswordRateLimit(clientIp);
    if (rateLimitErr) return res.status(429).json({ error: rateLimitErr });
    if (!newPassword.trim()) {
      return res.status(400).json({ error: t('auth.password-whitespace') });
    }
    const ok = authPassword.verifyPassword(currentPassword, appState.authPasswordSalt, appState.authPasswordHash);
    if (!ok) {
      recordPasswordFail(clientIp);
      return setTimeout(() => res.status(401).json({ error: t('auth.current-wrong') }), 500);
    }
    clearPasswordFails(clientIp);
    const { salt, hash } = authPassword.hashPassword(newPassword);
    appState.authPasswordSalt = salt;
    appState.authPasswordHash = hash;
    saveConfig();
    let revoked = 0;
    if (revokeOtherSessions === true) {
      revoked = sessions.revokeAll(req.session ? req.session.id : null);
      if (io) io.disconnectSockets(true);
    }
    logger.info(`[auth] Password changed (${revoked} other session(s) revoked)`);
    res.json({ success: true, revoked });
  });

  // ── Regenerate admin token ──────────────────────────────────────────────────
  // Invalidates the current token immediately: the config is persisted and all
  // connected WebSocket clients are disconnected so they must re-authenticate.
  // The new token is returned ONCE in this response — the caller must store it.
  router.post('/admin/regenerate-token', requireAdmin, (req, res) => {
    // Minting a durable credential requires the password, not just a session:
    // a stolen session token must not survive session revocation by minting
    // itself a new API token (same re-auth rule as change-password).
    const { currentPassword } = req.body || {};
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitErr = checkPasswordRateLimit(clientIp);
    if (rateLimitErr) return res.status(429).json({ error: rateLimitErr });
    const ok = authPassword.verifyPassword(currentPassword, appState.authPasswordSalt, appState.authPasswordHash);
    if (!ok) {
      recordPasswordFail(clientIp);
      logger.warn('[auth] Token regeneration rejected (password check failed)');
      return setTimeout(() => res.status(401).json({ error: t('auth.current-wrong') }), 500);
    }
    clearPasswordFails(clientIp);
    const newToken = crypto.randomBytes(24).toString('hex');
    appState.adminToken = newToken;
    saveConfig();
    logger.warn('[auth] Admin token regenerated; all clients must re-authenticate');
    res.json({ success: true, token: newToken });
    // After the response: drop every socket so stale legacy tokens stop working now
    if (io) io.disconnectSockets(true);
  });

  // ── Verify admin token (used by login UI) ──────────────────────────────────
  router.post('/admin/verify', (req, res) => {
    const clientIp   = req.ip || req.socket?.remoteAddress || '';
    const rateLimitErr = checkLoginRateLimit(clientIp);
    if (rateLimitErr) return res.status(429).json({ ok: false, error: rateLimitErr });

    const provided   = (req.body && req.body.token) || '';
    const adminToken = getAdminToken();
    if (!adminToken) return res.status(503).json({ ok: false, error: t('auth.not-init-verify') });
    const a = Buffer.from(provided);
    const b = Buffer.from(adminToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      clearLoginFails(clientIp);
      return res.json({ ok: true });
    }
    recordLoginFail(clientIp);
    setTimeout(() => res.status(401).json({ ok: false, error: t('auth.token-invalid') }), 500);
  });

  // ── ASUS nonce proxy ────────────────────────────────────────────────────────
  router.post('/nonce', requireAdmin, async (req, res) => {
    const ip = req.body.routerIp || DEFAULT_ROUTER_IP;
    if (!isAllowedRouterIp(ip)) {
      return res.status(400).json({ error: t('auth.ip-not-allowed') });
    }
    try {
      const id = req.body.id || crypto.randomBytes(5).toString('hex');
      const r = await axios.post(`http://${ip}/get_Nonce.cgi`, JSON.stringify({ id }), {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      res.json({ nonce: r.data?.nonce || '', id });
    } catch {
      res.status(502).json({ error: t('auth.request-failed') });
    }
  });

  // ── Yamaha read-only auto-detection ────────────────────────────────────────
  router.post('/yamaha/detect', requireAdmin, async (req, res) => {
    const { yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass, yamahaNat: yNat } = req.body || {};
    if (yIp !== undefined && yIp !== '' && !isAllowedRouterIp(yIp)) {
      return res.status(400).json({ code: 'routerIpPrivate', error: t('auth.yamaha-ip-private') });
    }
    if (typeof yUser === 'string' && yUser.length > 64) return res.status(400).json({ error: t('auth.username-too-long') });
    if (typeof yPass === 'string' && yPass.length > 256) return res.status(400).json({ error: t('auth.password-too-long') }); // pragma: allowlist secret

    let stored = {};
    try { stored = loadConfig().yamaha || {}; } catch {}
    const ip = yIp || yamaha.getIp() || stored.ip || '';
    const user = yUser || yamaha.getUser() || stored.user || '';
    const pass = yPass || stored.pass || '';
    const natCandidates = [yNat, yamaha.getNat(), stored.nat].filter(Boolean);
    if (!ip || !user || !pass) {
      return res.status(400).json({ code: 'yamahaDetectMissing', error: t('yamaha.no-config') });
    }

    try {
      const sameConfiguredRouter = yamaha.isReady() && ip === yamaha.getIp() && user === yamaha.getUser();
      const result = sameConfiguredRouter
        ? await yamaha.detectCurrentYamaha({ natCandidates })
        : await yamaha.detectYamaha({
            ip,
            user,
            pass,
            expectedHostFp: yamaha.getHostFp() || stored.hostFp || '',
            natCandidates,
          });
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error('[auth] Yamaha auto-detect failed:', err.message);
      res.status(502).json({ success: false, code: 'yamahaDetectFailed', error: t('auth.yamaha-detect-failed') });
    }
  });

  // ── Login / setup ───────────────────────────────────────────────────────────
  router.post('/login', requireAdmin, async (req, res) => {
    const { username, password,
            routerIp: ip,
            yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass, yamahaNat: yNat,
            doAsus, doYamaha } = req.body || {};

    if (doAsus === undefined && doYamaha === undefined) {
      return res.status(400).json({ error: t('auth.no-target') });
    }
    if (ip   !== undefined && ip   !== '' && !isAllowedRouterIp(ip))  return res.status(400).json({ error: t('auth.asus-ip-private') });
    if (yIp  !== undefined && yIp  !== '' && !isAllowedRouterIp(yIp)) return res.status(400).json({ error: t('auth.yamaha-ip-private') });
    if (typeof username === 'string' && username.length > 64)         return res.status(400).json({ error: t('auth.username-too-long') });
    if (typeof password === 'string' && password.length > 256)        return res.status(400).json({ error: t('auth.password-too-long') }); // pragma: allowlist secret
    if (yNat !== undefined && yNat !== '' && !/^\d{1,6}$/.test(String(yNat))) return res.status(400).json({ error: t('auth.yamaha-nat-invalid') });

    let cfg = {};
    try { cfg = loadConfig(); } catch {}

    // ── ASUS ──
    if (doAsus === true) {
      const storedPass = cfg.asus?.pass || '';
      const finalPass = password || storedPass;
      if (!username || !finalPass) return res.status(400).json({ error: t('auth.asus-no-config') });
      try {
        const targetIp = ip || DEFAULT_ROUTER_IP;
        await asus.login(targetIp, username, finalPass);
        asus.startPolling(POLL_INTERVAL);
        saveConfig();
        persistSecret('asus', { ip: targetIp, user: username, pass: finalPass });
        logger.info(`[auth] ASUS logged in as ${username} @ ${targetIp}`);
      } catch (err) {
        logger.error('[auth] ASUS login failed:', err.message);
        return res.status(401).json({ error: t('auth.asus-auth-failed') });
      }
    } else if (doAsus === false) {
      asus.disable();
      saveConfig();
      logger.info('[auth] ASUS disabled');
    }

    // ── Yamaha ──
    if (doYamaha === true) {
      try {
        const storedYamaha = cfg.yamaha;
        const finalYamahaIp = yIp || yamaha.getIp() || storedYamaha?.ip || '';
        const finalYamahaUser = yUser || yamaha.getUser() || storedYamaha?.user || '';
        const hasYamahaPass = !!yPass || yamaha.hasPass() || !!(storedYamaha?.pass);
        if (!finalYamahaIp || !finalYamahaUser || !hasYamahaPass) {
          return res.status(400).json({ error: t('yamaha.no-config') });
        }

        yamaha.configure({ enabled: true, ip: finalYamahaIp, user: finalYamahaUser, natDescriptor: yNat || undefined });
        if (yPass) {
          persistSecret('yamaha', { ip: finalYamahaIp, user: finalYamahaUser, pass: yPass, nat: yNat || '100', enabled: true });
          yamaha.configure({ pass: yPass });
        }
        yamaha.reconnect();
        saveConfig();
        logger.info(`[auth] Yamaha config updated: ${yamaha.getIp()}`);
      } catch (err) {
        logger.error('[auth] Yamaha config failed:', err.message);
        return res.status(502).json({ success: false, error: t('auth.yamaha-update-failed') });
      }
    } else if (doYamaha === false) {
      yamaha.disconnect();
      setLatestConnections([]);
      saveConfig();
      logger.info('[auth] Yamaha disabled');
    }

    res.json({ success: true, routerIp: doAsus ? asus.getRouterIp() : undefined });
  });

  return router;
};
