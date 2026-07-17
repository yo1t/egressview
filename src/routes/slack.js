// Routes: Slack notification configuration
'use strict';

const { Router } = require('express');
const logger = require('../logger');

/**
 * @param {{
 *   requireAdmin, notifier,
 *   saveConfig,
 *   loadConfig: () => object
 * }} ctx
 */
module.exports = function slackRoutes(ctx) {
  const { requireAdmin, notifier, saveConfig, loadConfig } = ctx;
  const router = Router();

  router.get('/config/slack', requireAdmin, (req, res) => {
    const cfg = notifier.getConfig();
    let displayName = '';
    try { displayName = loadConfig().slack?.displayName || ''; } catch {}
    res.json({ config: { ...cfg, displayName } });
  });

  router.post('/config/slack', requireAdmin, (req, res) => {
    const { enabled, token, userId, cooldownMinutes, displayName } = req.body || {};
    if (typeof token       === 'string' && token.length       > 512) return res.status(400).json({ error: 'token too long' });
    if (typeof userId      === 'string' && userId.length      > 256) return res.status(400).json({ error: 'userId too long' });
    if (typeof displayName === 'string' && displayName.length > 256) return res.status(400).json({ error: 'displayName too long' });
    const previous = notifier.getConfig();
    let previousStored = {};
    try { previousStored = loadConfig().slack || {}; } catch {}
    notifier.configure({
      enabled:          typeof enabled         === 'boolean' ? enabled         : undefined,
      token:            typeof token           === 'string' && token ? token   : undefined,
      userId:           typeof userId          === 'string' ? userId           : undefined,
      cooldownMinutes:  typeof cooldownMinutes === 'number' ? cooldownMinutes  : undefined,
    });
    const slackUpdates = {};
    if (typeof token       === 'string' && token)       slackUpdates.token       = token;
    if (typeof displayName === 'string')                slackUpdates.displayName = displayName;
    try {
      saveConfig(Object.keys(slackUpdates).length ? { slack: slackUpdates } : {});
    } catch (err) {
      notifier.configure({ ...previous, token: previousStored.token || '' });
      logger.error('[slack] Config save failed:', err.message);
      return res.status(500).json({ error: 'Slack settings were not saved. Check server logs.' });
    }
    let savedDisplayName = '';
    try { savedDisplayName = loadConfig().slack?.displayName || ''; } catch {}
    res.json({ success: true, config: { ...notifier.getConfig(), displayName: savedDisplayName } });
  });

  router.post('/slack/test', requireAdmin, async (req, res) => {
    try {
      const result = await notifier.test();
      if (result.ok) res.json({ success: true });
      else res.status(400).json({ success: false, error: result.error });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.post('/slack/verify', requireAdmin, async (req, res) => {
    let { token } = req.body || {};
    if (!token) {
      try { token = loadConfig().slack?.token || ''; } catch {}
    }
    try {
      res.json(await notifier.verifyToken(token));
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  router.post('/slack/lookup-user', requireAdmin, async (req, res) => {
    let { username, token } = req.body || {};
    if (!token) {
      try { token = loadConfig().slack?.token || ''; } catch {}
    }
    try {
      res.json(await notifier.lookupUser(username, token));
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  return router;
};
