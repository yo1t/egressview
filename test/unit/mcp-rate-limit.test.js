// Rate limiting and concurrency control for the remote MCP endpoint
// (P2-60 PR 4).
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS, createMcpRateLimiter, rateLimitOptionsFromEnv } = require('../../src/mcp-rate-limit');

function limiterAt(clock, options = {}) {
  return createMcpRateLimiter({ now: () => clock.value, ...options });
}

describe('MCP rate limiting', () => {
  it('allows traffic up to the global limit and refuses the next request', () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock, { globalPerMinute: 3, perSubjectPerMinute: 99, perClientPerMinute: 99 });
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.check({ subject: `s${i}`, clientId: `c${i}` }).allowed, true);
    }
    const denied = limiter.check({ subject: 's9', clientId: 'c9' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'global_rate_limit');
    assert.ok(denied.retryAfterSeconds >= 1);
  });

  it('stops one subject without affecting another', () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock, { globalPerMinute: 999, perSubjectPerMinute: 2, perClientPerMinute: 999 });
    assert.equal(limiter.check({ subject: 'noisy' }).allowed, true);
    assert.equal(limiter.check({ subject: 'noisy' }).allowed, true);
    const denied = limiter.check({ subject: 'noisy' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'subject_rate_limit');
    assert.equal(limiter.check({ subject: 'quiet' }).allowed, true, 'other subjects keep working');
  });

  it('stops one client without affecting another', () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock, { globalPerMinute: 999, perSubjectPerMinute: 999, perClientPerMinute: 2 });
    limiter.check({ clientId: 'bad' });
    limiter.check({ clientId: 'bad' });
    assert.equal(limiter.check({ clientId: 'bad' }).reason, 'client_rate_limit');
    assert.equal(limiter.check({ clientId: 'good' }).allowed, true);
  });

  it('limits unauthenticated requests through the global bucket', () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock, { globalPerMinute: 2 });
    assert.equal(limiter.check({}).allowed, true);
    assert.equal(limiter.check({}).allowed, true);
    // No subject or client yet, but the flood is still bounded.
    assert.equal(limiter.check({}).reason, 'global_rate_limit');
  });

  it('recovers when the window rolls over', () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock, { globalPerMinute: 1 });
    assert.equal(limiter.check({}).allowed, true);
    assert.equal(limiter.check({}).allowed, false);
    clock.value += DEFAULTS.windowMs;
    assert.equal(limiter.check({}).allowed, true, 'a new window starts fresh');
  });
});

describe('MCP concurrency control', () => {
  it('refuses new work once the in-flight cap is reached', () => {
    const limiter = createMcpRateLimiter({ maxConcurrent: 2, globalPerMinute: 999 });
    const first = limiter.check({});
    assert.equal(first.allowed, true);
    const releaseA = limiter.acquire();
    assert.equal(limiter.check({}).allowed, true);
    const releaseB = limiter.acquire();
    const denied = limiter.check({});
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'concurrency_limit');
    releaseA();
    assert.equal(limiter.check({}).allowed, true, 'capacity returns when work finishes');
    releaseB();
    assert.equal(limiter.stats().inFlight, 0);
  });

  it('ignores a double release so the count cannot drift', () => {
    const limiter = createMcpRateLimiter({ maxConcurrent: 1 });
    const release = limiter.acquire();
    release();
    release();
    assert.equal(limiter.stats().inFlight, 0);
  });
});

describe('MCP limiter memory bounds', () => {
  it('drops keys from expired windows', () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock, { globalPerMinute: 9999, perSubjectPerMinute: 9999 });
    for (let i = 0; i < 50; i++) limiter.check({ subject: `s${i}` });
    assert.ok(limiter.stats().trackedKeys > 1);
    clock.value += DEFAULTS.windowMs * 2;
    limiter.check({ subject: 'next' });
    assert.ok(limiter.stats().trackedKeys <= 2, 'expired keys are swept');
  });

  it('clears tracking rather than growing without bound', () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock, {
      globalPerMinute: 999999, perSubjectPerMinute: 999999, maxTrackedKeys: 10,
    });
    for (let i = 0; i < 40; i++) limiter.check({ subject: `flood-${i}` });
    assert.ok(limiter.stats().trackedKeys <= 40, 'tracking stays bounded under distinct keys');
  });
});

describe('MCP limit configuration', () => {
  it('reads positive integers from the environment', () => {
    const options = rateLimitOptionsFromEnv({
      MCP_RATE_LIMIT_GLOBAL: '10',
      MCP_RATE_LIMIT_SUBJECT: '5',
      MCP_RATE_LIMIT_CLIENT: '7',
      MCP_MAX_CONCURRENT: '3',
    });
    assert.deepEqual(options, {
      globalPerMinute: 10, perSubjectPerMinute: 5, perClientPerMinute: 7, maxConcurrent: 3,
    });
  });

  it('falls back to the default instead of disabling a limit', () => {
    for (const bad of ['0', '-1', 'abc', '', undefined, '1.5']) {
      const options = rateLimitOptionsFromEnv({ MCP_RATE_LIMIT_GLOBAL: bad });
      assert.equal(options.globalPerMinute, DEFAULTS.globalPerMinute, `"${bad}" must not disable the limit`);
    }
  });
});
