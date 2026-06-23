// Unit tests for src/routes/auth.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
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
