// Routes: admin token verification, ASUS nonce, router login/setup
'use strict';
const logger = require('../logger');

const { Router } = require('express');
const crypto = require('crypto');
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
  } = ctx;

  const router = Router();

  // ── Verify admin token (used by login UI) ──────────────────────────────────
  router.post('/admin/verify', (req, res) => {
    const provided   = (req.body && req.body.token) || '';
    const adminToken = getAdminToken();
    if (!adminToken) return res.status(503).json({ ok: false, error: '未初期化' });
    const a = Buffer.from(provided);
    const b = Buffer.from(adminToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return res.json({ ok: true });
    }
    setTimeout(() => res.status(401).json({ ok: false, error: 'トークン不正' }), 500);
  });

  // ── ASUS nonce proxy ────────────────────────────────────────────────────────
  router.post('/nonce', requireAdmin, async (req, res) => {
    const axios = require('axios');
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

  // ── Login / setup ───────────────────────────────────────────────────────────
  router.post('/login', requireAdmin, async (req, res) => {
    const { username, password,
            routerIp: ip,
            yamahaIp: yIp, yamahaUser: yUser, yamahaPass: yPass, yamahaNat: yNat,
            doAsus, doYamaha } = req.body;

    if (doAsus === undefined && doYamaha === undefined) {
      return res.status(400).json({ error: '設定対象を指定してください' });
    }
    if (ip   !== undefined && ip   !== '' && !isAllowedRouterIp(ip))  return res.status(400).json({ error: 'ASUSのIPがプライベート範囲外です' });
    if (yIp  !== undefined && yIp  !== '' && !isAllowedRouterIp(yIp)) return res.status(400).json({ error: 'YamahaのIPがプライベート範囲外です' });
    if (typeof username === 'string' && username.length > 64)         return res.status(400).json({ error: 'ユーザー名が長すぎます' });
    if (typeof password === 'string' && password.length > 256)        return res.status(400).json({ error: 'パスワードが長すぎます' }); // pragma: allowlist secret

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
      yamaha.configure({ enabled: true, ip: yIp || yamaha.getIp(), user: yUser || yamaha.getUser(), natDescriptor: yNat || undefined });
      if (yPass) {
        persistSecret('yamaha', { ip: yIp || yamaha.getIp(), user: yUser || yamaha.getUser(), pass: yPass, nat: yNat || '100', enabled: true });
        yamaha.configure({ pass: yPass });
      }
      yamaha.reconnect();
      saveConfig();
      logger.info(`[auth] Yamaha config updated: ${yamaha.getIp()}`);
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
