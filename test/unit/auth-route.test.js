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

function makeApp(overrides = {}) {
  const ctx = {
    requireAdmin,
    getAdminToken: () => 'token',
    asus: {
      getRouterIp: () => '192.168.1.1',
      getUser: () => '',
      login: async () => {},
      startPolling: () => {},
      disable: () => {},
    },
    yamaha: makeYamaha(),
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
  it('rejects a non-string token with 400 instead of throwing', async () => {
    const app = makeApp();
    const { status, body } = await request(app, 'POST', '/api/admin/verify', { token: 123 });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /token|トークン|invalid/i);
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
    const appState = { authPasswordSalt: 'old-salt', authPasswordHash: 'old-hash' };
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
      currentPassword: 'old-password',
      newPassword: 'new-password',
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(appState.authPasswordSalt, 'old-salt');
    assert.equal(appState.authPasswordHash, 'old-hash');
  });

  it('rolls back the admin token and returns 500 when saving fails', async () => {
    const appState = { adminToken: 'old-token', authPasswordSalt: 'salt', authPasswordHash: 'hash' };
    const app = makeApp({
      appState,
      authPassword: { verifyPassword: () => true },
      saveConfig: () => { throw new Error('read only'); },
    });

    const { status, body } = await request(app, 'POST', '/api/admin/regenerate-token', {
      currentPassword: 'password',
    });

    assert.equal(status, 500);
    assert.match(body.error, /not saved/i);
    assert.equal(appState.adminToken, 'old-token');
  });
});
