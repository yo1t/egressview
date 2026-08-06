// Unit tests for src/routes/slack.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const slackRoutes = require('../../src/routes/slack');

const requireAdmin = (req, res, next) => next();

const defaultNotifier = {
  getConfig:   () => ({ enabled: false, userId: '', cooldownMinutes: 5 }),
  configure:   () => {},
  test:        async () => ({ ok: true }),
  verifyToken: async () => ({ ok: true, botName: 'EgressBot' }),
  lookupUser:  async () => ({ ok: true, userId: 'U12345' }),
};

function makeApp(overrides = {}) {
  const ctx = {
    notifier:      defaultNotifier,
    saveConfig:    () => {},
    loadConfig:    () => ({}),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', slackRoutes({ requireAdmin, ...ctx }));
  return app;
}

function req(app, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = new Readable({
      read() {
        if (payload) this.push(payload);
        this.push(null);
      },
    });
    request.method = method;
    request.url = path;
    request.headers = {};
    if (payload) {
      request.headers['content-type'] = 'application/json';
      request.headers['content-length'] = String(payload.length);
    }

    const response = new http.ServerResponse(request);
    const chunks = [];
    const socket = new Writable({
      write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    // Express grafts http.IncomingMessage.prototype onto this object, so destroying
    // the stream would run IncomingMessage._destroy against a request that has none
    // of the internal fields that method assumes. Since Node 26.7.0 its abort path
    // detaches a listener from an undefined socket and throws. This is a plain
    // Readable standing in for a request, so give it a plain teardown.
    request._destroy = (error, done) => done(error);
    response.assignSocket(socket);
    response.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ status: response.statusCode, body: JSON.parse(text || 'null') });
    });
    app.handle(request, response, reject);
  });
}

// ─── GET /api/config/slack ────────────────────────────────────────────────────

describe('slack route: GET /api/config/slack', () => {
  it('returns notifier config with displayName from loadConfig', async () => {
    const app = makeApp({ loadConfig: () => ({ slack: { displayName: 'MyBot' } }) });
    const { status, body } = await req(app, 'GET', '/api/config/slack');
    assert.equal(status, 200);
    assert.equal(body.config.displayName, 'MyBot');
  });

  it('prefers the notifier-held displayName', async () => {
    const app = makeApp({
      notifier: { ...defaultNotifier, getConfig: () => ({ displayName: 'Runtime User', userId: 'U1' }) },
      loadConfig: () => ({ slack: { displayName: 'Stored User' } }),
    });
    const { body } = await req(app, 'GET', '/api/config/slack');
    assert.equal(body.config.displayName, 'Runtime User');
  });

  it('returns empty displayName when loadConfig throws', async () => {
    const app = makeApp({ loadConfig: () => { throw new Error('fail'); } });
    const { status, body } = await req(app, 'GET', '/api/config/slack');
    assert.equal(status, 200);
    assert.equal(body.config.displayName, '');
  });

  it('returns empty displayName when loadConfig returns no slack key', async () => {
    const app = makeApp({ loadConfig: () => ({}) });
    const { status, body } = await req(app, 'GET', '/api/config/slack');
    assert.equal(status, 200);
    assert.equal(body.config.displayName, '');
  });

  it('rejects unknown query fields', async () => {
    assert.equal((await req(makeApp(), 'GET', '/api/config/slack?extra=1')).status, 400);
  });
});

// ─── POST /api/config/slack ───────────────────────────────────────────────────

describe('slack route: POST /api/config/slack', () => {
  it('calls saveConfig and returns success', async () => {
    let saved = false;
    const app = makeApp({ saveConfig: () => { saved = true; } });
    const { status, body } = await req(app, 'POST', '/api/config/slack', { enabled: true });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(saved, true);
  });

  it('passes token to the atomic config save when provided', async () => {
    let captured;
    const app = makeApp({ saveConfig: overrides => { captured = overrides; } });
    await req(app, 'POST', '/api/config/slack', { token: 'xoxb-test-token' });
    assert.equal(captured.slack.token, 'xoxb-test-token');
  });

  it('passes displayName to the atomic config save when provided', async () => {
    let captured;
    const app = makeApp({ saveConfig: overrides => { captured = overrides; } });
    await req(app, 'POST', '/api/config/slack', { displayName: 'AlertBot' });
    assert.equal(captured.slack.displayName, 'AlertBot');
  });

  it('uses an empty override when no secret or display name is provided', async () => {
    let captured;
    const app = makeApp({ saveConfig: overrides => { captured = overrides; } });
    await req(app, 'POST', '/api/config/slack', { enabled: true, cooldownMinutes: 10 });
    assert.deepEqual(captured, {});
  });

  it('returns 500 when config persistence fails', async () => {
    const app = makeApp({ saveConfig: () => { throw new Error('disk full'); } });
    const { status, body } = await req(app, 'POST', '/api/config/slack', { enabled: true });
    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
  });

  it('returns displayName from loadConfig in response', async () => {
    const app = makeApp({ loadConfig: () => ({ slack: { displayName: 'Saved' } }) });
    const { body } = await req(app, 'POST', '/api/config/slack', {});
    assert.equal(body.config.displayName, 'Saved');
  });

  it('rejects unknown, mistyped, and out-of-range settings before configuring', async () => {
    let configureCalls = 0;
    const app = makeApp({
      notifier: { ...defaultNotifier, configure: () => { configureCalls++; } },
    });
    assert.equal((await req(app, 'POST', '/api/config/slack', { enabled: true, typo: 1 })).status, 400);
    assert.equal((await req(app, 'POST', '/api/config/slack', { enabled: 'true' })).status, 400);
    assert.equal((await req(app, 'POST', '/api/config/slack', { cooldownMinutes: 1441 })).status, 400);
    assert.equal((await req(app, 'POST', '/api/config/slack', { token: 'x'.repeat(513) })).status, 400);
    assert.equal(configureCalls, 0);
  });
});

// ─── POST /api/slack/test ─────────────────────────────────────────────────────

describe('slack route: POST /api/slack/test', () => {
  it('returns success: true when notifier.test() resolves ok', async () => {
    const app = makeApp();
    const { status, body } = await req(app, 'POST', '/api/slack/test', {});
    assert.equal(status, 200);
    assert.equal(body.success, true);
  });

  it('returns 400 when notifier.test() returns ok: false', async () => {
    const app = makeApp({
      notifier: { ...defaultNotifier, test: async () => ({ ok: false, error: 'invalid_token' }) },
    });
    const { status, body } = await req(app, 'POST', '/api/slack/test', {});
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_token');
  });

  it('returns 500 when notifier.test() throws', async () => {
    const app = makeApp({
      notifier: { ...defaultNotifier, test: async () => { throw new Error('network error'); } },
    });
    const { status } = await req(app, 'POST', '/api/slack/test', {});
    assert.equal(status, 500);
  });
});

// ─── POST /api/slack/verify ───────────────────────────────────────────────────

describe('slack route: POST /api/slack/verify', () => {
  it('passes provided token to verifyToken', async () => {
    let captured;
    const app = makeApp({
      notifier: { ...defaultNotifier, verifyToken: async (t) => { captured = t; return { ok: true }; } },
    });
    await req(app, 'POST', '/api/slack/verify', { token: 'xoxb-provided' });
    assert.equal(captured, 'xoxb-provided');
  });

  it('falls back to loadConfig token when no token in body', async () => {
    let captured;
    const app = makeApp({
      loadConfig: () => ({ slack: { token: 'xoxb-from-config' } }),
      notifier:   { ...defaultNotifier, verifyToken: async (t) => { captured = t; return { ok: true }; } },
    });
    await req(app, 'POST', '/api/slack/verify', {});
    assert.equal(captured, 'xoxb-from-config');
  });

  it('falls back to the notifier-held token when config has no token', async () => {
    let captured = 'not-called';
    const app = makeApp({
      notifier: { ...defaultNotifier, verifyToken: async (t) => { captured = t; return { ok: true }; } },
    });
    await req(app, 'POST', '/api/slack/verify', {});
    assert.equal(captured, undefined);
  });

  it('returns 500 when verifyToken throws', async () => {
    const app = makeApp({
      notifier: { ...defaultNotifier, verifyToken: async () => { throw new Error('err'); } },
    });
    const { status } = await req(app, 'POST', '/api/slack/verify', { token: 'x' });
    assert.equal(status, 500);
  });

  it('rejects unknown and non-string token fields', async () => {
    const app = makeApp();
    assert.equal((await req(app, 'POST', '/api/slack/verify', { token: {} })).status, 400);
    assert.equal((await req(app, 'POST', '/api/slack/verify', { extra: true })).status, 400);
  });
});

// ─── POST /api/slack/lookup-user ─────────────────────────────────────────────

describe('slack route: POST /api/slack/lookup-user', () => {
  it('passes username and provided token to lookupUser', async () => {
    let captured;
    const app = makeApp({
      notifier: { ...defaultNotifier, lookupUser: async (u, t) => { captured = { u, t }; return { ok: true }; } },
    });
    await req(app, 'POST', '/api/slack/lookup-user', { username: 'john', token: 'xoxb-tok' });
    assert.equal(captured.u, 'john');
    assert.equal(captured.t, 'xoxb-tok');
  });

  it('falls back to loadConfig token when no token in body', async () => {
    let capturedToken;
    const app = makeApp({
      loadConfig: () => ({ slack: { token: 'xoxb-cfg' } }),
      notifier:   { ...defaultNotifier, lookupUser: async (u, t) => { capturedToken = t; return { ok: true }; } },
    });
    await req(app, 'POST', '/api/slack/lookup-user', { username: 'alice' });
    assert.equal(capturedToken, 'xoxb-cfg');
  });

  it('falls back to the notifier-held token when config has no token', async () => {
    let capturedToken = 'not-called';
    const app = makeApp({
      notifier: {
        ...defaultNotifier,
        lookupUser: async (_username, token) => { capturedToken = token; return { ok: true }; },
      },
    });
    await req(app, 'POST', '/api/slack/lookup-user', { username: 'alice' });
    assert.equal(capturedToken, undefined);
  });

  it('returns 500 when lookupUser throws', async () => {
    const app = makeApp({
      notifier: { ...defaultNotifier, lookupUser: async () => { throw new Error('fail'); } },
    });
    const { status } = await req(app, 'POST', '/api/slack/lookup-user', { username: 'bob', token: 'x' });
    assert.equal(status, 500);
  });

  it('rejects missing, oversized, and object usernames', async () => {
    const app = makeApp();
    assert.equal((await req(app, 'POST', '/api/slack/lookup-user', {})).status, 400);
    assert.equal((await req(app, 'POST', '/api/slack/lookup-user', { username: 'x'.repeat(257) })).status, 400);
    assert.equal((await req(app, 'POST', '/api/slack/lookup-user', { username: {} })).status, 400);
  });
});
