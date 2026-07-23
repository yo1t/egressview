'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultAppState, applyConfigToAppState } = require('../../src/app-state');

describe('createDefaultAppState', () => {
  it('returns a fresh default state object', () => {
    const a = createDefaultAppState();
    const b = createDefaultAppState();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.beaconConfig, b.beaconConfig);
    assert.equal(a.uiLanguage, 'ja');
    assert.equal(a.dnsmasqLogFile, '/var/log/dnsmasq-queries.log');
  });
});

describe('applyConfigToAppState', () => {
  function makeLogger() {
    return {
      warnings: [],
      warn(msg) { this.warnings.push(msg); },
    };
  }

  it('applies general/auth/https/beacon settings to state', () => {
    const state = createDefaultAppState();
    applyConfigToAppState(state, {
      general: { homeCountry: 'US', language: 'en', autoInvestigate: true, retentionDays: 30 },
      adminToken: 'abc',
      auth: {
        passwordHash: 'hash',
        salt: 'salt',
        password: { algorithm: 'scrypt', version: 1 },
      },
      oidc: {
        enabled: true,
        clientId: 'client-id',
        clientSecret: 'client-secret', // pragma: allowlist secret
        allowedEmails: ['admin@example.com'],
        allowedDomains: ['example.com'],
      },
      https: { enabled: true, certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
      beacons: {
        enabled: false,
        minObs: 8,
        maxCov: 0.2,
        minIntervalMs: 1_000,
        maxIntervalMs: 2_000,
        scanIntervalMs: 3_000,
        whitelistDomains: ['example.com'],
        orgAllowlist: ['Example Org'],
      },
    }, {
      isAllowedLogPath: () => true,
      logger: makeLogger(),
    });

    assert.equal(state.homeCountry, 'US');
    assert.equal(state.uiLanguage, 'en');
    assert.equal(state.autoInvestigate, true);
    assert.equal(state.retentionDays, 30);
    assert.equal(state.adminToken, 'abc');
    assert.equal(state.authPasswordHash, 'hash');
    assert.equal(state.authPasswordSalt, 'salt');
    assert.equal(state.authPasswordRecord.version, 1);
    assert.equal(state.oidcConfig.enabled, true);
    assert.equal(state.oidcConfig.clientId, 'client-id');
    assert.deepEqual(state.oidcConfig.allowedDomains, ['example.com']);
    assert.equal(state.httpsEnabled, true);
    assert.equal(state.httpsCertPath, '/tmp/cert.pem');
    assert.equal(state.httpsKeyPath, '/tmp/key.pem');
    assert.equal(state.beaconConfig.enabled, false);
    assert.equal(state.beaconConfig.minObs, 8);
    assert.equal(state.beaconConfig.maxCov, 0.2);
    assert.deepEqual(state.beaconConfig.whitelistDomains, ['example.com']);
    assert.deepEqual(state.beaconConfig.orgAllowlist, ['Example Org']);
  });

  it('falls back to default log paths and warns for disallowed paths', () => {
    const state = createDefaultAppState();
    const logger = makeLogger();

    applyConfigToAppState(state, {
      dnsmasq: { logFile: '/tmp/nope.log' },
      inspect: { enabled: true, logFile: '/var/log/custom-inspect.log' },
      dhcpd: { enabled: false, logFile: '/private/etc/shadow' },
    }, {
      isAllowedLogPath: (p) => p.startsWith('/var/log/'),
      logger,
    });

    assert.equal(state.dnsmasqLogFile, '/var/log/dnsmasq-queries.log');
    assert.equal(state.inspectLogFile, '/var/log/custom-inspect.log');
    assert.equal(state.dhcpdLogFile, '/var/log/yamaha-router.log');
    assert.equal(state.dhcpdEnabled, false);
    assert.equal(logger.warnings.length, 2);
  });
});
