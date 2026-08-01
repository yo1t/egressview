'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');

const {
  buildCspHeader,
  createIndexHtmlBase,
  injectIndexBootstrap,
  registerHealthRoutes,
  setSecurityHeaders,
  serializeI18nModule,
} = require('../../src/http-app');
const { createTrustProxy } = require('../../src/proxy-trust');
const { createHealthState } = require('../../src/health-state');
const express = require('express');

function request(app, url, { headers = {}, remoteAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() { this.push(null); } });
    req.method = 'GET';
    req.url = url;
    req.headers = headers;
    const res = new http.ServerResponse(req);
    const chunks = [];
    const socket = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    if (remoteAddress) socket.remoteAddress = remoteAddress;
    req.socket = socket;
    req.connection = socket;
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const [headers, ...parts] = raw.split('\r\n\r\n');
      resolve({
        status: res.statusCode,
        headers: headers.toLowerCase(),
        body: JSON.parse(parts.join('\r\n\r\n') || 'null'),
      });
    });
    app.handle(req, res, reject);
  });
}

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
    assert.doesNotMatch(csp.value, /style-src-attr/);
    assert.doesNotMatch(csp.value, /unsafe-inline/);
    assert.equal(csp.hsts, 'max-age=31536000; includeSubDomains');
  });

  it('omits HSTS for plain HTTP mode', () => {
    const csp = buildCspHeader('abc', false);
    assert.equal(csp.hsts, null);
  });
});

describe('setSecurityHeaders', () => {
  function makeApp({ tlsEnabled = false } = {}) {
    const app = express();
    app.set('trust proxy', createTrustProxy('10.41.0.0/24'));
    app.use((req, res, next) => {
      setSecurityHeaders(req, res, tlsEnabled);
      next();
    });
    app.get('/', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('sets HSTS for HTTPS forwarded by a trusted proxy', async () => {
    const response = await request(makeApp(), '/', {
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '10.41.0.10',
    });
    assert.match(response.headers, /strict-transport-security: max-age=31536000; includesubdomains/);
  });

  it('does not trust forwarded HTTPS from an untrusted peer', async () => {
    const response = await request(makeApp(), '/', {
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '192.0.2.10',
    });
    assert.doesNotMatch(response.headers, /strict-transport-security/);
  });
});

describe('health endpoints', () => {
  function makeApp() {
    const app = express();
    const healthState = createHealthState();
    registerHealthRoutes(app, healthState);
    return { app, healthState };
  }

  it('reports liveness without exposing runtime details', async () => {
    const { app } = makeApp();
    const response = await request(app, '/healthz');
    assert.equal(response.status, 200);
    assert.match(response.headers, /cache-control: no-store/);
    assert.deepEqual(response.body, { status: 'ok' });
  });

  it('reports readiness only after bootstrap is marked complete', async () => {
    const { app, healthState } = makeApp();
    const starting = await request(app, '/readyz');
    assert.equal(starting.status, 503);
    assert.deepEqual(starting.body, { status: 'not_ready' });

    healthState.markReady();
    const ready = await request(app, '/readyz');
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body, { status: 'ready' });

    healthState.markNotReady();
    assert.equal((await request(app, '/readyz')).status, 503);
  });
});
