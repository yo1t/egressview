'use strict';

const pricingCatalog = require('./data/ai-pricing.json');

const PROVIDERS = new Set(['ollama', 'anthropic', 'openai', 'bedrock']);
const ROUTING_CLASSES = new Set(['any', 'global', 'non-global']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  if (!ISO_DATE.test(value || '')) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validatePricingCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== 1) throw new Error('AI pricing catalog schemaVersion must be 1');
  if (!isIsoDate(catalog.catalogVersion)) throw new Error('AI pricing catalogVersion must be an ISO date');
  if (catalog.currency !== 'USD') throw new Error('AI pricing catalog currency must be USD');
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    throw new Error('AI pricing catalog must contain entries');
  }

  const ids = new Set();
  const ranges = new Map();
  for (const entry of catalog.entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate AI pricing id: ${entry.id || '(empty)'}`);
    ids.add(entry.id);
    if (!PROVIDERS.has(entry.provider)) throw new Error(`Invalid AI pricing provider: ${entry.provider}`);
    if (!ROUTING_CLASSES.has(entry.routing)) throw new Error(`Invalid AI pricing routing: ${entry.routing}`);
    if (entry.provider !== 'bedrock' && entry.routing !== 'any') {
      throw new Error(`Only Bedrock pricing may use routing class ${entry.routing}`);
    }
    try { new RegExp(entry.modelPattern, 'i'); } catch { throw new Error(`Invalid AI pricing matcher: ${entry.id}`); }
    for (const field of ['inputUsdPerMillion', 'outputUsdPerMillion']) {
      if (!Number.isFinite(entry[field]) || entry[field] < 0) throw new Error(`Invalid ${field}: ${entry.id}`);
    }
    if (!isIsoDate(entry.effectiveFrom)) throw new Error(`Invalid effectiveFrom: ${entry.id}`);
    if (entry.effectiveFrom > catalog.catalogVersion) {
      throw new Error(`Pricing entry is newer than catalogVersion: ${entry.id}`);
    }
    if (entry.effectiveTo && (!isIsoDate(entry.effectiveTo) || entry.effectiveTo < entry.effectiveFrom)) {
      throw new Error(`Invalid effective date range: ${entry.id}`);
    }
    try {
      const source = new URL(entry.sourceUrl);
      if (source.protocol !== 'https:') throw new Error();
    } catch { throw new Error(`Invalid sourceUrl: ${entry.id}`); }

    const matcherKey = `${entry.provider}\0${entry.routing}\0${entry.modelPattern}`;
    const prior = ranges.get(matcherKey) || [];
    const end = entry.effectiveTo || '9999-12-31';
    if (prior.some(range => entry.effectiveFrom <= range.end && range.start <= end)) {
      throw new Error(`Overlapping AI pricing matcher: ${entry.id}`);
    }
    prior.push({ start: entry.effectiveFrom, end });
    ranges.set(matcherKey, prior);
  }
  return catalog;
}

const CATALOG = validatePricingCatalog(pricingCatalog);
const PRICING_VERSION = CATALOG.catalogVersion;
const COMPILED_ENTRIES = CATALOG.entries.map(entry => ({ ...entry, matcher: new RegExp(entry.modelPattern, 'i') }));

function normalizeTokenUsage(value) {
  if (!value) return null;
  const inputTokens = Math.max(0, Math.floor(Number(value.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(value.outputTokens) || 0));
  const totalTokens = Math.max(inputTokens + outputTokens, Math.floor(Number(value.totalTokens) || 0));
  return totalTokens > 0 ? { inputTokens, outputTokens, totalTokens } : null;
}

function routingFor(provider, model) {
  if (provider !== 'bedrock') return 'any';
  const id = String(model || '').toLowerCase();
  return id.startsWith('global.') || id.includes('/global.') ? 'global' : 'non-global';
}

function pricingFor(provider, model, effectiveDate = new Date().toISOString().slice(0, 10)) {
  const route = routingFor(provider, model);
  const id = String(model || '');
  const entry = COMPILED_ENTRIES.find(candidate => candidate.provider === provider
    && candidate.routing === route
    && candidate.effectiveFrom <= effectiveDate
    && (!candidate.effectiveTo || effectiveDate <= candidate.effectiveTo)
    && candidate.matcher.test(id));
  if (!entry) return null;
  return {
    pricingVersion: PRICING_VERSION,
    priceId: entry.id,
    effectiveFrom: entry.effectiveFrom,
    sourceUrl: entry.sourceUrl,
    routing: entry.routing,
    inputUsdPerMillion: entry.inputUsdPerMillion,
    outputUsdPerMillion: entry.outputUsdPerMillion,
  };
}

function pricingMetadata() {
  return {
    catalogVersion: CATALOG.catalogVersion,
    currency: CATALOG.currency,
    effectiveFrom: CATALOG.entries.reduce((latest, entry) => entry.effectiveFrom > latest ? entry.effectiveFrom : latest, ''),
    sourceUrls: [...new Set(CATALOG.entries.map(entry => entry.sourceUrl))],
  };
}

function estimateAiCost(provider, model, rawUsage) {
  const usage = normalizeTokenUsage(rawUsage);
  if (!usage) return { usage: null, pricing: null, estimatedCostUsd: null };
  const pricing = pricingFor(provider, model);
  if (!pricing) return { usage, pricing: null, estimatedCostUsd: null };
  const estimatedCostUsd = (
    usage.inputTokens * pricing.inputUsdPerMillion
    + usage.outputTokens * pricing.outputUsdPerMillion
  ) / 1_000_000;
  return { usage, pricing, estimatedCostUsd };
}

function monthlyRanges(now = Date.now(), timezoneOffsetMinutes = 0) {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const local = new Date(now - offsetMs);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const boundary = (y, m) => Date.UTC(y, m, 1) + offsetMs;
  return {
    current: { from: boundary(year, month), to: boundary(year, month + 1) },
    previous: { from: boundary(year, month - 1), to: boundary(year, month) },
  };
}

module.exports = {
  PRICING_VERSION,
  estimateAiCost,
  monthlyRanges,
  normalizeTokenUsage,
  pricingFor,
  pricingMetadata,
  validatePricingCatalog,
};
