// Routes: Slack notification configuration
'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const logger = require('../logger');

const slackConfigSchema = z.object({
  enabled: z.boolean().optional(),
  token: z.string().max(512).optional(),
  userId: z.string().max(256).optional(),
  cooldownMinutes: z.number().finite().positive().max(1440).optional(),
  displayName: z.string().max(256).optional(),
}).strict();
const emptyBodySchema = z.object({}).strict();
const emptyQuerySchema = z.object({}).strict();
const slackVerifySchema = z.object({ token: z.string().max(512).optional() }).strict();
const slackLookupSchema = z.object({
  username: z.string().min(1).max(256),
  token: z.string().max(512).optional(),
}).strict();

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
    const parsed = parseRequest(emptyQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const cfg = notifier.getConfig();
    let displayName = cfg.displayName || '';
    if (!displayName) {
      try { displayName = loadConfig().slack?.displayName || ''; } catch {}
    }
    res.json({ config: { ...cfg, displayName } });
  });

  router.post('/config/slack', requireAdmin, (req, res) => {
    const parsed = parseRequest(slackConfigSchema, req.body, res);
    if (!parsed.ok) return;
    const { enabled, token, userId, cooldownMinutes, displayName } = parsed.data;
    const previous = notifier.getConfig();
    let previousStored = {};
    try { previousStored = loadConfig().slack || {}; } catch {}
    notifier.configure({
      enabled:          typeof enabled         === 'boolean' ? enabled         : undefined,
      token:            typeof token           === 'string' && token ? token   : undefined,
      userId:           typeof userId          === 'string' ? userId           : undefined,
      displayName:      typeof displayName     === 'string' ? displayName      : undefined,
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
    const parsed = parseRequest(emptyBodySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      const result = await notifier.test();
      if (result.ok) res.json({ success: true });
      else res.status(400).json({ success: false, error: result.error });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  router.post('/slack/verify', requireAdmin, async (req, res) => {
    const parsed = parseRequest(slackVerifySchema, req.body, res);
    if (!parsed.ok) return;
    let { token } = parsed.data;
    if (!token) {
      try { token = loadConfig().slack?.token || ''; } catch {}
    }
    try {
      res.json(await notifier.verifyToken(token || undefined));
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  router.post('/slack/lookup-user', requireAdmin, async (req, res) => {
    const parsed = parseRequest(slackLookupSchema, req.body, res);
    if (!parsed.ok) return;
    let { username, token } = parsed.data;
    if (!token) {
      try { token = loadConfig().slack?.token || ''; } catch {}
    }
    try {
      res.json(await notifier.lookupUser(username, token || undefined));
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  return router;
};
