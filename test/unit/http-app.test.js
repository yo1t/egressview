'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCspHeader,
  createIndexHtmlBase,
  injectIndexBootstrap,
  serializeI18nModule,
} = require('../../src/http-app');

describe('serializeI18nModule', () => {
  it('returns an ES module and escapes script-breaking characters', () => {
    const moduleSource = serializeI18nModule({ ja: { x: '</script>\u2028' }, en: { x: 'ok' } });
    assert.match(moduleSource, /^export default /);
    assert.doesNotMatch(moduleSource, /<\/script>/);
    assert.doesNotMatch(moduleSource, /\u2028/);
    assert.match(moduleSource, /\\u003c\/script>/);
    assert.match(moduleSource, /\\u2028/);
  });
});

describe('createIndexHtmlBase', () => {
  it('replaces subpath and asset version placeholders once at startup', () => {
    const html = '<base href="__BASE__/"><script src="/app.js?v=__ASSET_VERSION__"></script>';
    const base = createIndexHtmlBase(html, '/demo', '42', (v) => v);
    assert.equal(base, '<base href="/demo/"><script src="/app.js?v=42"></script>');
  });
});

describe('injectIndexBootstrap', () => {
  it('injects the nonce bootstrap script before the closing head tag', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectIndexBootstrap(html, '/sub', true, 'nonce-123', (v) => v);
    assert.match(out, /nonce="nonce-123"/);
    assert.match(out, /window\.BASE_URL = '\/sub'/);
    assert.match(out, /window\._DEMO_MODE = true/);
  });
});

describe('buildCspHeader', () => {
  it('builds the CSP and enables HSTS only for TLS', () => {
    const csp = buildCspHeader('abc', true);
    assert.match(csp.value, /script-src 'self' 'nonce-abc'/);
    assert.match(csp.value, /style-src-attr 'unsafe-inline'/);
    assert.equal(csp.hsts, 'max-age=31536000; includeSubDomains');
  });

  it('omits HSTS for plain HTTP mode', () => {
    const csp = buildCspHeader('abc', false);
    assert.equal(csp.hsts, null);
  });
});
