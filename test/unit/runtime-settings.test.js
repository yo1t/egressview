'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePollInterval,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
} = require('../../src/runtime-settings');

describe('resolvePollInterval', () => {
  it('uses the default when unset or invalid', () => {
    const warnings = [];
    const logger = { warn: message => warnings.push(message) };

    assert.equal(resolvePollInterval(undefined, logger), DEFAULT_POLL_INTERVAL_MS);
    assert.equal(resolvePollInterval('invalid', logger), DEFAULT_POLL_INTERVAL_MS);
    assert.equal(warnings.length, 1);
  });

  it('clamps intervals that would overload the router and event loop', () => {
    const warnings = [];
    const result = resolvePollInterval('2000', { warn: message => warnings.push(message) });

    assert.equal(result, MIN_POLL_INTERVAL_MS);
    assert.match(warnings[0], /clamped/);
  });

  it('accepts a safe integer interval', () => {
    assert.equal(resolvePollInterval('60000'), 60_000);
  });
});
