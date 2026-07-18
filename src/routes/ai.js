'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { buildAiFacts } = require('../ai-facts');
const { buildAnonymousAiContext } = require('../ai-context');

const providerSchema = z.enum(['disabled', 'ollama', 'anthropic', 'openai']);
const cloudProviderSchema = z.enum(['anthropic', 'openai']);
const modelSchema = z.string().max(200);
const configSchema = z.object({
  provider: providerSchema.optional(),
  models: z.object({
    ollama: modelSchema.optional(),
    anthropic: modelSchema.optional(),
    openai: modelSchema.optional(),
  }).strict().optional(),
  keys: z.object({
    anthropic: z.string().max(4096).optional(),
    openai: z.string().max(4096).optional(),
  }).strict().optional(),
  clearKeys: z.array(cloudProviderSchema).max(2).optional(),
  ollamaEndpoint: z.string().max(2048).optional(),
}).strict();
const emptySchema = z.object({}).strict();
const timestampSchema = z.coerce.number().int().nonnegative();
const factsQuerySchema = z.object({
  from: timestampSchema,
  to: timestampSchema.optional(),
}).strict();
const MAX_FACTS_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const analysisSchema = factsQuerySchema;

module.exports = function aiRoutes({ requireAdmin, aiProvider, saveConfig, history, threatIntel, routerManager }) {
  const router = Router();

  router.get('/config/ai', requireAdmin, (_req, res) => {
    res.json(aiProvider.getPublicConfig());
  });

  router.post('/config/ai', requireAdmin, (req, res) => {
    const parsed = parseRequest(configSchema, req.body, res);
    if (!parsed.ok) return;
    const previous = aiProvider.exportConfig();
    const nextKeys = { ...previous.keys };
    for (const [name, key] of Object.entries(parsed.data.keys || {})) {
      if (key) nextKeys[name] = key;
    }
    for (const name of parsed.data.clearKeys || []) nextKeys[name] = '';
    try {
      aiProvider.configure({
        provider: parsed.data.provider ?? previous.provider,
        models: { ...previous.models, ...(parsed.data.models || {}) },
        keys: nextKeys,
        ollamaEndpoint: parsed.data.ollamaEndpoint ?? previous.ollamaEndpoint,
      });
      saveConfig();
    } catch (error) {
      aiProvider.configure(previous);
      const validationError = /Ollama endpoint|Unsupported AI provider/.test(error.message);
      return res.status(validationError ? 400 : 500).json({
        error: validationError ? error.message : 'Settings were not saved. Check server logs.',
      });
    }
    res.json({ success: true, ...aiProvider.getPublicConfig() });
  });

  router.post('/ai/test', requireAdmin, async (req, res) => {
    const parsed = parseRequest(emptySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      res.json({ success: true, ...await aiProvider.listModels() });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.get('/ai/facts', requireAdmin, (req, res) => {
    const parsed = parseRequest(factsQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const to = parsed.data.to ?? Date.now();
    const { from } = parsed.data;
    if (to <= from) return res.status(400).json({ error: '"to" must be later than "from"' });
    if (to - from > MAX_FACTS_RANGE_MS) {
      return res.status(400).json({ error: 'AI facts range must not exceed 14 days' });
    }
    try {
      res.json(buildAiFacts({
        history,
        threatIntel,
        routers: routerManager.list(),
        from,
        to,
      }));
    } catch (error) {
      res.status(500).json({ error: 'AI facts could not be calculated' });
    }
  });

  router.post('/ai/analyze', requireAdmin, async (req, res) => {
    const parsed = parseRequest(analysisSchema, req.body, res);
    if (!parsed.ok) return;
    const to = parsed.data.to ?? Date.now();
    const { from } = parsed.data;
    if (to <= from) return res.status(400).json({ error: '"to" must be later than "from"' });
    if (to - from > MAX_FACTS_RANGE_MS) {
      return res.status(400).json({ error: 'AI facts range must not exceed 14 days' });
    }
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    try {
      const routers = routerManager.list();
      const facts = buildAiFacts({ history, threatIntel, routers, from, to });
      const context = buildAnonymousAiContext({ facts, history, routers, from, to });
      res.json({ success: true, range: { from, to }, ...await aiProvider.generateInsight(context, {
        signal: controller.signal,
      }) });
    } catch (error) {
      const status = error.code === 'AI_BUSY' ? 409 : 400;
      res.status(status).json({ success: false, error: error.message });
    }
  });

  return router;
};
