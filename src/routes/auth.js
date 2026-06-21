// Routes: admin token verification, ASUS nonce, router login/setup
'use strict';
const logger = require('../logger');

const { Router } = require('express');
const crypto = require('crypto');
const axios  = require('axios');
const { isAllowedRouterIp } = require('../utils');

/**
 * @param {{
 *   requireAdmin, getAdminToken: () => string,
 *   asus, yamaha,
 *   saveConfig: () => void,
 *   persistSecret: (section: string, updates: object) => void,
 *   configFile: string,
 *   fs, DEFAULT_ROUTER_IP: string, POLL_INTERVAL: number,
 *   setLatestConnections: (arr: any[]) => void
 * }} ctx
 */
module.exports = function authRoutes(ctx) {
  const {
    requireAdmin, getAdminToken,
    asus, yamaha,
    saveConfig, persistSecret,
    configFile, fs,
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
      return `試行回数が多すぎます。${secsLeft}秒後に再試行してください`;
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
    if (!appState.authPasswordHash) return res.status(503).json({ error: '認証未初期化' });
    if (typeof password !== 'string' || password.length > 256) {
      return res.status(400).json({ error: 'パスワードを入力してください' });
    }
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitErr = checkLoginRateLimit(clientIp);
    if (rateLimitErr) return res.status(429).json({ error: rateLimitErr });

    const ok = authPassword.verifyPassword(password, appState.authPasswordSalt, appState.authPasswordHash);
    if (!ok) {
      recordLoginFail(clientIp);
      logger.warn('[auth] Login failed');
      return setTimeout(() => res.status(401).json({ error: 'パスワードが違います' }), 500);
    }
    clearLoginFails(clientIp);
    const session = sessions.createSession(typeof deviceLabel === 'string' ? deviceLabel : '');
    if (!session) return res.status(500).json({ error: 'セッション作成に失敗しました' });
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
      return res.status(400).json({ error: '新しいパスワードは8文字以上で指定してください' });
    }
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const rateLimitErr = checkPasswordRateLimit(clientIp);
    if (rateLimitErr) return res.status(429).json({ error: rateLimitErr });
    const ok = authPassword.verifyPassword(currentPassword, appState.authPasswordSalt, appState.authPasswordHash);
    if (!ok) {
      recordPasswordFail(clientIp);
      return setTimeout(() => res.status(401).json({ error: '現在のパスワードが違います' }), 500);
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
      return setTimeout(() => res.status(401).json({ error: '現在のパスワードが違います' }), 500);
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
    if (!adminToken) return res.status(503).json({ ok: false, error: '未初期化' });
    const a = Buffer.from(provided);
    const b = Buffer.from(adminToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      clearLoginFails(clientIp);
      return res.json({ ok: true });
    }
    recordLoginFail(clientIp);
    setTimeout(() => res.status(401).json({ ok: false, error: 'トークン不正' }), 500);
  });

  // ── ASUS nonce proxy ────────────────────────────────────────────────────────
  router.post('/nonce', requireAdmin, async (req, res) => {
    const ip = req.body.routerIp || DEFAULT_ROUTER_IP;
    if (!isAllowedRouterIp(ip)) {
      return res.status(400).json({ error: 'IPアドレスはプライベート範囲(10/8, 172.16/12, 192.168/16)のみ許可されます' });
    }
    try {
      const id = req.body.id || crypto.randomBytes(5).toString('hex');
      const r = await axios.post(`http://${ip}/get_Nonce.cgi`, JSON.stringify({ id }), {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      res.json({ nonce: r.data?.nonce || '', id });
    } catch {
      res.status(502).json({ error: 'リクエスト失敗' });
    }
  });

  // ── Yamaha read-only auto-detection ────────────────────────────────────────
  router.post('/yamaha/detect', requireAdmin, async (req, res) => {
    const { yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass, yamahaNat: yNat } = req.body || {};
    if (yIp !== undefined && yIp !== '' && !isAllowedRouterIp(yIp)) {
      return res.status(400).json({ code: 'routerIpPrivate', error: 'YamahaのIPがプライベート範囲外です' });
    }
    if (typeof yUser === 'string' && yUser.length > 64) return res.status(400).json({ error: 'ユーザー名が長すぎます' });
    if (typeof yPass === 'string' && yPass.length > 256) return res.status(400).json({ error: 'パスワードが長すぎます' }); // pragma: allowlist secret

    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(configFile, 'utf8')).yamaha || {}; } catch {}
    const ip = yIp || yamaha.getIp() || stored.ip || '';
    const user = yUser || yamaha.getUser() || stored.user || '';
    const pass = yPass || stored.pass || '';
    const natCandidates = [yNat, yamaha.getNat(), stored.nat].filter(Boolean);
    if (!ip || !user || !pass) {
      return res.status(400).json({ code: 'yamahaDetectMissing', error: 'YamahaのIP、ユーザー名、パスワードを入力してください' });
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
      res.status(502).json({ success: false, code: 'yamahaDetectFailed', error: 'Yamaha自動検出に失敗しました（IP・ユーザー名・パスワード・SSH設定を確認してください）' });
    }
  });

  // ── Login / setup ───────────────────────────────────────────────────────────
  router.post('/login', requireAdmin, async (req, res) => {
    const { username, password,
            routerIp: ip,
            yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass, yamahaNat: yNat,
            doAsus, doYamaha } = req.body || {};

    if (doAsus === undefined && doYamaha === undefined) {
      return res.status(400).json({ error: '設定対象を指定してください' });
    }
    if (ip   !== undefined && ip   !== '' && !isAllowedRouterIp(ip))  return res.status(400).json({ error: 'ASUSのIPがプライベート範囲外です' });
    if (yIp  !== undefined && yIp  !== '' && !isAllowedRouterIp(yIp)) return res.status(400).json({ error: 'YamahaのIPがプライベート範囲外です' });
    if (typeof username === 'string' && username.length > 64)         return res.status(400).json({ error: 'ユーザー名が長すぎます' });
    if (typeof password === 'string' && password.length > 256)        return res.status(400).json({ error: 'パスワードが長すぎます' }); // pragma: allowlist secret
    if (yNat !== undefined && yNat !== '' && !/^\d{1,6}$/.test(String(yNat))) return res.status(400).json({ error: 'yamahaNat は1〜6桁の数値で指定してください' });

    // ── ASUS ──
    if (doAsus === true) {
      let storedPass = '';
      try { storedPass = JSON.parse(fs.readFileSync(configFile, 'utf8')).asus?.pass || ''; } catch {}
      const finalPass = password || storedPass;
      if (!username || !finalPass) return res.status(400).json({ error: 'ASUSルーターのユーザー名とパスワードを入力してください' });
      try {
        const targetIp = ip || DEFAULT_ROUTER_IP;
        await asus.login(targetIp, username, finalPass);
        asus.startPolling(POLL_INTERVAL);
        saveConfig();
        persistSecret('asus', { ip: targetIp, user: username, pass: finalPass });
        logger.info(`[auth] ASUS logged in as ${username} @ ${targetIp}`);
      } catch (err) {
        logger.error('[auth] ASUS login failed:', err.message);
        return res.status(401).json({ error: 'ASUS認証失敗（IP・ユーザー名・パスワードを確認してください）' });
      }
    } else if (doAsus === false) {
      asus.disable();
      saveConfig();
      logger.info('[auth] ASUS disabled');
    }

    // ── Yamaha ──
    if (doYamaha === true) {
      try {
        yamaha.configure({ enabled: true, ip: yIp || yamaha.getIp(), user: yUser || yamaha.getUser(), natDescriptor: yNat || undefined });
        if (yPass) {
          persistSecret('yamaha', { ip: yIp || yamaha.getIp(), user: yUser || yamaha.getUser(), pass: yPass, nat: yNat || '100', enabled: true });
          yamaha.configure({ pass: yPass });
        }
        yamaha.reconnect();
        saveConfig();
        logger.info(`[auth] Yamaha config updated: ${yamaha.getIp()}`);
      } catch (err) {
        logger.error('[auth] Yamaha config failed:', err.message);
        return res.status(502).json({ success: false, error: 'Yamaha設定の更新に失敗しました' });
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
