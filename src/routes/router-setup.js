'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const logger = require('../logger');
const { t } = require('../i18n-server');
const { isAllowedRouterIp } = require('../utils');

const optionalText = max => z.string().max(max).optional();
const nonceSchema = z.object({
  routerIp: optionalText(45),
  id: optionalText(128),
}).strict();
const yamahaDetectSchema = z.object({
  yamahaIp: optionalText(45),
  yamahaUser: optionalText(64),
  yamahaPass: optionalText(256),
  yamahaNat: z.union([z.string().regex(/^\d{1,6}$/), z.number().int().nonnegative().max(999999)]).optional(),
}).strict();
const ciscoDetectSchema = z.object({
  ciscoIp: optionalText(45),
  ciscoUser: optionalText(64),
  ciscoPass: optionalText(256),
  ciscoEnablePass: optionalText(256),
}).strict();
const routerLoginSchema = z.object({
  username: optionalText(64),
  password: optionalText(256),
  routerIp: optionalText(45),
  yamahaIp: optionalText(45),
  yamahaUser: optionalText(64),
  yamahaPass: optionalText(256),
  yamahaNat: z.union([z.string().max(6), z.number().int().nonnegative().max(999999)]).optional(),
  ciscoIp: optionalText(45),
  ciscoUser: optionalText(64),
  ciscoPass: optionalText(256),
  ciscoEnablePass: optionalText(256),
  doAsus: z.boolean().optional(),
  doYamaha: z.boolean().optional(),
  doCisco: z.boolean().optional(),
}).strict();

module.exports = function routerSetupRoutes(ctx) {
  const {
    requireAdmin, asus, yamaha, cisco, saveConfig, loadConfig,
    DEFAULT_ROUTER_IP, POLL_INTERVAL, setLatestConnections,
    startYamahaPolling, startCiscoPolling,
  } = ctx;
  const router = Router();

  function restoreYamaha(previous) {
    yamaha.disconnect();
    yamaha.configure(previous);
    if (previous.enabled) {
      yamaha.reconnect();
      startYamahaPolling?.();
    }
  }

  function restoreCisco(previous) {
    cisco.disconnect();
    cisco.configure(previous);
    if (previous.enabled) {
      cisco.reconnect();
      startCiscoPolling?.();
    }
  }

  async function restoreAsus(previous) {
    asus.disable();
    asus.configure?.({
      routerIp: previous.ip,
      user: previous.user,
      pass: previous.pass,
      enabled: previous.enabled,
    });
    if (previous.enabled && previous.user && previous.pass) {
      await asus.login(previous.ip, previous.user, previous.pass);
      asus.startPolling(POLL_INTERVAL);
    }
  }

  router.post('/nonce', requireAdmin, async (req, res) => {
    const parsed = parseRequest(nonceSchema, req.body, res);
    if (!parsed.ok) return;
    const ip = parsed.data.routerIp || DEFAULT_ROUTER_IP;
    if (!isAllowedRouterIp(ip)) return res.status(400).json({ error: t('auth.ip-not-allowed') });
    try {
      const id = parsed.data.id || crypto.randomBytes(5).toString('hex');
      const response = await axios.post(`http://${ip}/get_Nonce.cgi`, JSON.stringify({ id }), {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      res.json({ nonce: response.data?.nonce || '', id });
    } catch {
      res.status(502).json({ error: t('auth.request-failed') });
    }
  });

  router.post('/yamaha/detect', requireAdmin, async (req, res) => {
    const parsed = parseRequest(yamahaDetectSchema, req.body, res);
    if (!parsed.ok) return;
    const { yamahaIp: ipInput, yamahaUser: userInput, yamahaPass: passInput, yamahaNat } = parsed.data;
    if (ipInput !== undefined && ipInput !== '' && !isAllowedRouterIp(ipInput)) {
      return res.status(400).json({ code: 'routerIpPrivate', error: t('auth.yamaha-ip-private') });
    }
    let stored = {};
    try { stored = loadConfig().yamaha || {}; } catch {}
    const ip = ipInput || yamaha.getIp() || stored.ip || '';
    const user = userInput || yamaha.getUser() || stored.user || '';
    const pass = passInput || stored.pass || '';
    const natCandidates = [yamahaNat, yamaha.getNat(), stored.nat].filter(Boolean);
    if (!ip || !user || !pass) return res.status(400).json({ code: 'yamahaDetectMissing', error: t('yamaha.no-config') });
    try {
      const sameRouter = yamaha.isReady() && ip === yamaha.getIp() && user === yamaha.getUser();
      const result = sameRouter
        ? await yamaha.detectCurrentYamaha({ natCandidates })
        : await yamaha.detectYamaha({
            ip, user, pass,
            expectedHostFp: yamaha.getHostFp() || stored.hostFp || '',
            natCandidates,
          });
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error('[auth] Yamaha auto-detect failed:', err.message);
      res.status(502).json({ success: false, code: 'yamahaDetectFailed', error: t('auth.yamaha-detect-failed'), diag: err.diag || null });
    }
  });

  router.post('/cisco/detect', requireAdmin, async (req, res) => {
    const parsed = parseRequest(ciscoDetectSchema, req.body, res);
    if (!parsed.ok) return;
    const { ciscoIp: ipInput, ciscoUser: userInput, ciscoPass: passInput, ciscoEnablePass } = parsed.data;
    if (ipInput !== undefined && ipInput !== '' && !isAllowedRouterIp(ipInput)) {
      return res.status(400).json({ code: 'routerIpPrivate', error: t('auth.yamaha-ip-private') });
    }
    let stored = {};
    try { stored = loadConfig().cisco || {}; } catch {}
    const ip = ipInput || cisco.getIp() || stored.ip || '';
    const user = userInput || cisco.getUser() || stored.user || '';
    const pass = passInput || stored.pass || '';
    if (!ip || !user || !pass) return res.status(400).json({ code: 'ciscoDetectMissing', error: t('cisco.no-config') });
    try {
      const sameRouter = cisco.isReady() && ip === cisco.getIp() && user === cisco.getUser();
      const result = sameRouter
        ? await cisco.detectCurrent()
        : await cisco.detect({
            ip, user, pass,
            enablePass: ciscoEnablePass || stored.enablePass || '',
            expectedHostFp: cisco.getHostFp() || stored.hostFp || '',
          });
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error('[auth] Cisco auto-detect failed:', err.message);
      res.status(502).json({ success: false, code: 'ciscoDetectFailed', error: t('cisco.no-config'), diag: err.diag || null });
    }
  });

  router.post('/login', requireAdmin, async (req, res) => {
    const parsed = parseRequest(routerLoginSchema, req.body, res);
    if (!parsed.ok) return;
    const {
      username, password, routerIp,
      yamahaIp, yamahaUser, yamahaPass, yamahaNat,
      ciscoIp, ciscoUser, ciscoPass, ciscoEnablePass,
      doAsus, doYamaha, doCisco,
    } = parsed.data;

    if (doAsus === undefined && doYamaha === undefined && doCisco === undefined) {
      return res.status(400).json({ error: t('auth.no-target') });
    }
    if (routerIp !== undefined && routerIp !== '' && !isAllowedRouterIp(routerIp)) return res.status(400).json({ error: t('auth.asus-ip-private') });
    if (yamahaIp !== undefined && yamahaIp !== '' && !isAllowedRouterIp(yamahaIp)) return res.status(400).json({ error: t('auth.yamaha-ip-private') });
    if (ciscoIp !== undefined && ciscoIp !== '' && !isAllowedRouterIp(ciscoIp)) return res.status(400).json({ error: t('auth.yamaha-ip-private') });
    if (yamahaNat !== undefined && yamahaNat !== '' && !/^\d{1,6}$/.test(String(yamahaNat))) {
      return res.status(400).json({ error: t('auth.yamaha-nat-invalid') });
    }

    let config = {};
    try { config = loadConfig(); } catch {}

    if (doAsus === true) {
      const storedPass = config.asus?.pass || '';
      const finalPass = password || storedPass;
      if (!username || !finalPass) return res.status(400).json({ error: t('auth.asus-no-config') });
      const previous = {
        enabled: asus.isEnabled?.() ?? false,
        ip: asus.getRouterIp(),
        user: asus.getUser(),
        pass: storedPass,
      };
      try {
        const targetIp = routerIp || DEFAULT_ROUTER_IP;
        await asus.login(targetIp, username, finalPass);
        asus.startPolling(POLL_INTERVAL);
        try {
          saveConfig({ asus: { ip: targetIp, user: username, pass: finalPass } });
        } catch (saveErr) {
          try { await restoreAsus(previous); } catch (rollbackErr) {
            logger.error('[auth] ASUS runtime rollback failed:', rollbackErr.message);
          }
          logger.error('[auth] ASUS config save failed:', saveErr.message);
          return res.status(500).json({ success: false, error: 'Settings were not saved. Check server logs.' });
        }
        logger.info(`[auth] ASUS logged in as ${username} @ ${targetIp}`);
      } catch (err) {
        logger.error('[auth] ASUS login failed:', err.message);
        return res.status(401).json({ error: t('auth.asus-auth-failed') });
      }
    } else if (doAsus === false) {
      try {
        saveConfig({ asus: { enabled: false } });
      } catch (err) {
        logger.error('[auth] ASUS disable save failed:', err.message);
        return res.status(500).json({ success: false, error: 'Settings were not saved. Check server logs.' });
      }
      asus.disable();
      logger.info('[auth] ASUS disabled');
    }

    if (doYamaha === true) {
      const stored = config.yamaha || {};
      const previous = {
        enabled: yamaha.isEnabled?.() ?? false,
        ip: yamaha.getIp(), user: yamaha.getUser(), pass: stored.pass || '',
        hostFp: yamaha.getHostFp(), natDescriptor: yamaha.getNat(),
      };
      try {
        const finalIp = yamahaIp || yamaha.getIp() || stored.ip || '';
        const finalUser = yamahaUser || yamaha.getUser() || stored.user || '';
        if (!finalIp || !finalUser || !(yamahaPass || yamaha.hasPass() || stored.pass)) {
          return res.status(400).json({ error: t('yamaha.no-config') });
        }
        yamaha.configure({ enabled: true, ip: finalIp, user: finalUser, natDescriptor: yamahaNat || undefined });
        if (yamahaPass) yamaha.configure({ pass: yamahaPass });
        yamaha.reconnect();
        startYamahaPolling?.();
        try {
          saveConfig(yamahaPass ? {
            yamaha: { ip: finalIp, user: finalUser, pass: yamahaPass, nat: yamahaNat || '100', enabled: true },
          } : {});
        } catch (saveErr) {
          restoreYamaha(previous);
          logger.error('[auth] Yamaha config save failed:', saveErr.message);
          return res.status(500).json({ success: false, error: 'Settings were not saved. Check server logs.' });
        }
        logger.info(`[auth] Yamaha config updated: ${yamaha.getIp()}`);
      } catch (err) {
        logger.error('[auth] Yamaha config failed:', err.message);
        return res.status(502).json({ success: false, error: t('auth.yamaha-update-failed') });
      }
    } else if (doYamaha === false) {
      try {
        saveConfig({ yamaha: { enabled: false } });
      } catch (err) {
        logger.error('[auth] Yamaha disable save failed:', err.message);
        return res.status(500).json({ success: false, error: 'Settings were not saved. Check server logs.' });
      }
      yamaha.disconnect();
      setLatestConnections([]);
      logger.info('[auth] Yamaha disabled');
    }

    if (doCisco === true) {
      const stored = config.cisco || {};
      const previous = {
        enabled: cisco.isEnabled?.() ?? false,
        ip: cisco.getIp(), user: cisco.getUser(), pass: stored.pass || '',
        enablePass: stored.enablePass || '', hostFp: cisco.getHostFp(),
      };
      try {
        const finalIp = ciscoIp || cisco.getIp() || stored.ip || '';
        const finalUser = ciscoUser || cisco.getUser() || stored.user || '';
        if (!finalIp || !finalUser || !(ciscoPass || cisco.hasPass() || stored.pass)) {
          return res.status(400).json({ error: t('cisco.no-config') });
        }
        cisco.configure({ enabled: true, ip: finalIp, user: finalUser });
        if (typeof ciscoEnablePass === 'string') cisco.configure({ enablePass: ciscoEnablePass });
        if (ciscoPass) cisco.configure({ pass: ciscoPass });
        cisco.reconnect();
        startCiscoPolling?.();
        const overrides = {};
        if (ciscoPass) {
          Object.assign(overrides, {
            ip: finalIp, user: finalUser, pass: ciscoPass,
            enablePass: ciscoEnablePass ?? stored.enablePass ?? '', enabled: true,
          });
        } else if (typeof ciscoEnablePass === 'string') {
          overrides.enablePass = ciscoEnablePass;
        }
        try {
          saveConfig(Object.keys(overrides).length ? { cisco: overrides } : {});
        } catch (saveErr) {
          restoreCisco(previous);
          logger.error('[auth] Cisco config save failed:', saveErr.message);
          return res.status(500).json({ success: false, error: 'Settings were not saved. Check server logs.' });
        }
        logger.info(`[auth] Cisco config updated: ${cisco.getIp()}`);
      } catch (err) {
        logger.error('[auth] Cisco config failed:', err.message);
        return res.status(502).json({ success: false, error: t('cisco.init-failed') + err.message });
      }
    } else if (doCisco === false) {
      try {
        saveConfig({ cisco: { enabled: false } });
      } catch (err) {
        logger.error('[auth] Cisco disable save failed:', err.message);
        return res.status(500).json({ success: false, error: 'Settings were not saved. Check server logs.' });
      }
      cisco.disconnect();
      logger.info('[auth] Cisco disabled');
    }

    res.json({ success: true, routerIp: doAsus ? asus.getRouterIp() : undefined });
  });

  return router;
};
