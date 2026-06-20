// Routes: Slack notification configuration
'use strict';

const { Router } = require('express');
const fs = require('fs');

/**
 * @param {{
 *   requireAdmin, notifier,
 *   saveConfig, persistSecret,
 *   configFile: string
 * }} ctx
 */
module.exports = function slackRoutes(ctx) {
  const { requireAdmin, notifier, saveConfig, persistSecret, configFile } = ctx;
  const router = Router();

  router.get('/config/slack', requireAdmin, (req, res) => {
    const cfg = notifier.getConfig();
    let displayName = '';
    try { displayName = JSON.parse(fs.readFileSync(configFile, 'utf8')).slack?.displayName || ''; } catch {}
    res.json({ config: { ...cfg, displayName } });
  });

  router.post('/config/slack', requireAdmin, (req, res) => {
    const { enabled, token, userId, cooldownMinutes, displayName } = req.body || {};
    notifier.configure({
      enabled:          typeof enabled         === 'boolean' ? enabled         : undefined,
      token:            typeof token           === 'string' && token ? token   : undefined,
      userId:           typeof userId          === 'string' ? userId           : undefined,
      cooldownMinutes:  typeof cooldownMinutes === 'number' ? cooldownMinutes  : undefined,
    });
    const slackUpdates = {};
    if (typeof token       === 'string' && token)       slackUpdates.token       = token;
    if (typeof displayName === 'string')                slackUpdates.displayName = displayName;
    if (Object.keys(slackUpdates).length) persistSecret('slack', slackUpdates);
    saveConfig();
    let savedDisplayName = '';
    try { savedDisplayName = JSON.parse(fs.readFileSync(configFile, 'utf8')).slack?.displayName || ''; } catch {}
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
      try { token = JSON.parse(fs.readFileSync(configFile, 'utf8')).slack?.token || ''; } catch {}
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
      try { token = JSON.parse(fs.readFileSync(configFile, 'utf8')).slack?.token || ''; } catch {}
    }
    try {
      res.json(await notifier.lookupUser(username, token));
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  return router;
};
