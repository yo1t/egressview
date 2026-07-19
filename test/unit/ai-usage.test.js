'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { estimateAiCost, monthlyRanges, normalizeTokenUsage, pricingFor } = require('../../src/ai-usage');

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
    assert.equal(estimateAiCost('ollama', 'local', { inputTokens: 10, outputTokens: 5 }).estimatedCostUsd, 0);
    assert.equal(estimateAiCost('openai', 'future-model', { inputTokens: 10, outputTokens: 5 }).estimatedCostUsd, null);
    assert.equal(estimateAiCost('openai', 'gpt-5.4', { inputTokens: 10, outputTokens: 5 }).estimatedCostUsd, null);
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
