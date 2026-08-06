// Unit tests for src/routes/detection-notifications.js (P2-76)
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const detectionRoutes = require('../../src/routes/detection-notifications');

const requireAdmin = (req, res, next) => next();

function makeNotifier() {
  let state = {
    threat:    { slack: true, history: true },
    newDevice: { slack: true, history: true },
  };
  return {
    getDetectionConfig: () => ({ threat: { ...state.threat }, newDevice: { ...state.newDevice } }),
    configureDetection: (input) => {
      for (const kind of ['threat', 'newDevice']) {
        if (!input?.[kind]) continue;
        if (typeof input[kind].slack === 'boolean') state[kind].slack = input[kind].slack;
        if (typeof input[kind].history === 'boolean') state[kind].history = input[kind].history;
      }
    },
  };
}

function makeApp(overrides = {}) {
  const ctx = {
    notifier:   makeNotifier(),
    saveConfig: () => {},
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', detectionRoutes({ requireAdmin, ...ctx }));
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

// ─── GET /api/config/detection-notifications ─────────────────────────────────

describe('detection-notifications route: GET', () => {
  it('既定値を返す', async () => {
    const app = makeApp();
    const { status, body } = await req(app, 'GET', '/api/config/detection-notifications');
    assert.equal(status, 200);
    assert.deepEqual(body.config, {
      threat:    { slack: true, history: true },
      newDevice: { slack: true, history: true },
    });
  });

  it('未知のクエリを拒否する', async () => {
    const app = makeApp();
    const { status } = await req(app, 'GET', '/api/config/detection-notifications?foo=1');
    assert.equal(status, 400);
  });
});

// ─── POST /api/config/detection-notifications ────────────────────────────────

describe('detection-notifications route: POST', () => {
  it('チャネル単位で更新し、保存後の状態を返す', async () => {
    const app = makeApp();
    const { status, body } = await req(app, 'POST', '/api/config/detection-notifications', {
      newDevice: { slack: false },
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.config.newDevice.slack, false);
    assert.equal(body.config.newDevice.history, true, '履歴は独立して有効なまま');
    assert.equal(body.config.threat.slack, true, '脅威側は影響を受けない');
  });

  it('部分更新は指定しなかったチャネルを変えない', async () => {
    const app = makeApp();
    await req(app, 'POST', '/api/config/detection-notifications', { threat: { history: false } });
    const { body } = await req(app, 'GET', '/api/config/detection-notifications');
    assert.equal(body.config.threat.history, false);
    assert.equal(body.config.threat.slack, true);
  });

  it('未知のキーを拒否する', async () => {
    const app = makeApp();
    const { status } = await req(app, 'POST', '/api/config/detection-notifications', {
      threat: { slack: false }, unknown: true,
    });
    assert.equal(status, 400);
  });

  it('boolean以外の値を拒否する', async () => {
    const app = makeApp();
    const { status } = await req(app, 'POST', '/api/config/detection-notifications', {
      threat: { slack: 'false' },
    });
    assert.equal(status, 400);
  });

  it('保存失敗時は500を返し、設定を元へ戻す', async () => {
    const app = makeApp({ saveConfig: () => { throw new Error('disk full'); } });
    const { status, body } = await req(app, 'POST', '/api/config/detection-notifications', {
      newDevice: { slack: false, history: false },
    });
    assert.equal(status, 500);
    assert.ok(body.error);
    const after = await req(app, 'GET', '/api/config/detection-notifications');
    assert.deepEqual(after.body.config.newDevice, { slack: true, history: true });
  });
});
