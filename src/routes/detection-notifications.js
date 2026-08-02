// Routes: per-detection notification delivery switches
//
// These cover the detections notifier.js raises directly (threat and new
// device). The AI event rules are configured separately under
// /api/ai/notification-config; do not merge the two. In particular the AI
// config's `threat.enabled` gates AI analysis, not the plain threat DM.
'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const logger = require('../logger');

const channelsSchema = z.object({
  slack: z.boolean().optional(),
  history: z.boolean().optional(),
}).strict();

const detectionConfigSchema = z.object({
  threat: channelsSchema.optional(),
  newDevice: channelsSchema.optional(),
}).strict();

const emptyQuerySchema = z.object({}).strict();

module.exports = function detectionNotificationRoutes(ctx) {
  const { requireAdmin, notifier, saveConfig } = ctx;
  const router = Router();

  router.get('/config/detection-notifications', requireAdmin, (req, res) => {
    const parsed = parseRequest(emptyQuerySchema, req.query, res);
    if (!parsed.ok) return;
    res.json({ config: notifier.getDetectionConfig() });
  });

  router.post('/config/detection-notifications', requireAdmin, (req, res) => {
    const parsed = parseRequest(detectionConfigSchema, req.body, res);
    if (!parsed.ok) return;
    const previous = notifier.getDetectionConfig();
    notifier.configureDetection(parsed.data);
    try {
      saveConfig();
    } catch (err) {
      // Roll the in-memory switches back so a failed write cannot leave the
      // running process delivering differently from the persisted config.
      notifier.configureDetection(previous);
      logger.error('[detection-notifications] Config save failed:', err.message);
      return res.status(500).json({
        error: 'Detection notification settings were not saved. Check server logs.',
      });
    }
    res.json({ success: true, config: notifier.getDetectionConfig() });
  });

  return router;
};
