// Unit tests for src/routes/notification-log.js
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const notificationLogRoutes = require('../../src/routes/notification-log');

const requireAdmin = (req, res, next) => next();

const SAMPLE_LOGS = [
  { id: 1, type: 'threat', src: '192.168.1.10', ts: 1000 },
  { id: 2, type: 'new-node', src: '192.168.1.20', ts: 2000 },
];

function makeApp(historyMock) {
  const app = express();
  app.use(express.json());
  app.use('/api', notificationLogRoutes({ requireAdmin, history: historyMock }));
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
    // Express grafts http.IncomingMessage.prototype onto this object, so destroying
    // the stream would run IncomingMessage._destroy against a request that has none
    // of the internal fields that method assumes. Since Node 26.7.0 its abort path
    // detaches a listener from an undefined socket and throws. This is a plain
    // Readable standing in for a request, so give it a plain teardown.
    req._destroy = (error, done) => done(error);
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ status: res.statusCode, body: JSON.parse(text || 'null') });
    });
    app.handle(req, res, reject);
  });
}

describe('notification-log route: GET /api/notification-log', () => {
  let app;
  let capturedFrom, capturedTo;

  before(() => {
    app = makeApp({
      queryNotificationLog: (from, to) => {
        capturedFrom = from;
        capturedTo   = to;
        return SAMPLE_LOGS;
      },
    });
  });

  it('returns logs array and serverTime', async () => {
    const { status, body } = await request(app, 'GET', '/api/notification-log');
    assert.equal(status, 200);
    assert.deepEqual(body.logs, SAMPLE_LOGS);
    assert.ok(typeof body.serverTime === 'number', 'serverTime should be a number');
  });

  it('passes from/to timestamps to queryNotificationLog', async () => {
    await request(app, 'GET', '/api/notification-log?from=1000&to=2000');
    assert.equal(capturedFrom, 1000);
    assert.equal(capturedTo,   2000);
  });

  it('passes null when from/to are omitted', async () => {
    await request(app, 'GET', '/api/notification-log');
    assert.equal(capturedFrom, null);
    assert.equal(capturedTo,   null);
  });

  it('treats empty string from/to as null (no error)', async () => {
    const { status } = await request(app, 'GET', '/api/notification-log?from=&to=');
    assert.equal(status, 200);
  });

  it('returns 400 for non-numeric from', async () => {
    const { status, body } = await request(app, 'GET', '/api/notification-log?from=abc');
    assert.equal(status, 400);
    assert.match(body.error, /from/);
  });

  it('returns 400 for non-numeric to', async () => {
    const { status, body } = await request(app, 'GET', '/api/notification-log?to=not-a-number');
    assert.equal(status, 400);
    assert.match(body.error, /to/);
  });

  it('accepts numeric string timestamps', async () => {
    const { status } = await request(app, 'GET', '/api/notification-log?from=1700000000000');
    assert.equal(status, 200);
  });

  it('rejects unknown, repeated, and oversized query values', async () => {
    assert.equal((await request(app, 'GET', '/api/notification-log?extra=1')).status, 400);
    assert.equal((await request(app, 'GET', '/api/notification-log?from=1&from=2')).status, 400);
    assert.equal((await request(app, 'GET', `/api/notification-log?from=${'1'.repeat(21)}`)).status, 400);
  });
});
