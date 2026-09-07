'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const connectionsRoutes = require('../../src/routes/connections');
const aiNotificationRoutes = require('../../src/routes/ai-notifications');
const aiRoutes = require('../../src/routes/ai');

// P2-95. These four routes stayed undeclared while every other busy route was
// pinned, for one reason: nothing reached them over HTTP, so a declaration
// would have been a sentence nobody checked. `test/unit/response-contract.test.js`
// pinned their absence for exactly as long as that was true. These requests are
// what makes declaring them honest.

function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      http.get({ port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch (error) { reject(error); }
        });
      }).on('error', (error) => { server.close(); reject(error); });
    });
  });
}

function mountConnections(history) {
  const app = express();
  app.use(express.json());
  app.use('/api', connectionsRoutes({
    requireAdmin: (_req, _res, next) => next(),
    history,
    threatIntel: null,
    devices: { getAll: () => [] },
    routerManager: { list: () => [] },
    agentIdentities: { listAgents: () => [] },
  }));
  return app;
}

describe('宣言できるようにHTTPで叩く（P2-95）', () => {
  it('GET /api/connections が envelope を返す', async () => {
    const app = mountConnections({
      countByTimeRange: () => 1,
      queryByTimeRangePaged: () => [{ src: '192.0.2.10', dst: '198.51.100.7' }],
      listApplicationsForConnections: () => [],
    });
    const { status, body } = await request(app, '/api/connections?limit=10');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.connections));
    for (const key of ['total', 'limit', 'offset', 'serverTime']) {
      assert.equal(typeof body[key], 'number', `${key} が数値でない`);
    }
  });

  it('GET /api/connections/threat-counts が三つの数を返す', async () => {
    const app = mountConnections({
      groupDstByTimeRange: () => [{ dst: '198.51.100.7', dstHost: null, cnt: 3 }],
    });
    const { status, body } = await request(app, '/api/connections/threat-counts');
    assert.equal(status, 200);
    for (const key of ['safe', 'warn', 'danger', 'serverTime']) {
      assert.equal(typeof body[key], 'number', `${key} が数値でない`);
    }
  });

  it('GET /api/ai/notification-events が events を返す', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', aiNotificationRoutes({
      requireAdmin: (_req, _res, next) => next(),
      aiNotificationService: {
        exportConfig: () => ({}),
        publicStatus: () => ({ running: false, provider: 'ollama' }),
        configure: () => ({}),
        testDelivery: async () => ({}),
        run: async () => ({}),
      },
      history: { listAiNotifications: () => [{ id: 'e1' }] },
      saveConfig: () => {},
    }));
    const { status, body } = await request(app, '/api/ai/notification-events');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.events));
  });

  it('GET /api/ai/conversations が conversations と storage を返す', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', aiRoutes({
      requireAdmin: (_req, _res, next) => next(),
      aiProvider: { getPublicConfig: () => ({ provider: 'ollama' }) },
      saveConfig: () => {},
      history: {
        listConversations: () => [{ conversationId: 'c1' }],
        getStorageStats: () => ({ bytes: 0 }),
      },
      threatIntel: null,
      routerManager: { list: () => [] },
      devices: { getAll: () => [] },
      asus: null,
      agentIdentities: { listAgents: () => [] },
      aiBudget: { begin: () => ({ ok: true }), finish: () => {} },
    }));
    const { status, body } = await request(app, '/api/ai/conversations');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.conversations));
    assert.ok(body.storage);
  });
});
