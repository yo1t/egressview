'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { describe, it } = require('node:test');
const routes = require('../../src/routes/ai-notifications');

const requireAdmin = (_req, _res, next) => next();

function request(app, method, url, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = new Readable({ read() { if (payload) this.push(payload); this.push(null); } });
    req.method = method;
    req.url = url;
    req.headers = payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {};
    const res = new http.ServerResponse(req);
    const chunks = [];
    const socket = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      resolve({
        status: res.statusCode,
        body: JSON.parse(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') || 'null'),
      });
    });
    app.handle(req, res, reject);
  });
}

function makeApp(overrides = {}) {
  let config = {
    frequency: 'off',
    weekday: 1,
    time: '09:00',
    timezone: 'Asia/Tokyo',
    rangeHours: 168,
    destinations: { ui: true, slack: false },
    threat: {
      enabled: false,
      dangerThreshold: 1,
      newDestinationsThreshold: 1,
      increaseThreshold: 3,
    },
    dailyLimit: 3,
    cooldownMinutes: 60,
    automationConsent: false,
  };
  const aiNotificationService = {
    exportConfig: () => structuredClone(config),
    publicStatus: () => ({ running: false, provider: 'ollama' }),
    configure: value => { config = structuredClone(value); return config; },
    testDelivery: async () => ({ triggerType: 'test' }),
    run: async () => ({ triggerType: 'manual' }),
    ...overrides.service,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', routes({
    requireAdmin,
    aiNotificationService,
    history: { listAiNotifications: () => [], ...overrides.history },
    saveConfig: overrides.saveConfig || (() => {}),
  }));
  return app;
}

describe('AI notification routes', () => {
  it('saves a complete validated configuration', async () => {
    const payload = {
      frequency: 'weekly',
      weekday: 1,
      time: '09:30',
      timezone: 'Asia/Tokyo',
      rangeHours: 168,
      destinations: { ui: true, slack: false },
      rules: { scheduled: true, danger: true, newDestination: false, increase: true },
      threat: {
        enabled: true,
        dangerThreshold: 1,
        newDestinationsThreshold: 2,
        increaseThreshold: 3,
      },
      dailyLimit: 3,
      cooldownMinutes: 60,
      automationConsent: false,
    };
    const result = await request(makeApp(), 'POST', '/api/ai/notification-config', payload);
    assert.equal(result.status, 200);
    assert.equal(result.body.config.frequency, 'weekly');
    assert.equal(result.body.config.rules.newDestination, false);
  });

  it('rejects unknown fields and missing destinations', async () => {
    const app = makeApp();
    assert.equal((await request(app, 'POST', '/api/ai/notification-config', { extra: true })).status, 400);
  });

  it('requires saved consent for cloud automation', async () => {
    const app = makeApp({ service: {
      publicStatus: () => ({ running: false, provider: 'bedrock' }),
    } });
    const current = (await request(app, 'GET', '/api/ai/notification-config')).body.config;
    current.frequency = 'daily';
    const result = await request(app, 'POST', '/api/ai/notification-config', current);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /consent/i);
  });

  it('rejects Slack delivery when the saved channel is incomplete', async () => {
    const app = makeApp({ service: {
      publicStatus: () => ({ running: false, provider: 'ollama', slackReady: false }),
    } });
    const current = (await request(app, 'GET', '/api/ai/notification-config')).body.config;
    current.destinations = { ui: true, slack: true };
    const result = await request(app, 'POST', '/api/ai/notification-config', current);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /Slack notification settings are incomplete/);
  });

  it('does not expose or reuse consent bound to another provider', async () => {
    const app = makeApp({ service: {
      exportConfig: () => ({
        frequency: 'daily',
        weekday: 1,
        time: '09:00',
        timezone: 'Asia/Tokyo',
        rangeHours: 168,
        destinations: { ui: true, slack: false },
        threat: {
          enabled: false,
          dangerThreshold: 1,
          newDestinationsThreshold: 1,
          increaseThreshold: 3,
        },
        dailyLimit: 3,
        cooldownMinutes: 60,
        automationConsent: true,
        automationProvider: 'anthropic',
      }),
      publicStatus: () => ({ running: false, provider: 'openai', automationReady: false }),
    } });

    const result = await request(app, 'GET', '/api/ai/notification-config');
    assert.equal(result.body.config.automationConsent, false);
    assert.equal('automationProvider' in result.body.config, false);
  });

  it('rolls runtime config back when persistence fails', async () => {
    const app = makeApp({ saveConfig: () => { throw new Error('disk full'); } });
    const current = (await request(app, 'GET', '/api/ai/notification-config')).body.config;
    current.time = '10:00';
    assert.equal((await request(app, 'POST', '/api/ai/notification-config', current)).status, 500);
    const after = await request(app, 'GET', '/api/ai/notification-config');
    assert.equal(after.body.config.time, '09:00');
  });
});
