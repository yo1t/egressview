'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const history = require('../../src/history');
const { createAiBudget } = require('../../src/ai-budget');

describe('durable AI budget', () => {
  it('enforces a per-principal daily request limit before provider work starts', () => {
    history._initForTest(':memory:');
    const budget = createAiBudget({
      history,
      now: () => Date.UTC(2026, 7, 24, 12),
      limits: { principalRequests: 1, principalTokens: 1000, providerRequests: 10, providerTokens: 10_000 },
    });
    const reservation = budget.begin({ principal: 'api:one', provider: 'openai', kind: 'chat' });
    budget.finish(reservation, { outcome: 'complete', totalTokens: 10 });

    assert.throws(
      () => budget.begin({ principal: 'api:one', provider: 'openai', kind: 'chat' }),
      error => error.code === 'AI_BUDGET_EXCEEDED' && error.reason === 'principal_request_limit'
    );
    assert.doesNotThrow(() => budget.begin({ principal: 'api:two', provider: 'openai', kind: 'chat' }));
  });

  it('counts failed attempts and completed tokens durably', () => {
    history._initForTest(':memory:');
    const now = Date.UTC(2026, 7, 24, 12);
    const budget = createAiBudget({
      history,
      now: () => now,
      limits: { principalRequests: 10, principalTokens: 10, providerRequests: 20, providerTokens: 100 },
    });
    const failed = budget.begin({ principal: 'local:admin', provider: 'anthropic', kind: 'analysis' });
    budget.finish(failed, { outcome: 'failure' });
    const completed = budget.begin({ principal: 'local:admin', provider: 'anthropic', kind: 'analysis' });
    budget.finish(completed, { outcome: 'complete', totalTokens: 12 });

    const summary = history.summarizeAiBudget(
      budget.principalHash('local:admin'), 'anthropic', now - 1, now + 1
    );
    assert.deepEqual(summary, { requests: 2, totalTokens: 12, failures: 1 });
    assert.throws(
      () => budget.begin({ principal: 'local:admin', provider: 'anthropic', kind: 'analysis' }),
      error => error.code === 'AI_BUDGET_EXCEEDED' && error.reason === 'principal_token_limit'
    );
  });
});
