// Unit tests for src/routes/auth.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough, Readable, Writable } = require('node:stream');
const express = require('express');

const authRoutes = require('../../src/routes/auth');

const requireAdmin = (req, res, next) => next();

function makeYamaha(overrides = {}) {
  return {
    getIp: () => '',
    getUser: () => '',
    getNat: () => '100',
    getHostFp: () => '',
    hasPass: () => false,
    isReady: () => false,
    configure: () => {},
    reconnect: () => {},
    disconnect: () => {},
    detectYamaha: async () => ({}),
    detectCurrentYamaha: async () => ({}),
    ...overrides,
  };
}

function makeCisco(overrides = {}) {
  return {
    getIp: () => '',
    getUser: () => '',
    getHostFp: () => '',
    hasPass: () => false,
    isReady: () => false,
    configure: () => {},
    reconnect: () => {},
    disconnect: () => {},
    detect: async () => ({}),
    detectCurrent: async () => ({}),
    ...overrides,
  };
}

function makeApp(overrides = {}) {
  const ctx = {
    requireAdmin,
    getAdminToken: () => 'token',
    asus: {
      getRouterIp: () => '192.168.1.1',
      getUser: () => '',
      isEnabled: () => false,
      configure: () => {},
      login: async () => {},
      startPolling: () => {},
      disable: () => {},
    },
    yamaha: makeYamaha(),
    cisco: makeCisco(),
    saveConfig: () => {},
    persistSecret: () => {},
    loadConfig: () => ({}),
    DEFAULT_ROUTER_IP: '192.168.1.1',
    POLL_INTERVAL: 60_000,
    setLatestConnections: () => {},
    appState: {},
    io: null,
    sessions: {},
    authPassword: {},
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', authRoutes(ctx));
  return app;
}

function request(app, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = new Readable({
      read() {
        if (payload) this.push(payload);
        this.push(null);
      },
    });
    req.method = method;
    req.url = path;
    req.headers = {};
    const reqSocket = new PassThrough();
    reqSocket.remoteAddress = '127.0.0.1';
    req.socket = reqSocket;
    req.connection = reqSocket;
    if (payload) {
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(payload.length);
    }

    const res = new http.ServerResponse(req);
    const chunks = [];
    const socket = new Writable({
      write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ status: res.statusCode, body: JSON.parse(text || 'null') });
    });
    app.handle(req, res, reject);
  });
}

describe('auth route: POST /api/login Yamaha setup', () => {
  it('rejects enabling Yamaha when no new or saved password exists', async () => {
    let reconnected = false;
    const app = makeApp({
      yamaha: makeYamaha({
        getIp: () => '192.168.1.1',
        getUser: () => 'admin',
        reconnect: () => { reconnected = true; },
      }),
    });

    const { status, body } = await request(app, 'POST', '/api/login', { doYamaha: true });
    assert.equal(status, 400);
    assert.match(body.error, /Yamaha/);
    assert.equal(reconnected, false);
  });

  it('allows enabling Yamaha when a saved password exists', async () => {
    let reconnected = false;
    const app = makeApp({
      yamaha: makeYamaha({
        getIp: () => '192.168.1.1',
        getUser: () => 'admin',
        hasPass: () => true,
        reconnect: () => { reconnected = true; },
      }),
    });

    const { status, body } = await request(app, 'POST', '/api/login', { doYamaha: true });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(reconnected, true);
  });
});

describe('auth route: POST /api/admin/verify', () => {
  it('rejects unknown token fields with the existing 400 response shape', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/api/admin/verify', { token: 'token', extra: true });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
  it('rejects a non-string token with 400 instead of throwing', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/api/admin/verify', { token: 123 });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /token|トークン|invalid/i);
  });

  it('returns 503 when the admin token is not initialized', async () => {
    const app = makeApp({ getAdminToken: () => '' });
    const { status, body } = await request(app, 'POST', '/api/admin/verify', { token: 'token' });
    assert.equal(status, 503);
    assert.equal(body.ok, false);
  });

  it('accepts a matching admin token', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/api/admin/verify', { token: 'token' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });
});

describe('auth route: session lifecycle', () => {
  it('rejects login before password initialization', async () => {
    const app = makeApp({ appState: {} });
    const { status } = await request(app, 'POST', '/api/auth/login', { password: 'password' });
    assert.equal(status, 503);
  });

  it('rejects empty and oversized login passwords', async () => {
    const base = {
      appState: { authPasswordSalt: 'salt', authPasswordHash: 'hash' },
      authPassword: { verifyPassword: () => true },
      sessions: { createSession: () => null },
    };
    const empty = await request(makeApp(base), 'POST', '/api/auth/login', { password: '' });
    const oversized = await request(makeApp(base), 'POST', '/api/auth/login', { password: 'x'.repeat(257) });
    assert.equal(empty.status, 400);
    assert.equal(oversized.status, 400);
  });

  it('creates a session for a valid password', async () => {
    const app = makeApp({
      appState: { authPasswordSalt: 'salt', authPasswordHash: 'hash' },
      authPassword: { verifyPassword: () => true },
      sessions: {
        createSession: label => ({ id: 7, token: `token-${label}`, expiresAt: 123 }),
      },
    });
    const { status, body } = await request(app, 'POST', '/api/auth/login', {
      password: 'password',
      deviceLabel: 'browser',
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, token: 'token-browser', expiresAt: 123 });
  });

  it('rejects invalid and missing session revocation targets', async () => {
    const app = makeApp({ sessions: { revokeSession: () => false } });
    const invalid = await request(app, 'POST', '/api/auth/sessions/nope/revoke');
    const missing = await request(app, 'POST', '/api/auth/sessions/42/revoke');
    assert.equal(invalid.status, 400);
    assert.equal(missing.status, 404);
  });

  it('lists sessions and marks the caller session as current', async () => {
    const app = makeApp({
      requireAdmin: (req, res, next) => { req.session = { id: 2 }; next(); },
      sessions: { listSessions: () => [{ id: 1 }, { id: 2 }] },
    });
    const { status, body } = await request(app, 'GET', '/api/auth/sessions');
    assert.equal(status, 200);
    assert.deepEqual(body.sessions.map(session => session.current), [false, true]);
  });

  it('keeps the caller session when revoking all other sessions', async () => {
    let keptId;
    const app = makeApp({
      requireAdmin: (req, res, next) => { req.session = { id: 9 }; next(); },
      sessions: { revokeAll: id => { keptId = id; return 3; } },
    });
    const { status, body } = await request(app, 'POST', '/api/auth/sessions/revoke-all', {});
    assert.equal(status, 200);
    assert.equal(keptId, 9);
    assert.equal(body.revoked, 3);
  });
});

describe('auth route: persistence failures', () => {
  it('restores Yamaha runtime state when router settings cannot be saved', async () => {
    const configured = [];
    let disconnects = 0;
    let reconnects = 0;
    const app = makeApp({
      yamaha: makeYamaha({
        getIp: () => '192.168.1.1',
        getUser: () => 'old-user',
        getHostFp: () => 'old-fingerprint',
        getNat: () => '100',
        hasPass: () => true,
        isEnabled: () => true,
        configure: value => { configured.push(value); },
        reconnect: () => { reconnects += 1; },
        disconnect: () => { disconnects += 1; },
      }),
      loadConfig: () => ({ yamaha: { pass: 'old-password' } }),
      saveConfig: () => { throw new Error('disk full'); },
    });

    const { status, body } = await request(app, 'POST', '/api/login', {
      doYamaha: true,
      yamahaIp: '192.168.1.2',
      yamahaUser: 'new-user',
      yamahaPass: 'new-password',
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(disconnects, 1);
    assert.equal(reconnects, 2);
    assert.deepEqual(configured.at(-1), {
      enabled: true,
      ip: '192.168.1.1',
      user: 'old-user',
      pass: 'old-password',
      hostFp: 'old-fingerprint',
      natDescriptor: '100',
    });
  });

  it('does not disable Yamaha when persisting the disabled state fails', async () => {
    let disconnects = 0;
    const app = makeApp({
      yamaha: makeYamaha({ disconnect: () => { disconnects += 1; } }),
      saveConfig: () => { throw new Error('read only'); },
    });

    const { status, body } = await request(app, 'POST', '/api/login', { doYamaha: false });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(disconnects, 0);
  });

  it('rolls back password state and returns 500 when saving fails', async () => {
    const appState = { authPasswordSalt: 'old-salt', authPasswordHash: 'old-hash' }; // pragma: allowlist secret
    const app = makeApp({
      appState,
      authPassword: {
        verifyPassword: () => true,
        hashPassword: () => ({ salt: 'new-salt', hash: 'new-hash' }),
      },
      saveConfig: () => { throw new Error('disk full'); },
      sessions: { revokeAll: () => 0 },
    });

    const { status, body } = await request(app, 'POST', '/api/auth/change-password', {
      currentPassword: 'old-password', // pragma: allowlist secret
      newPassword: 'new-password', // pragma: allowlist secret
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(appState.authPasswordSalt, 'old-salt');
    assert.equal(appState.authPasswordHash, 'old-hash');
  });

  it('rolls back the admin token and returns 500 when saving fails', async () => {
    const appState = { adminToken: 'old-token', authPasswordSalt: 'salt', authPasswordHash: 'hash' }; // pragma: allowlist secret
    const app = makeApp({
      appState,
      authPassword: { verifyPassword: () => true },
      saveConfig: () => { throw new Error('read only'); },
    });

    const { status, body } = await request(app, 'POST', '/api/admin/regenerate-token', {
      currentPassword: 'password', // pragma: allowlist secret
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(appState.adminToken, 'old-token');
  });

  it('restores Cisco runtime state when router settings cannot be saved', async () => {
    const configured = [];
    let disconnects = 0;
    let reconnects = 0;
    const app = makeApp({
      cisco: makeCisco({
        getIp: () => '192.168.1.254',
        getUser: () => 'old-user',
        getHostFp: () => 'old-fingerprint',
        hasPass: () => true,
        isEnabled: () => true,
        configure: value => { configured.push(value); },
        reconnect: () => { reconnects += 1; },
        disconnect: () => { disconnects += 1; },
      }),
      loadConfig: () => ({ cisco: { pass: 'old-password', enablePass: 'old-enable' } }),
      saveConfig: () => { throw new Error('disk full'); },
    });

    const { status, body } = await request(app, 'POST', '/api/login', {
      doCisco: true,
      ciscoIp: '192.168.1.253',
      ciscoUser: 'new-user',
      ciscoPass: 'new-password',
      ciscoEnablePass: 'new-enable',
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(disconnects, 1);
    assert.equal(reconnects, 2);
    assert.deepEqual(configured.at(-1), {
      enabled: true,
      ip: '192.168.1.254',
      user: 'old-user',
      pass: 'old-password',
      enablePass: 'old-enable',
      hostFp: 'old-fingerprint',
    });
  });

  it('does not disconnect Cisco when persisting the disabled state fails', async () => {
    let disconnects = 0;
    const app = makeApp({
      cisco: makeCisco({ disconnect: () => { disconnects += 1; } }),
      saveConfig: () => { throw new Error('read only'); },
    });

    const { status, body } = await request(app, 'POST', '/api/login', { doCisco: false });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(disconnects, 0);
  });

  it('restores ASUS runtime state when router settings cannot be saved', async () => {
    const configured = [];
    const logins = [];
    let disables = 0;
    const app = makeApp({
      asus: {
        getRouterIp: () => '192.168.1.1',
        getUser: () => 'old-user',
        isEnabled: () => true,
        configure: value => { configured.push(value); },
        login: async (...args) => { logins.push(args); },
        startPolling: () => {},
        disable: () => { disables += 1; },
      },
      loadConfig: () => ({ asus: { pass: 'old-password' } }),
      saveConfig: () => { throw new Error('disk full'); },
    });

    const { status, body } = await request(app, 'POST', '/api/login', {
      doAsus: true,
      routerIp: '192.168.1.2',
      username: 'new-user',
      password: 'new-password',
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(disables, 1);
    assert.deepEqual(configured.at(-1), {
      routerIp: '192.168.1.1',
      user: 'old-user',
      pass: 'old-password',
      enabled: true,
    });
    assert.deepEqual(logins.at(-1), ['192.168.1.1', 'old-user', 'old-password']);
  });
});

describe('auth route: connection failures', () => {
  it('returns the Yamaha diagnostic when auto-detection fails', async () => {
    const error = new Error('SSH failed');
    error.diag = { phase: 'connect' };
    const app = makeApp({
      yamaha: makeYamaha({
        detectYamaha: async () => { throw error; },
      }),
    });

    const { status, body } = await request(app, 'POST', '/api/yamaha/detect', {
      yamahaIp: '192.168.1.1',
      yamahaUser: 'admin',
      yamahaPass: 'password',
    });

    assert.equal(status, 502);
    assert.equal(body.success, false);
    assert.deepEqual(body.diag, { phase: 'connect' });
  });

  it('returns the Cisco diagnostic when auto-detection fails', async () => {
    const error = new Error('enable failed');
    error.diag = { phase: 'enable' };
    const app = makeApp({
      cisco: makeCisco({
        detect: async () => { throw error; },
      }),
    });

    const { status, body } = await request(app, 'POST', '/api/cisco/detect', {
      ciscoIp: '192.168.1.254',
      ciscoUser: 'admin',
      ciscoPass: 'password',
    });

    assert.equal(status, 502);
    assert.equal(body.success, false);
    assert.deepEqual(body.diag, { phase: 'enable' });
  });

  it('returns 500 when a valid password cannot create a session', async () => {
    const app = makeApp({
      appState: { authPasswordSalt: 'salt', authPasswordHash: 'hash' },
      authPassword: { verifyPassword: () => true },
      sessions: { createSession: () => null },
    });

    const { status, body } = await request(app, 'POST', '/api/auth/login', { password: 'password' });

    assert.equal(status, 500);
    assert.match(body.error, /session|セッション/i);
  });

  it('returns 401 when ASUS authentication fails', async () => {
    const app = makeApp({
      asus: {
        getRouterIp: () => '192.168.1.1',
        getUser: () => '',
        isEnabled: () => false,
        login: async () => { throw new Error('bad credentials'); },
        startPolling: () => {},
        disable: () => {},
      },
    });
    const { status } = await request(app, 'POST', '/api/login', {
      doAsus: true,
      username: 'admin',
      password: 'password',
    });
    assert.equal(status, 401);
  });

  it('returns 502 when Yamaha runtime initialization fails', async () => {
    const app = makeApp({
      yamaha: makeYamaha({
        getIp: () => '192.168.1.1',
        getUser: () => 'admin',
        hasPass: () => true,
        reconnect: () => { throw new Error('SSH unavailable'); },
      }),
    });
    const { status, body } = await request(app, 'POST', '/api/login', { doYamaha: true });
    assert.equal(status, 502);
    assert.equal(body.success, false);
  });

  it('returns 502 when Cisco runtime initialization fails', async () => {
    const app = makeApp({
      cisco: makeCisco({
        getIp: () => '192.168.1.254',
        getUser: () => 'admin',
        hasPass: () => true,
        reconnect: () => { throw new Error('enable rejected'); },
      }),
    });
    const { status, body } = await request(app, 'POST', '/api/login', { doCisco: true });
    assert.equal(status, 502);
    assert.equal(body.success, false);
  });

  it('rejects setup requests without a target or with an invalid NAT descriptor', async () => {
    const noTarget = await request(makeApp(), 'POST', '/api/login', {});
    const badNat = await request(makeApp(), 'POST', '/api/login', {
      doYamaha: true,
      yamahaNat: 'not-a-number',
    });
    assert.equal(noTarget.status, 400);
    assert.equal(badNat.status, 400);
  });
});
