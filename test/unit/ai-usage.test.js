'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  estimateAiCost,
  monthlyRanges,
  normalizeTokenUsage,
  pricingFor,
  pricingMetadata,
  validatePricingCatalog,
} = require('../../src/ai-usage');

describe('AI usage pricing', () => {
  it('normalizes provider token counters and preserves a larger reported total', () => {
    assert.deepEqual(normalizeTokenUsage({ inputTokens: 100.9, outputTokens: 25, totalTokens: 140 }), {
      inputTokens: 100, outputTokens: 25, totalTokens: 140,
    });
    assert.equal(normalizeTokenUsage({}), null);
  });

  it('estimates known model costs and leaves unknown prices explicit', () => {
    const direct = estimateAiCost('anthropic', 'claude-sonnet-4-5', {
      inputTokens: 1_000_000, outputTokens: 100_000,
    });
    assert.equal(direct.estimatedCostUsd, 4.5);

    const bedrock = pricingFor('bedrock', 'jp.anthropic.claude-sonnet-4-5-v1:0');
    assert.ok(Math.abs(bedrock.inputUsdPerMillion - 3.3) < 1e-12);
    assert.equal(bedrock.outputUsdPerMillion, 16.5);
    assert.equal(bedrock.routing, 'non-global');
    assert.equal(pricingFor('bedrock', 'global.anthropic.claude-sonnet-4-5-v1:0').inputUsdPerMillion, 3);
    assert.equal(estimateAiCost('ollama', 'local', { inputTokens: 10, outputTokens: 5 }).estimatedCostUsd, 0);
    assert.equal(estimateAiCost('openai', 'future-model', { inputTokens: 10, outputTokens: 5 }).estimatedCostUsd, null);
    assert.equal(estimateAiCost('openai', 'gpt-5.4', { inputTokens: 10, outputTokens: 5 }).estimatedCostUsd, null);
  });

  it('exposes version, effective date, and source metadata', () => {
    const metadata = pricingMetadata();
    assert.equal(metadata.catalogVersion, '2026-05-27');
    assert.equal(metadata.currency, 'USD');
    assert.equal(metadata.effectiveFrom, '2026-05-27');
    assert.ok(metadata.sourceUrls.every(url => url.startsWith('https://')));
  });

  it('rejects duplicate matchers, missing sources, and reversed effective dates', () => {
    const entry = {
      id: 'one', provider: 'openai', modelPattern: '^model$', routing: 'any',
      inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      effectiveFrom: '2026-01-01', sourceUrl: 'https://example.com/pricing',
    };
    const catalog = entries => ({ schemaVersion: 1, catalogVersion: '2026-01-01', currency: 'USD', entries });
    assert.throws(() => validatePricingCatalog(catalog([
      entry,
      { ...entry, id: 'two' },
    ])), /Overlapping AI pricing matcher/);
    assert.throws(() => validatePricingCatalog(catalog([{ ...entry, sourceUrl: '' }])), /sourceUrl/);
    assert.throws(() => validatePricingCatalog(catalog([{
      ...entry, effectiveTo: '2025-12-31',
    }])), /effective date range/);
    assert.throws(() => validatePricingCatalog(catalog([{
      ...entry, effectiveFrom: '2027-01-01',
    }])), /newer than catalogVersion/);
  });
});

describe('AI usage month ranges', () => {
  it('uses the browser timezone offset for local calendar month boundaries', () => {
    const now = Date.UTC(2026, 6, 19, 12);
    const ranges = monthlyRanges(now, -540);
    assert.deepEqual(ranges.current, {
      from: Date.UTC(2026, 5, 30, 15),
      to: Date.UTC(2026, 6, 31, 15),
    });
    assert.deepEqual(ranges.previous, {
      from: Date.UTC(2026, 4, 31, 15),
      to: Date.UTC(2026, 5, 30, 15),
    });
  });
});
