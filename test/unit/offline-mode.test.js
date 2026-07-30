// Offline mode policy (P2-65 Phase 2).
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OFFLINE_ENV,
  INTERNET_FEATURES,
  INTERNAL_CAPABLE_FEATURES,
  ALL_GATED_FEATURES,
  isOfflineMode,
  featureStatus,
  createOfflinePolicy,
} = require('../../src/offline-mode');

const root = path.join(__dirname, '..', '..');

describe('offline mode detection', () => {
  it('is off unless the flag is exactly "true"', () => {
    for (const value of [undefined, '', 'false', '0', 'no', 'TRUE ', 'yes', '1']) {
      const env = value === undefined ? {} : { [OFFLINE_ENV]: value };
      assert.equal(isOfflineMode(env), value === 'TRUE ', `${JSON.stringify(value)}`);
    }
    assert.equal(isOfflineMode({ [OFFLINE_ENV]: 'true' }), true);
    assert.equal(isOfflineMode({ [OFFLINE_ENV]: ' True ' }), true);
  });
});

describe('feature gating', () => {
  it('leaves everything enabled when offline mode is off', () => {
    const policy = createOfflinePolicy({ env: {} });
    assert.equal(policy.offline, false);
    for (const feature of ALL_GATED_FEATURES) {
      assert.equal(policy.allows(feature), true, `${feature} must stay enabled`);
      assert.equal(policy.reasonFor(feature), null);
    }
  });

  it('disables every internet-only feature when offline', () => {
    const policy = createOfflinePolicy({ env: { [OFFLINE_ENV]: 'true' } });
    for (const feature of INTERNET_FEATURES) {
      assert.equal(policy.allows(feature), false, `${feature} must be disabled`);
      assert.equal(policy.reasonFor(feature), 'offline_mode');
    }
  });

  it('covers the features the requirement names', () => {
    for (const feature of ['rdap', 'geoip', 'threat-intel', 'oui-update',
      'manual-threat-lookup', 'google-oidc', 'ai-anthropic', 'ai-openai', 'ai-bedrock']) {
      assert.ok(INTERNET_FEATURES.includes(feature), `${feature} must be internet-gated`);
    }
  });

  it('keeps internal-capable features off until explicitly pointed somewhere', () => {
    const policy = createOfflinePolicy({ env: { [OFFLINE_ENV]: 'true' } });
    for (const feature of INTERNAL_CAPABLE_FEATURES) {
      assert.equal(policy.allows(feature), false, `${feature} must not be assumed reachable`);
      assert.equal(policy.reasonFor(feature), 'offline_mode_requires_internal_endpoint');
    }
  });

  it('enables an internal-capable feature once configured', () => {
    const policy = createOfflinePolicy({
      env: { [OFFLINE_ENV]: 'true' },
      internalEndpoints: { 'ai-ollama': true, 'dns-ptr': true },
    });
    assert.equal(policy.allows('ai-ollama'), true);
    assert.equal(policy.allows('dns-ptr'), true);
    assert.equal(policy.allows('internal-oidc'), false, 'unconfigured ones stay off');
    // Configuring an internal endpoint must never re-enable an internet feature.
    assert.equal(policy.allows('ai-anthropic'), false);
  });

  it('refuses an unknown feature instead of defaulting to allowed', () => {
    const policy = createOfflinePolicy({ env: { [OFFLINE_ENV]: 'true' } });
    assert.throws(() => policy.allows('not-a-feature'), /Unknown offline-gated feature/);
    assert.throws(() => featureStatus('not-a-feature', { offline: true }), /Unknown offline-gated feature/);
  });

  it('describes state in one shape for the API and UI', () => {
    const described = createOfflinePolicy({ env: { [OFFLINE_ENV]: 'true' } }).describe();
    assert.equal(described.offlineMode, true);
    assert.equal(described.features.rdap.enabled, false);
    assert.equal(described.features.rdap.reason, 'offline_mode');
    assert.equal(Object.keys(described.features).length, ALL_GATED_FEATURES.length);
  });
});

describe('no external asset references remain', () => {
  const files = ['public/index.html', 'public/js/map-common.js', 'src/http-app.js'];

  it('serves D3, TopoJSON and the world atlas from this origin', () => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const host of ['d3js.org', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']) {
        assert.equal(source.includes(host), false, `${file} still references ${host}`);
      }
    }
  });

  it('keeps the pinned vendor copies present and non-empty', () => {
    for (const asset of [
      'public/vendor/d3-7.9.0.min.js',
      'public/vendor/topojson-client-3.1.0.min.js',
      'public/vendor/world-atlas-countries-110m-2.0.2.json',
    ]) {
      const stat = fs.statSync(path.join(root, asset));
      assert.ok(stat.size > 1000, `${asset} looks truncated`);
    }
  });

  it('allows no external origin in the CSP', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'http-app.js'), 'utf8');
    const csp = source.slice(source.indexOf('function buildCspHeader'));
    const directives = csp.slice(0, csp.indexOf('return {'));
    assert.equal(/https:\/\/[a-z]/.test(directives), false,
      'CSP must not allow any external origin once assets are self-hosted');
  });

  it('loads the vendored scripts from the deployment base path', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    assert.match(html, /__BASE__\/vendor\/d3-7\.9\.0\.min\.js/);
    assert.match(html, /__BASE__\/vendor\/topojson-client-3\.1\.0\.min\.js/);
  });
});

describe('outbound-dependent modules consult the policy', () => {
  const gated = {
    'src/enrichment.js': ['rdap', 'geoip', 'dns-ptr'],
    'src/threat-intel.js': ['threat-intel'],
    'src/device-identify.js': ['oui-update'],
    'src/manual-threat-lookup.js': ['manual-threat-lookup'],
    'src/oidc-google.js': ['google-oidc'],
  };

  it('checks the policy before performing a request', () => {
    for (const [file, features] of Object.entries(gated)) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(source, /setOfflinePolicy/, `${file} must accept a policy`);
      for (const feature of features) {
        assert.ok(source.includes(`'${feature}'`), `${file} must gate ${feature}`);
      }
    }
  });

  it('refuses cloud AI providers before an SDK client is built', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'ai-provider.js'), 'utf8');
    assert.match(source, /offlineBlocksProvider/);
    for (const feature of ['ai-anthropic', 'ai-openai', 'ai-bedrock', 'ai-ollama']) {
      assert.ok(source.includes(`'${feature}'`), `ai-provider must map ${feature}`);
    }
  });

  it('injects the policy at startup, before collectors run', () => {
    const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(source, /createOfflinePolicy\(/);
    for (const call of [
      'enrichment.setOfflinePolicy',
      'threatIntel.setOfflinePolicy',
      'deviceId.setOfflinePolicy',
      'manualThreatModule.setOfflinePolicy',
      'aiProviderModule.setOfflinePolicy',
      'oidcModule.setOfflinePolicy',
    ]) {
      assert.ok(source.includes(call), `server.js must call ${call}`);
    }
  });
});
