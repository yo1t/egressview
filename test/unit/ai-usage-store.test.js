'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/db-migrate');
const { createAiUsageStore } = require('../../src/ai-usage-store');

describe('AI usage store', () => {
  it('appends usage, deduplicates request retries, and summarizes a half-open range', () => {
    const db = new Database(':memory:');
    runMigrations(db, ':memory:');
    const store = createAiUsageStore({ getDb: () => db });
    const base = {
      usageId: 'usage-1', requestId: 'request-1', conversationId: null, kind: 'analysis',
      createdAt: 1000, provider: 'anthropic', model: 'claude-sonnet-4-5',
      inputTokens: 100, outputTokens: 20, totalTokens: 120, estimatedCostUsd: 0.0006,
      pricingVersion: 'test', inputUsdPerMillion: 3, outputUsdPerMillion: 15,
    };
    store.appendAiUsage(base);
    store.appendAiUsage({ ...base, usageId: 'usage-retry' });
    store.appendAiUsage({
      ...base, usageId: 'usage-2', requestId: 'request-2', createdAt: 2000,
      provider: 'unknown', inputTokens: 50, outputTokens: 10, totalTokens: 60,
      estimatedCostUsd: null, pricingVersion: null, inputUsdPerMillion: null, outputUsdPerMillion: null,
    });

    assert.deepEqual(store.summarizeAiUsage(1000, 2000), {
      requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120,
      pricedRequests: 1, usageMissingRequests: 0, unknownPriceRequests: 0,
      estimatedCostUsd: 0.0006,
    });
    assert.deepEqual(store.summarizeAiUsage(1000, 3000), {
      requests: 2, inputTokens: 150, outputTokens: 30, totalTokens: 180,
      pricedRequests: 1, usageMissingRequests: 0, unknownPriceRequests: 1,
      estimatedCostUsd: 0.0006,
    });
    assert.deepEqual(store.summarizeAiUsage(3000, 4000), {
      requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      pricedRequests: 0, usageMissingRequests: 0, unknownPriceRequests: 0,
      estimatedCostUsd: 0,
    });
    db.close();
  });

  it('distinguishes missing provider usage from an unknown model price', () => {
    const db = new Database(':memory:');
    runMigrations(db, ':memory:');
    const store = createAiUsageStore({ getDb: () => db });
    const base = {
      usageId: 'usage-missing', requestId: 'request-missing', conversationId: null, kind: 'analysis',
      createdAt: 1000, provider: 'anthropic', model: 'claude-sonnet-4-5',
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null,
      pricingVersion: null, inputUsdPerMillion: null, outputUsdPerMillion: null,
    };
    store.appendAiUsage(base);
    store.appendAiUsage({
      ...base, usageId: 'usage-unknown', requestId: 'request-unknown', model: 'future-model',
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    assert.deepEqual(store.summarizeAiUsage(0, 2000), {
      requests: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15,
      pricedRequests: 0, usageMissingRequests: 1, unknownPriceRequests: 1,
      estimatedCostUsd: 0,
    });
    db.close();
  });
});
