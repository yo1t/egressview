'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { describe, it } = require('node:test');
const routes = require('../../src/routes/ai-notifications');
const { normalizeConfig } = require('../../src/ai-notification-service');

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
    // Express grafts http.IncomingMessage.prototype onto this object, so destroying
    // the stream would run IncomingMessage._destroy against a request that has none
    // of the internal fields that method assumes. Since Node 26.7.0 its abort path
    // detaches a listener from an undefined socket and throws. This is a plain
    // Readable standing in for a request, so give it a plain teardown.
    req._destroy = (error, done) => done(error);
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
  // The service's own normalization, not a hand-copied literal. A stub that
  // omits `rules` or `automationProvider` describes a config the running Hub
  // never holds, and a response contract declared from the handler would then
  // be measured against the wrong thing.
  let config = normalizeConfig({});
  const aiNotificationService = {
    exportConfig: () => structuredClone(config),
    publicStatus: () => ({
      running: false, provider: 'ollama', automationReady: true, slackReady: false,
    }),
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
      publicStatus: () => ({
        running: false, provider: 'bedrock', automationReady: false, slackReady: false,
      }),
    } });
    const current = (await request(app, 'GET', '/api/ai/notification-config')).body.config;
    current.frequency = 'daily';
    // A schedule is what makes this automation: the rules decide, not the
    // frequency, and a saved config that has never been automated carries
    // them all off.
    current.rules = { ...current.rules, scheduled: true };
    const result = await request(app, 'POST', '/api/ai/notification-config', current);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /consent/i);
  });

  it('rejects Slack delivery when the saved channel is incomplete', async () => {
    const app = makeApp({ service: {
      publicStatus: () => ({
        running: false, provider: 'ollama', automationReady: true, slackReady: false,
      }),
    } });
    const current = (await request(app, 'GET', '/api/ai/notification-config')).body.config;
    current.destinations = { ui: true, slack: true };
    const result = await request(app, 'POST', '/api/ai/notification-config', current);
    assert.equal(result.status, 400);
    assert.match(result.body.error, /Slack notification settings are incomplete/);
  });

  it('does not expose or reuse consent bound to another provider', async () => {
    const app = makeApp({ service: {
      exportConfig: () => normalizeConfig({
        frequency: 'daily',
        automationConsent: true,
        automationProvider: 'anthropic',
      }),
      publicStatus: () => ({
        running: false, provider: 'openai', automationReady: false, slackReady: false,
      }),
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
