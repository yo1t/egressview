'use strict';

// USD list prices per one million tokens. Keep the effective date with every
// persisted estimate so historical totals remain explainable after prices move.
const PRICING_VERSION = '2026-05-27';

function normalizeTokenUsage(value) {
  if (!value) return null;
  const inputTokens = Math.max(0, Math.floor(Number(value.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(value.outputTokens) || 0));
  const totalTokens = Math.max(inputTokens + outputTokens, Math.floor(Number(value.totalTokens) || 0));
  return totalTokens > 0 ? { inputTokens, outputTokens, totalTokens } : null;
}

function anthropicRates(model) {
  const id = String(model || '').toLowerCase();
  if (/haiku[-.]?4[-.]?5|haiku-4-5/.test(id)) return [1, 5];
  if (/sonnet[-.]?4/.test(id) || /sonnet-4/.test(id)) return [3, 15];
  if (/opus[-.]?4[-.](?:5|6|7|8)|opus-4-(?:5|6|7|8)/.test(id)) return [5, 25];
  if (/opus[-.]?4(?:[-.]?1)?|opus-4(?:-1)?/.test(id)) return [15, 75];
  return null;
}

function openAiRates(model) {
  const id = String(model || '').toLowerCase();
  if (/^gpt-5-nano(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return [0.05, 0.40];
  if (/^gpt-5-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return [0.25, 2];
  if (/^gpt-5(?:-\d{4}-\d{2}-\d{2}|-chat-latest)?$/.test(id)) return [1.25, 10];
  return null;
}

function pricingFor(provider, model) {
  let rates = null;
  if (provider === 'ollama') rates = [0, 0];
  if (provider === 'anthropic') rates = anthropicRates(model);
  if (provider === 'openai') rates = openAiRates(model);
  if (provider === 'bedrock') {
    rates = anthropicRates(model);
    const id = String(model || '').toLowerCase();
    const globalProfile = id.startsWith('global.') || id.includes('/global.');
    // Current Bedrock Geo/In-Region Claude 4.5+ list prices are 10% above Global.
    if (rates && !globalProfile) rates = rates.map(rate => rate * 1.1);
  }
  if (!rates) return null;
  return {
    pricingVersion: PRICING_VERSION,
    inputUsdPerMillion: rates[0],
    outputUsdPerMillion: rates[1],
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

module.exports = { PRICING_VERSION, estimateAiCost, monthlyRanges, normalizeTokenUsage, pricingFor };
