'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const notesRoutes = require('../../src/routes/notes');

const requireAdmin = (_req, _res, next) => next();

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
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
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

function makeApp(overrides = {}) {
  const values = new Map();
  const notes = {
    getAll: () => Object.fromEntries(values),
    snapshot: () => Object.fromEntries(values),
    restore: snapshot => {
      values.clear();
      for (const [key, value] of Object.entries(snapshot)) values.set(key, value);
    },
    isSafeKey: key => typeof key === 'string' && /^(?:device-[\w-]+|192\.168\.1\.\d+)$/.test(key),
    get: key => values.get(key),
    set: (key, value) => values.set(key, value),
    del: key => values.delete(key),
    clearByIpMac: () => {},
    save: () => {},
  };
  const ctx = {
    requireAdmin,
    notes,
    devices: { getByIp: () => null, getByMac: () => [] },
    io: { emit: () => {} },
    yamaha: { isReady: () => false, isEnabled: () => false },
    deviceId: {
      getOuiDb: () => new Map(),
      investigateIp: async ip => ({ ip, summary: 'ok' }),
    },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', notesRoutes(ctx));
  return { app, notes: ctx.notes };
}

describe('notes routes: zod request validation', () => {
  it('rejects unknown list query fields', async () => {
    const { app } = makeApp();
    assert.equal((await request(app, 'GET', '/api/notes?extra=1')).status, 400);
  });

  it('keeps the legacy note write contract for valid input', async () => {
    const { app, notes } = makeApp();
    const result = await request(app, 'POST', '/api/notes', {
      ip: '192.168.1.10', note: '  trusted device  ',
    });
    assert.equal(result.status, 200);
    assert.equal(notes.get('192.168.1.10'), 'trusted device');
  });

  it('returns 500 and restores runtime state when persistence fails', async () => {
    let emitted = 0;
    const { app, notes } = makeApp({
      io: { emit: () => { emitted++; } },
    });
    notes.set('192.168.1.10', 'before');
    notes.save = () => { throw new Error('disk full'); };

    const result = await request(app, 'POST', '/api/notes', {
      ip: '192.168.1.10', note: 'after',
    });

    assert.equal(result.status, 500);
    assert.equal(notes.get('192.168.1.10'), 'before');
    assert.equal(emitted, 0);
  });

  it('rejects unknown, object, and oversized note fields before saving', async () => {
    let saves = 0;
    const { app } = makeApp({
      notes: {
        getAll: () => ({}), isSafeKey: () => true, get: () => null,
        snapshot: () => ({}), restore: () => {},
        set: () => {}, del: () => {}, clearByIpMac: () => {},
        save: () => { saves++; },
      },
    });
    assert.equal((await request(app, 'POST', '/api/notes', {
      ip: '192.168.1.10', note: 'ok', extra: true,
    })).status, 400);
    assert.equal((await request(app, 'POST', '/api/notes', {
      ip: {}, note: 'ok',
    })).status, 400);
    assert.equal((await request(app, 'POST', '/api/notes', {
      ip: '192.168.1.10', note: 'x'.repeat(501),
    })).status, 400);
    assert.equal(saves, 0);
  });

  it('validates investigation IP bodies before invoking the investigator', async () => {
    let calls = 0;
    const { app } = makeApp({
      deviceId: {
        getOuiDb: () => new Map(),
        investigateIp: async ip => { calls++; return { ip }; },
      },
    });
    assert.equal((await request(app, 'POST', '/api/notes/draft', { ip: '192.168.1.10' })).status, 200);
    assert.equal((await request(app, 'POST', '/api/notes/draft', { ip: ['192.168.1.10'] })).status, 400);
    assert.equal((await request(app, 'POST', '/api/notes/draft', {
      ip: '192.168.1.10', extra: true,
    })).status, 400);
    assert.equal((await request(app, 'POST', '/api/notes/draft', { ip: '8.8.8.8' })).status, 400);
    assert.equal(calls, 1);
  });
});
