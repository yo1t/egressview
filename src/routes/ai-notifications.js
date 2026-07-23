'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const logger = require('../logger');

const configSchema = z.object({
  frequency: z.enum(['off', 'daily', 'weekly']),
  weekday: z.number().int().min(0).max(6),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  rangeHours: z.number().int().min(1).max(336),
  destinations: z.object({
    ui: z.boolean(),
    slack: z.boolean(),
  }).strict().refine(value => value.ui || value.slack, 'At least one destination is required'),
  threat: z.object({
    enabled: z.boolean(),
    dangerThreshold: z.number().int().min(1).max(1000),
    newDestinationsThreshold: z.number().int().min(1).max(1000),
    increaseThreshold: z.number().int().min(1).max(1000),
  }).strict(),
  dailyLimit: z.number().int().min(1).max(6),
  cooldownMinutes: z.number().int().min(15).max(1440),
  automationConsent: z.boolean(),
}).strict();
const emptySchema = z.object({}).strict();
const runSchema = z.object({ cloudConsentConfirmed: z.boolean().optional() }).strict();
const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

module.exports = function aiNotificationRoutes({ requireAdmin, aiNotificationService, history, saveConfig }) {
  const router = Router();

  function publicConfig() {
    const config = aiNotificationService.exportConfig();
    const status = aiNotificationService.publicStatus();
    const { automationProvider, ...safeConfig } = config;
    safeConfig.automationConsent = !!safeConfig.automationConsent
      && (!['anthropic', 'openai', 'bedrock'].includes(status.provider)
        || automationProvider === status.provider);
    return { config: safeConfig, status };
  }

  router.get('/ai/notification-config', requireAdmin, (req, res) => {
    const parsed = parseRequest(emptySchema, req.query, res);
    if (!parsed.ok) return;
    res.json(publicConfig());
  });

  router.post('/ai/notification-config', requireAdmin, (req, res) => {
    const parsed = parseRequest(configSchema, req.body, res);
    if (!parsed.ok) return;
    const previous = aiNotificationService.exportConfig();
    const provider = aiNotificationService.publicStatus().provider;
    const automated = parsed.data.frequency !== 'off' || parsed.data.threat.enabled;
    if (automated && ['anthropic', 'openai', 'bedrock'].includes(provider)
      && !parsed.data.automationConsent) {
      return res.status(400).json({ error: 'Cloud AI automation consent is required' });
    }
    try {
      aiNotificationService.configure({
        ...parsed.data,
        automationProvider: parsed.data.automationConsent ? provider : '',
      });
      saveConfig();
      res.json({ success: true, ...publicConfig() });
    } catch (error) {
      aiNotificationService.configure(previous);
      logger.error('[ai-notification] Config save failed:', error.message);
      const invalid = /time zone/i.test(error.message);
      res.status(invalid ? 400 : 500).json({
        error: invalid ? 'Invalid time zone' : 'AI notification settings were not saved. Check server logs.',
      });
    }
  });

  router.get('/ai/notification-events', requireAdmin, (req, res) => {
    const parsed = parseRequest(eventsQuerySchema, req.query, res);
    if (!parsed.ok) return;
    res.json({ events: history.listAiNotifications(parsed.data.limit) });
  });

  router.post('/ai/notification-test', requireAdmin, async (req, res) => {
    const parsed = parseRequest(emptySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      res.json({ success: true, event: await aiNotificationService.testDelivery() });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/ai/notification-run-now', requireAdmin, async (req, res) => {
    const parsed = parseRequest(runSchema, req.body, res);
    if (!parsed.ok) return;
    try {
      const event = await aiNotificationService.run({
        triggerType: 'manual',
        cause: 'run-now',
        consentConfirmed: parsed.data.cloudConsentConfirmed,
      });
      res.json({ success: true, event });
    } catch (error) {
      const status = error.code === 'AI_BUSY' ? 409
        : error.code === 'AI_CONSENT_REQUIRED' ? 403 : 400;
      res.status(status).json({ success: false, error: error.message });
    }
  });

  return router;
};
