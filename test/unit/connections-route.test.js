// Unit tests for /api/connections route helpers
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { _attachThreats } = require('../../src/routes/connections');

describe('connections route: attachThreats', () => {
  it('adds threat intel to SQLite/API rows that do not persist threat', () => {
    const rows = [{
      src: '192.168.1.10',
      dst: '203.0.113.10',
      dstHost: 'raw.githubusercontent.com',
      dport: 443,
      proto: 'TCP',
      firstSeen: 1000,
      lastSeen: 2000,
    }];
    const threatIntel = {
      matchThreatIntel(dst, host) {
        assert.equal(dst, '203.0.113.10');
        assert.equal(host, 'raw.githubusercontent.com');
        return {
          source: 'urlhaus',
          tag: 'URLhaus: malware hosted on raw.githubusercontent.com',
          confidence: 'low',
          matchType: 'domain',
          matchValue: 'raw.githubusercontent.com',
        };
      },
    };

    const result = _attachThreats(rows, threatIntel);

    assert.equal(result[0].threat.confidence, 'low');
    assert.equal(result[0].threat.source, 'urlhaus');
  });

  it('sets threat to null when there is no match', () => {
    const result = _attachThreats(
      [{ src: '192.168.1.10', dst: '8.8.8.8', dstHost: 'dns.google' }],
      { matchThreatIntel: () => null }
    );

    assert.equal(result[0].threat, null);
  });

  it('returns rows unchanged (no threat field) when threatIntel is not provided', () => {
    // Regression guard: routeCtx must include threatIntel, otherwise attachThreats
    // early-returns and ALL API responses have threat=undefined (P2-4 regression root cause)
    const rows = [{ src: '192.168.1.10', dst: '203.0.113.10', dstHost: 'raw.githubusercontent.com' }];
    const result = _attachThreats(rows, undefined);
    // Returns the original rows without modification — threat field is absent
    assert.strictEqual(result, rows, 'should return the original array reference');
    assert.equal(result[0].threat, undefined, 'threat field should not be set');
  });
});
