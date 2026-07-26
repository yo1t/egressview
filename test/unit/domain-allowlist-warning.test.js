// Unit tests for the P2-61 Phase 0 domain allowlist advisory.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAIN_ALLOWLIST_WARNING_CODE,
  domainAllowlistWarning,
  securityConfigWarnings,
} = require('../../src/domain-allowlist-warning');

describe('domainAllowlistWarning', () => {
  it('warns when an enabled configuration carries a domain allowlist', () => {
    const warning = domainAllowlistWarning({
      enabled: true,
      allowedDomains: ['example.com', 'corp.example.jp'],
    });
    assert.deepEqual(warning, {
      code: DOMAIN_ALLOWLIST_WARNING_CODE,
      domains: ['example.com', 'corp.example.jp'],
    });
  });

  it('stays silent while OIDC is disabled, because no domain can sign in', () => {
    assert.equal(domainAllowlistWarning({ enabled: false, allowedDomains: ['example.com'] }), null);
  });

  it('stays silent for an email-only allowlist', () => {
    assert.equal(
      domainAllowlistWarning({ enabled: true, allowedEmails: ['a@example.com'], allowedDomains: [] }),
      null
    );
  });

  it('ignores blank domain entries', () => {
    assert.equal(domainAllowlistWarning({ enabled: true, allowedDomains: ['', '   '] }), null);
  });

  it('tolerates missing or malformed configuration', () => {
    assert.equal(domainAllowlistWarning(), null);
    assert.equal(domainAllowlistWarning(null), null);
    assert.equal(domainAllowlistWarning({ enabled: true }), null);
    assert.equal(domainAllowlistWarning({ enabled: true, allowedDomains: 'example.com' }), null);
  });

  it('does not expose the caller to later mutation of the stored list', () => {
    const config = { enabled: true, allowedDomains: ['example.com'] };
    const warning = domainAllowlistWarning(config);
    warning.domains.push('attacker.example');
    assert.deepEqual(config.allowedDomains, ['example.com']);
  });
});

describe('securityConfigWarnings', () => {
  it('returns an array so later advisories keep the response shape', () => {
    assert.deepEqual(securityConfigWarnings({ enabled: true, allowedDomains: [] }), []);
    const warnings = securityConfigWarnings({ enabled: true, allowedDomains: ['example.com'] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, DOMAIN_ALLOWLIST_WARNING_CODE);
  });
});
