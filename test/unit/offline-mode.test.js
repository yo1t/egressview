// Offline mode policy (P2-65 Phase 2).
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  OFFLINE_ENV,
  INTERNET_FEATURES,
  INTERNAL_CAPABLE_FEATURES,
  ALL_GATED_FEATURES,
  isOfflineMode,
  isPrivateIpLiteral,
  parseInternalEndpoint,
  featureStatus,
  createOfflinePolicy,
} = require('../../src/offline-mode');
const {
  createAiProvider,
  setOfflinePolicy: setAiOfflinePolicy,
} = require('../../src/ai-provider');

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
      internalEndpoints: {
        'ai-ollama': 'http://10.0.0.20:11434',
        'dns-ptr': '10.0.0.53',
      },
    });
    assert.equal(policy.allows('ai-ollama'), true);
    assert.equal(policy.allows('dns-ptr'), true);
    assert.equal(policy.endpointFor('dns-ptr'), '10.0.0.53');
    // Configuring an internal endpoint must never re-enable an internet feature.
    assert.equal(policy.allows('ai-anthropic'), false);
  });

  it('accepts only private or loopback IP literals for internal endpoints', () => {
    for (const address of ['127.0.0.1', '10.0.0.20', '172.16.1.2', '192.168.1.2', '::1', 'fd00::20']) {
      assert.equal(isPrivateIpLiteral(address), true, address);
    }
    for (const address of ['8.8.8.8', '203.0.113.10', '2606:4700:4700::1111', 'ollama.internal']) {
      assert.equal(isPrivateIpLiteral(address), false, address);
    }
    assert.equal(parseInternalEndpoint('ai-ollama', 'http://[::1]:11434'), 'http://[::1]:11434');
    assert.throws(
      () => parseInternalEndpoint('ai-ollama', 'https://ollama.internal'),
      /loopback or private IP/
    );
    // Link-local metadata (IMDS) is reachable on a cloud instance even offline,
    // so it must be refused despite matching the private-literal shape.
    assert.throws(
      () => parseInternalEndpoint('ai-ollama', 'http://169.254.169.254:11434'),
      /loopback or private IP/
    );
    assert.throws(
      () => parseInternalEndpoint('dns-ptr', '169.254.169.254'),
      /EGRESSVIEW_INTERNAL_DNS/
    );
    assert.throws(
      () => createOfflinePolicy({
        env: { [OFFLINE_ENV]: 'true' },
        internalEndpoints: { 'dns-ptr': '8.8.8.8' },
      }),
      /EGRESSVIEW_INTERNAL_DNS/
    );
  });

  it('revalidates Ollama endpoints when settings change', () => {
    const policy = createOfflinePolicy({
      env: { [OFFLINE_ENV]: 'true' },
      internalEndpoints: { 'ai-ollama': 'http://10.0.0.20:11434' },
    });
    setAiOfflinePolicy(policy);
    try {
      const provider = createAiProvider();
      provider.configure({ provider: 'ollama', ollamaEndpoint: 'http://10.0.0.20:11434' });
      assert.throws(
        () => provider.configure({ ollamaEndpoint: 'https://api.example.com' }),
        /disabled in offline mode/
      );
      assert.equal(provider.getPublicConfig().ollamaEndpoint, 'http://10.0.0.20:11434');
    } finally {
      setAiOfflinePolicy(null);
    }
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

  it('keeps the pinned vendor copies byte-for-byte intact', () => {
    const assets = {
      'public/vendor/d3-7.9.0.min.js': 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539', // pragma: allowlist secret
      'public/vendor/topojson-client-3.1.0.min.js': '25cd02ae486cc5063e0215a4e4cfb15de83700c87ac48bac4d57dc6aaf3ebb89', // pragma: allowlist secret
      'public/vendor/world-atlas-countries-110m-2.0.2.json': '2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8', // pragma: allowlist secret
    };
    for (const [asset, expected] of Object.entries(assets)) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset))).digest('hex');
      assert.equal(actual, expected, `${asset} differs from the reviewed upstream asset`);
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
