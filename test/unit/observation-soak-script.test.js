'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseApiTimeoutMs } = require('../../scripts/check-observation-consistency');

describe('observation soak script configuration', () => {
  it('uses a 30 second API timeout by default', () => {
    assert.equal(parseApiTimeoutMs(undefined), 30_000);
    assert.equal(parseApiTimeoutMs(''), 30_000);
  });

  it('accepts bounded fractional timeout values', () => {
    assert.equal(parseApiTimeoutMs('1'), 1_000);
    assert.equal(parseApiTimeoutMs('45.5'), 45_500);
    assert.equal(parseApiTimeoutMs('300'), 300_000);
  });

  it('rejects invalid timeout values', () => {
    for (const value of ['0', '-1', '301', 'invalid', 'Infinity']) {
      assert.throws(
        () => parseApiTimeoutMs(value),
        /EGRESSVIEW_SOAK_API_TIMEOUT_SECONDS must be between 1 and 300/,
      );
    }
  });
});
