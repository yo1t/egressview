'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');

const providerSchema = z.enum(['abuseipdb', 'virustotal', 'otx']);
const configSchema = z.object({
  keys: z.object({
    abuseipdb: z.string().max(4096).optional(),
    virustotal: z.string().max(4096).optional(),
    otx: z.string().max(4096).optional(),
  }).strict().optional(),
  clearKeys: z.array(providerSchema).max(3).optional(),
  cacheTtlMinutes: z.coerce.number().int().min(5).max(1440).optional(),
  minIntervalSeconds: z.coerce.number().int().min(1).max(3600).optional(),
}).strict();
const lookupSchema = z.object({
  ip: z.string().min(3).max(45),
  providers: z.array(providerSchema).min(1).max(3),
}).strict();

module.exports = function manualThreatRoutes({ requireAdmin, manualThreat, saveConfig }) {
  const router = Router();

  router.get('/config/manual-threat', requireAdmin, (_req, res) => {
    res.json(manualThreat.getPublicConfig());
  });

  router.post('/config/manual-threat', requireAdmin, (req, res) => {
    const parsed = parseRequest(configSchema, req.body, res);
    if (!parsed.ok) return;
    const previous = manualThreat.exportConfig();
    const nextKeys = { ...previous.keys };
    for (const [provider, key] of Object.entries(parsed.data.keys || {})) {
      if (key) nextKeys[provider] = key;
    }
    for (const provider of parsed.data.clearKeys || []) nextKeys[provider] = '';
    manualThreat.configure({
      keys: nextKeys,
      cacheTtlMinutes: parsed.data.cacheTtlMinutes ?? previous.cacheTtlMinutes,
      minIntervalSeconds: parsed.data.minIntervalSeconds ?? previous.minIntervalSeconds,
    });
    try {
      saveConfig();
    } catch (error) {
      manualThreat.configure(previous);
      return res.status(500).json({ error: 'Settings were not saved. Check server logs.' });
    }
    res.json({ success: true, ...manualThreat.getPublicConfig() });
  });

  router.post('/threat/manual-lookup', requireAdmin, async (req, res) => {
    const parsed = parseRequest(lookupSchema, req.body, res);
    if (!parsed.ok) return;
    try {
      res.json({ success: true, ...await manualThreat.lookup(parsed.data.ip, parsed.data.providers) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  return router;
};
