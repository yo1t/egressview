'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { buildAiFacts } = require('../ai-facts');
const { buildAiContext } = require('../ai-context');
const { randomUUID } = require('node:crypto');
const { monthlyRanges, pricingCoverage, pricingMetadata, pricingStatus } = require('../ai-usage');
const { AI_PRIOR_ANALYSIS_MAX_CHARS } = require('../ai-limits');
const logger = require('../logger');
const {
  sourceScopeShape, validateSourceScopePair, requireKnownSourceScope,
} = require('../source-scope');

const providerSchema = z.enum(['disabled', 'ollama', 'anthropic', 'openai', 'bedrock']);
const cloudProviderSchema = z.enum(['anthropic', 'openai']);
// Providers that transmit data externally and therefore require explicit consent.
const consentProviderSchema = z.enum(['anthropic', 'openai', 'bedrock']);
const modelSchema = z.string().max(200);
// Bedrock model may be a foundation model id, a cross-region inference profile
// id (us./eu./apac./jp./au./global), or an ARN — allow extra length for ARNs.
const bedrockModelSchema = z.string().max(400);
// AWS region such as ap-northeast-1 (Tokyo) or us-east-1.
const regionSchema = z.string().max(64);
const configSchema = z.object({
  provider: providerSchema.optional(),
  models: z.object({
    ollama: modelSchema.optional(),
    anthropic: modelSchema.optional(),
    openai: modelSchema.optional(),
    bedrock: bedrockModelSchema.optional(),
  }).strict().optional(),
  keys: z.object({
    anthropic: z.string().max(4096).optional(),
    openai: z.string().max(4096).optional(),
  }).strict().optional(),
  clearKeys: z.array(cloudProviderSchema).max(2).optional(),
  cloudConsent: z.object({
    anthropic: z.boolean().optional(),
    openai: z.boolean().optional(),
    bedrock: z.boolean().optional(),
  }).strict().optional(),
  ollamaEndpoint: z.string().max(2048).optional(),
  region: regionSchema.optional(),
  // Amazon Bedrock Guardrails (opt-in). id may be a guardrail id or ARN.
  guardrail: z.object({
    enabled: z.boolean().optional(),
    id: z.string().max(2048).optional(),
    version: z.string().max(64).optional(),
  }).strict().optional(),
}).strict();
const emptySchema = z.object({}).strict();
const bedrockModelDiscoverySchema = z.object({ region: regionSchema }).strict();
const timestampSchema = z.coerce.number().int().nonnegative();
const factsQueryShape = {
  from: timestampSchema,
  to: timestampSchema.optional(),
  ...sourceScopeShape,
};
const factsQuerySchema = z.object(factsQueryShape).strict().superRefine(validateSourceScopePair);
const MAX_FACTS_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const languageSchema = z.enum(['ja', 'en']);
const analysisSchema = z.object({
  ...factsQueryShape,
  cloudConsentConfirmed: z.boolean().optional(),
  // UI language so the model replies in the language the user selected.
  language: languageSchema.optional(),
}).strict().superRefine(validateSourceScopePair);
const idSchema = z.string().uuid();
const chatSchema = z.object({
  ...factsQueryShape,
  cloudConsentConfirmed: z.boolean().optional(),
  language: languageSchema.optional(),
  conversationId: idSchema.optional(),
  requestId: idSchema.optional(),
  message: z.string().trim().min(1).max(4000),
  // Optional text of the most recent "analyze current period" result so the
  // chat can reason about the same threats. Bounded to keep the prompt small.
  priorAnalysis: z.string().max(AI_PRIOR_ANALYSIS_MAX_CHARS).optional(),
}).strict().superRefine(validateSourceScopePair);
const conversationParamsSchema = z.object({ id: idSchema }).strict();
const usageQuerySchema = z.object({
  timezoneOffset: z.coerce.number().int().min(-840).max(840).default(0),
}).strict();
const pricingCheckSchema = z.object({
  provider: z.enum(['ollama', 'anthropic', 'openai', 'bedrock']),
  model: z.string().trim().min(1).max(400),
}).strict();

module.exports = function aiRoutes({
  requireAdmin, aiProvider, saveConfig, history, threatIntel, routerManager, devices, asus, agentIdentities,
}) {
  const router = Router();
  const collectionSources = sourceScope => {
    const routers = routerManager?.list?.() || [];
    if (!sourceScope) return routers;
    if (sourceScope.sourceKind === 'router') {
      return routers.filter(item => String(item.id) === sourceScope.sourceId);
    }
    const agent = agentIdentities?.listAgents?.()
      .find(item => !item.revokedAt && String(item.agentId) === sourceScope.sourceId);
    if (!agent) return [];
    return [{
      id: agent.agentId,
      kind: 'agent',
      displayName: agent.hostName || 'Mac Agent',
      enabled: true,
      ready: Number(agent.lastSeenAt) > 0 && Date.now() - Number(agent.lastSeenAt) <= 5 * 60 * 1000,
      lastPollAt: agent.lastSeenAt || null,
    }];
  };
  const warnedUnpricedModels = new Set();

  function persistUsage(result, { kind, requestId = randomUUID(), conversationId = null } = {}) {
    if (!result || typeof history?.appendAiUsage !== 'function') return;
    if (!result.usage && !result.text && result.verified !== true) return;
    const usage = result.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const pricing = result.pricing || {};
    const unpricedKey = `${result.provider || 'unknown'}/${result.model || 'unknown'}`;
    if (usage.totalTokens > 0 && !result.pricing && !warnedUnpricedModels.has(unpricedKey)) {
      warnedUnpricedModels.add(unpricedKey);
      logger.warn(`[ai] Pricing unavailable; cost total is partial: ${JSON.stringify({
        provider: result.provider || 'unknown', model: result.model || 'unknown',
      })}`);
    }
    try {
      history.appendAiUsage({
        usageId: randomUUID(),
        requestId,
        conversationId,
        kind,
        createdAt: result.generatedAt || Date.now(),
        provider: result.provider,
        model: result.model || '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUsd: Number.isFinite(result.estimatedCostUsd) ? result.estimatedCostUsd : null,
        pricingVersion: pricing.pricingVersion || null,
        inputUsdPerMillion: pricing.inputUsdPerMillion ?? null,
        outputUsdPerMillion: pricing.outputUsdPerMillion ?? null,
      });
    } catch (error) {
      // Usage telemetry must not discard a successfully generated answer.
      logger.warn('[ai] Usage persistence failed:', error.message);
    }
  }

  function withModelPricing(result) {
    const models = Array.isArray(result?.models) ? result.models : [];
    return { ...result, modelPricing: pricingCoverage(result?.provider, models) };
  }

  function publicConfigWithPricing() {
    const publicConfig = aiProvider.getPublicConfig();
    const provider = publicConfig.provider;
    const model = publicConfig.models?.[provider] || '';
    return {
      ...publicConfig,
      selectedModelPricing: provider === 'disabled' || !model ? null : pricingStatus(provider, model),
    };
  }

  router.get('/config/ai', requireAdmin, (_req, res) => {
    res.json(publicConfigWithPricing());
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
    if (consentProviderSchema.safeParse(nextProvider).success && !nextConsent[nextProvider]) {
      return res.status(400).json({ error: 'Cloud AI data sharing consent is required' });
    }
    try {
      aiProvider.configure({
        provider: nextProvider,
        models: { ...previous.models, ...(parsed.data.models || {}) },
        keys: nextKeys,
        cloudConsent: nextConsent,
        ollamaEndpoint: parsed.data.ollamaEndpoint ?? previous.ollamaEndpoint,
        region: parsed.data.region ?? previous.region,
        guardrail: { ...previous.guardrail, ...(parsed.data.guardrail || {}) },
      });
      saveConfig();
    } catch (error) {
      aiProvider.configure(previous);
      const validationError = /Ollama endpoint|Unsupported AI provider|AWS region/.test(error.message);
      return res.status(validationError ? 400 : 500).json({
        error: validationError ? error.message : 'Settings were not saved. Check server logs.',
      });
    }
    res.json({ success: true, ...publicConfigWithPricing() });
  });

  router.post('/ai/test', requireAdmin, async (req, res) => {
    const parsed = parseRequest(emptySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      const result = await aiProvider.testConnection();
      persistUsage(result, { kind: 'test' });
      res.json({ success: true, ...withModelPricing(result) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Discovery-only model listing (no InvokeModel verification, no config save).
  // Lets the settings UI populate the model dropdown for a region so the
  // inference-profile filter has data to work with, without a full test.
  router.post('/ai/models', requireAdmin, async (req, res) => {
    const parsed = parseRequest(bedrockModelDiscoverySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      res.json({ success: true, ...withModelPricing(await aiProvider.listModels({
        provider: 'bedrock',
        region: parsed.data.region,
      })) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/ai/pricing/check', requireAdmin, (req, res) => {
    const parsed = parseRequest(pricingCheckSchema, req.body, res);
    if (!parsed.ok) return;
    res.json({ success: true, ...pricingStatus(parsed.data.provider, parsed.data.model) });
  });

  // Discovery-only Guardrail listing for the region (no InvokeModel, no save).
  // Fail-open: missing bedrock:ListGuardrails yields an empty list so the UI
  // falls back to manual guardrail id/version entry.
  router.post('/ai/guardrails', requireAdmin, async (req, res) => {
    const parsed = parseRequest(bedrockModelDiscoverySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      res.json({ success: true, ...await aiProvider.listGuardrails({
        provider: 'bedrock',
        region: parsed.data.region,
      }) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message, guardrails: [] });
    }
  });

  router.get('/ai/facts', requireAdmin, (req, res) => {
    const parsed = parseRequest(factsQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const scoped = requireKnownSourceScope(parsed.data, { routerManager, agentIdentities }, res);
    if (!scoped.ok) return;
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
        routers: collectionSources(scoped.scope),
        from,
        to,
        sourceScope: scoped.scope,
      }));
    } catch (error) {
      res.status(500).json({ error: 'AI facts could not be calculated' });
    }
  });

  router.get('/ai/usage/monthly', requireAdmin, (req, res) => {
    const parsed = parseRequest(usageQuerySchema, req.query, res);
    if (!parsed.ok) return;
    try {
      const ranges = monthlyRanges(Date.now(), parsed.data.timezoneOffset);
      const summarizePeriod = range => ({
        ...range,
        ...history.summarizeAiUsage(range.from, range.to),
        unpricedModels: typeof history.summarizeUnpricedAiUsage === 'function'
          ? history.summarizeUnpricedAiUsage(range.from, range.to)
          : [],
      });
      res.json({
        pricing: { ...pricingMetadata(), approximate: true },
        selectedModel: publicConfigWithPricing().selectedModelPricing,
        current: summarizePeriod(ranges.current),
        previous: summarizePeriod(ranges.previous),
      });
    } catch {
      res.status(500).json({ error: 'AI usage could not be calculated' });
    }
  });

  router.get('/ai/pricing/diagnostics', requireAdmin, (req, res) => {
    const parsed = parseRequest(usageQuerySchema, req.query, res);
    if (!parsed.ok) return;
    try {
      const ranges = monthlyRanges(Date.now(), parsed.data.timezoneOffset);
      res.json({
        pricing: pricingMetadata(),
        selectedModel: publicConfigWithPricing().selectedModelPricing,
        currentUnpricedModels: history.summarizeUnpricedAiUsage(ranges.current.from, ranges.current.to),
        previousUnpricedModels: history.summarizeUnpricedAiUsage(ranges.previous.from, ranges.previous.to),
      });
    } catch {
      res.status(500).json({ error: 'AI pricing diagnostics could not be calculated' });
    }
  });

  router.post('/ai/analyze', requireAdmin, async (req, res) => {
    const parsed = parseRequest(analysisSchema, req.body, res);
    if (!parsed.ok) return;
    const scoped = requireKnownSourceScope(parsed.data, { routerManager, agentIdentities }, res);
    if (!scoped.ok) return;
    const to = parsed.data.to ?? Date.now();
    const { from } = parsed.data;
    if (to <= from) return res.status(400).json({ error: '"to" must be later than "from"' });
    if (to - from > MAX_FACTS_RANGE_MS) {
      return res.status(400).json({ error: 'AI facts range must not exceed 14 days' });
    }
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    try {
      const sourceScope = scoped.scope;
      const routers = collectionSources(sourceScope);
      const facts = buildAiFacts({ history, threatIntel, routers, from, to, sourceScope });
      const context = buildAiContext({ facts, history, routers, from, to, threatIntel, devices, asus, sourceScope });
      const result = await aiProvider.generateInsight(context, {
        signal: controller.signal,
        cloudConsentConfirmed: parsed.data.cloudConsentConfirmed,
        language: parsed.data.language,
      });
      persistUsage(result, { kind: 'analysis' });
      res.json({ success: true, range: { from, to }, ...result });
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
    const scoped = requireKnownSourceScope(parsed.data, { routerManager, agentIdentities }, res);
    if (!scoped.ok) return;
    const to = parsed.data.to ?? Date.now();
    const { from } = parsed.data;
    if (to <= from || to - from > MAX_FACTS_RANGE_MS) {
      return res.status(400).json({ error: 'AI chat range must be valid and not exceed 14 days' });
    }
    const publicConfig = aiProvider.getPublicConfig();
    if (publicConfig.provider === 'disabled') return res.status(400).json({ error: 'AI provider is disabled' });
    let conversationId = parsed.data.conversationId || randomUUID();
    const requestId = parsed.data.requestId || randomUUID();
    const model = publicConfig.models[publicConfig.provider] || '';
    const existingConversation = history.getConversation(conversationId);
    let startedNewConversation = false;
    if (existingConversation && (existingConversation.provider !== publicConfig.provider || existingConversation.model !== model)) {
      // A provider/model switch must not mix identities inside an append-only
      // conversation. Preserve the old history and continue the question in a
      // fresh conversation instead of rejecting an otherwise valid request.
      conversationId = randomUUID();
      startedNewConversation = true;
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
      const sourceScope = scoped.scope;
      const routers = collectionSources(sourceScope);
      const facts = buildAiFacts({ history, threatIntel, routers, from, to, sourceScope });
      const context = buildAiContext({ facts, history, routers, from, to, threatIntel, devices, asus, sourceScope });
      const response = await aiProvider.generateInsight(context, {
        signal: controller.signal,
        cloudConsentConfirmed: parsed.data.cloudConsentConfirmed,
        question: parsed.data.message,
        priorAnalysis: parsed.data.priorAnalysis,
        language: parsed.data.language,
        conversation: prior.filter(message => message.status === 'complete' && message.body)
          .slice(-20).map(message => ({ role: message.role, body: message.body })),
      });
      const assistant = history.appendMessage({
        messageId: randomUUID(), conversationId, requestId, role: 'assistant', body: response.text,
        createdAt: Date.now(), provider: response.provider, model: response.model, rangeFrom: from, rangeTo: to,
        status: 'complete', errorCode: null,
      });
      persistUsage(response, { kind: 'chat', requestId, conversationId });
      res.json({
        success: true,
        conversationId,
        requestId,
        startedNewConversation,
        message: assistant,
        usage: response.usage,
        estimatedCostUsd: response.estimatedCostUsd,
      });
    } catch (error) {
      history.appendMessage({
        messageId: randomUUID(), conversationId, requestId, role: 'assistant', body: null,
        createdAt: Date.now(), provider: publicConfig.provider, model, rangeFrom: from, rangeTo: to,
        status: 'failed', errorCode: error.code || error.name || 'AI_ERROR',
      });
      const status = error.code === 'AI_BUSY' ? 409 : error.code === 'AI_CONSENT_REQUIRED' ? 403 : 400;
      res.status(status).json({
        success: false, conversationId, requestId, startedNewConversation, error: error.message,
      });
    }
  });

  return router;
};
