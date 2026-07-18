'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { buildAiFacts } = require('../ai-facts');
const { buildAnonymousAiContext } = require('../ai-context');
const { randomUUID } = require('node:crypto');

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
  cloudConsent: z.object({
    anthropic: z.boolean().optional(),
    openai: z.boolean().optional(),
  }).strict().optional(),
  ollamaEndpoint: z.string().max(2048).optional(),
}).strict();
const emptySchema = z.object({}).strict();
const timestampSchema = z.coerce.number().int().nonnegative();
const factsQuerySchema = z.object({
  from: timestampSchema,
  to: timestampSchema.optional(),
}).strict();
const MAX_FACTS_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const analysisSchema = factsQuerySchema.extend({ cloudConsentConfirmed: z.boolean().optional() });
const idSchema = z.string().uuid();
const chatSchema = analysisSchema.extend({
  conversationId: idSchema.optional(),
  requestId: idSchema.optional(),
  message: z.string().trim().min(1).max(4000),
});
const conversationParamsSchema = z.object({ id: idSchema }).strict();

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
    const nextProvider = parsed.data.provider ?? previous.provider;
    const nextConsent = { ...previous.cloudConsent, ...(parsed.data.cloudConsent || {}) };
    if (cloudProviderSchema.safeParse(nextProvider).success && !nextConsent[nextProvider]) {
      return res.status(400).json({ error: 'Cloud AI data sharing consent is required' });
    }
    try {
      aiProvider.configure({
        provider: nextProvider,
        models: { ...previous.models, ...(parsed.data.models || {}) },
        keys: nextKeys,
        cloudConsent: nextConsent,
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
        cloudConsentConfirmed: parsed.data.cloudConsentConfirmed,
      }) });
    } catch (error) {
      const status = error.code === 'AI_BUSY' ? 409 : error.code === 'AI_CONSENT_REQUIRED' ? 403 : 400;
      res.status(status).json({ success: false, error: error.message });
    }
  });

  router.get('/ai/conversations', requireAdmin, (_req, res) => {
    res.json({ conversations: history.listConversations(), storage: history.getStorageStats() });
  });

  router.get('/ai/conversations/:id', requireAdmin, (req, res) => {
    const parsed = parseRequest(conversationParamsSchema, req.params, res);
    if (!parsed.ok) return;
    const conversation = history.getConversation(parsed.data.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ conversation, messages: history.getMessages(parsed.data.id) });
  });

  router.delete('/ai/conversations/:id', requireAdmin, (req, res) => {
    const parsed = parseRequest(conversationParamsSchema, req.params, res);
    if (!parsed.ok) return;
    if (!history.deleteConversation(parsed.data.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json({ success: true });
  });

  router.post('/ai/chat', requireAdmin, async (req, res) => {
    const parsed = parseRequest(chatSchema, req.body, res);
    if (!parsed.ok) return;
    const to = parsed.data.to ?? Date.now();
    const { from } = parsed.data;
    if (to <= from || to - from > MAX_FACTS_RANGE_MS) {
      return res.status(400).json({ error: 'AI chat range must be valid and not exceed 14 days' });
    }
    const publicConfig = aiProvider.getPublicConfig();
    if (publicConfig.provider === 'disabled') return res.status(400).json({ error: 'AI provider is disabled' });
    const conversationId = parsed.data.conversationId || randomUUID();
    const requestId = parsed.data.requestId || randomUUID();
    const model = publicConfig.models[publicConfig.provider] || '';
    const existingConversation = history.getConversation(conversationId);
    if (existingConversation && (existingConversation.provider !== publicConfig.provider || existingConversation.model !== model)) {
      return res.status(409).json({ error: 'Continue this conversation with its original provider and model' });
    }
    history.createConversation({
      conversationId, createdAt: Date.now(), provider: publicConfig.provider, model, rangeFrom: from, rangeTo: to,
    });
    const userMessage = history.appendMessage({
      messageId: randomUUID(), conversationId, requestId, role: 'user', body: parsed.data.message,
      createdAt: Date.now(), provider: publicConfig.provider, model, rangeFrom: from, rangeTo: to,
      status: 'complete', errorCode: null,
    });
    if (userMessage.conversationId !== conversationId) {
      return res.status(409).json({ error: 'requestId already belongs to another conversation' });
    }
    const prior = history.getMessages(conversationId);
    const existingReply = prior.find(message => message.requestId === requestId && message.role === 'assistant');
    if (existingReply) {
      return res.status(existingReply.status === 'complete' ? 200 : 409).json({
        success: existingReply.status === 'complete', conversationId, requestId, message: existingReply,
      });
    }
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    try {
      const routers = routerManager.list();
      const facts = buildAiFacts({ history, threatIntel, routers, from, to });
      const context = buildAnonymousAiContext({ facts, history, routers, from, to });
      const response = await aiProvider.generateInsight(context, {
        signal: controller.signal,
        cloudConsentConfirmed: parsed.data.cloudConsentConfirmed,
        question: parsed.data.message,
        conversation: prior.filter(message => message.status === 'complete' && message.body)
          .slice(-20).map(message => ({ role: message.role, body: message.body })),
      });
      const assistant = history.appendMessage({
        messageId: randomUUID(), conversationId, requestId, role: 'assistant', body: response.text,
        createdAt: Date.now(), provider: response.provider, model: response.model, rangeFrom: from, rangeTo: to,
        status: 'complete', errorCode: null,
      });
      res.json({ success: true, conversationId, requestId, message: assistant });
    } catch (error) {
      history.appendMessage({
        messageId: randomUUID(), conversationId, requestId, role: 'assistant', body: null,
        createdAt: Date.now(), provider: publicConfig.provider, model, rangeFrom: from, rangeTo: to,
        status: 'failed', errorCode: error.code || error.name || 'AI_ERROR',
      });
      const status = error.code === 'AI_BUSY' ? 409 : error.code === 'AI_CONSENT_REQUIRED' ? 403 : 400;
      res.status(status).json({ success: false, conversationId, requestId, error: error.message });
    }
  });

  return router;
};
