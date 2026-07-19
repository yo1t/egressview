'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { describe, it } = require('node:test');
const express = require('express');
const aiRoutes = require('../../src/routes/ai');
const { createAiProvider } = require('../../src/ai-provider');
const historyStore = require('../../src/history');

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
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ status: res.statusCode, body: JSON.parse(text || 'null') });
    });
    app.handle(req, res, reject);
  });
}

function appFor(aiProvider, saveConfig = () => {}, overrides = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', aiRoutes({ requireAdmin, aiProvider, saveConfig, ...overrides }));
  return app;
}

describe('AI configuration routes', () => {
  it('stores provider settings without returning secret values', async () => {
    const aiProvider = createAiProvider();
    const app = appFor(aiProvider);
    const saved = await request(app, 'POST', '/api/config/ai', {
      provider: 'anthropic',
      models: { anthropic: 'claude-test' },
      keys: { anthropic: 'secret-key' },
      cloudConsent: { anthropic: true },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.provider, 'anthropic');
    assert.equal(saved.body.providers.anthropic.keySet, true);
    assert.equal(JSON.stringify(saved.body).includes('secret-key'), false);

    const loaded = await request(app, 'GET', '/api/config/ai');
    assert.equal(loaded.status, 200);
    assert.equal(JSON.stringify(loaded.body).includes('secret-key'), false);
  });

  it('requires cloud consent when saving and again when analyzing', async () => {
    const provider = createAiProvider({ fetchImpl: async () =>
      new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 }) });
    const app = appFor(provider, undefined, {
      history: {
        countFactsByTimeRange: () => ({}), groupDstByTimeRange: () => [], groupServiceByTimeRange: () => [],
      },
      threatIntel: null,
      routerManager: { list: () => [] },
    });
    const deniedSave = await request(app, 'POST', '/api/config/ai', {
      provider: 'openai', models: { openai: 'gpt-test' }, keys: { openai: 'secret-key' },
    });
    assert.equal(deniedSave.status, 400);
    const saved = await request(app, 'POST', '/api/config/ai', {
      provider: 'openai', models: { openai: 'gpt-test' }, keys: { openai: 'secret-key' },
      cloudConsent: { openai: true },
    });
    assert.equal(saved.status, 200);
    assert.equal((await request(app, 'POST', '/api/ai/analyze', { from: 1, to: 2 })).status, 403);
    assert.equal((await request(app, 'POST', '/api/ai/analyze', {
      from: 1, to: 2, cloudConsentConfirmed: true,
    })).status, 200);
  });

  it('rolls runtime configuration back when persistence fails', async () => {
    const aiProvider = createAiProvider();
    aiProvider.configure({ provider: 'ollama', models: { ollama: 'old-model' } });
    const app = appFor(aiProvider, () => { throw new Error('disk full'); });
    const result = await request(app, 'POST', '/api/config/ai', {
      provider: 'openai', keys: { openai: 'new-secret' }, models: { openai: 'new-model' },
      cloudConsent: { openai: true },
    });
    assert.equal(result.status, 500);
    assert.equal(aiProvider.exportConfig().provider, 'ollama');
    assert.equal(aiProvider.exportConfig().models.ollama, 'old-model');
    assert.equal(aiProvider.exportConfig().keys.openai, '');
  });

  it('rejects unknown fields and unsafe endpoints without persisting', async () => {
    let saves = 0;
    const aiProvider = createAiProvider();
    const app = appFor(aiProvider, () => { saves++; });
    const unknown = await request(app, 'POST', '/api/config/ai', { provider: 'disabled', surprise: true });
    const endpoint = await request(app, 'POST', '/api/config/ai', {
      provider: 'ollama', ollamaEndpoint: 'file:///tmp/socket',
    });
    assert.equal(unknown.status, 400);
    assert.equal(endpoint.status, 400);
    assert.equal(saves, 0);
    assert.equal(aiProvider.exportConfig().provider, 'disabled');
  });

  it('tests only the saved provider and returns bounded model IDs', async () => {
    let calls = 0;
    const aiProvider = createAiProvider({
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 });
      },
    });
    aiProvider.configure({ provider: 'ollama' });
    const result = await request(appFor(aiProvider), 'POST', '/api/ai/test', {});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.models, ['qwen3:8b']);
    assert.equal(calls, 1);
  });

  it('discovers Bedrock models for a selected region without running inference', async () => {
    const calls = [];
    const aiProvider = createAiProvider({ bedrock: {
      listModels: async args => { calls.push(args); return ['jp.anthropic.claude-test']; },
      converse: async () => { throw new Error('must not run inference'); },
    } });
    const result = await request(appFor(aiProvider), 'POST', '/api/ai/models', {
      region: 'ap-northeast-1',
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.models, ['jp.anthropic.claude-test']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].region, 'ap-northeast-1');
    assert.equal(aiProvider.getPublicConfig().provider, 'disabled');
  });

  it('rejects test payload fields and disabled providers before fetching', async () => {
    let calls = 0;
    const aiProvider = createAiProvider({ fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
    const app = appFor(aiProvider);
    const forbiddenCredential = ['must', 'not', 'be', 'accepted'].join('-');
    const fields = await request(app, 'POST', '/api/ai/test', { apiKey: forbiddenCredential });
    const disabled = await request(app, 'POST', '/api/ai/test', {});
    assert.equal(fields.status, 400);
    assert.equal(disabled.status, 400);
    assert.equal(calls, 0);
  });

  it('returns a bounded facts snapshot for the requested period', async () => {
    const ranges = [];
    const history = {
      countFactsByTimeRange(from, to) { ranges.push([from, to]); return { connections: 1, devices: 1, destinations: 1 }; },
      groupDstByTimeRange: () => [],
    };
    const routerManager = { list: () => [{ id: 'r1', kind: 'yamaha', enabled: true, ready: true }] };
    const result = await request(appFor(createAiProvider(), undefined, {
      history, threatIntel: null, routerManager,
    }), 'GET', '/api/ai/facts?from=1000&to=2000');
    assert.equal(result.status, 200);
    assert.equal(result.body.collection.health, 'ok');
    assert.deepEqual(ranges, [[1000, 2000], [0, 1000]]);
  });

  it('rejects invalid or excessive facts ranges before querying history', async () => {
    let calls = 0;
    const context = {
      history: { countFactsByTimeRange: () => { calls++; return {}; }, groupDstByTimeRange: () => [] },
      routerManager: { list: () => [] },
    };
    const app = appFor(createAiProvider(), undefined, context);
    assert.equal((await request(app, 'GET', '/api/ai/facts?from=2000&to=1000')).status, 400);
    assert.equal((await request(app, 'GET', '/api/ai/facts?from=0&to=9999999999999')).status, 400);
    assert.equal((await request(app, 'GET', '/api/ai/facts')).status, 400);
    assert.equal(calls, 0);
  });

  it('generates an Ollama insight from anonymized aggregates', async () => {
    let context;
    const provider = createAiProvider({ fetchImpl: async (_url, options) => {
      context = JSON.parse(JSON.parse(options.body).prompt.split('\n\n').at(-1));
      return new Response(JSON.stringify({ response: '確認結果' }), { status: 200 });
    } });
    provider.configure({ provider: 'ollama', models: { ollama: 'local-model' } });
    const result = await request(appFor(provider, undefined, {
      history: {
        countFactsByTimeRange: () => ({ connections: 1, devices: 1, destinations: 1 }),
        groupDstByTimeRange: () => [],
        groupServiceByTimeRange: () => [{ dport: 443, proto: 'tcp', count: 1 }],
      },
      threatIntel: null,
      routerManager: { list: () => [{ id: 'secret-id', displayName: 'secret-name', kind: 'cisco', enabled: true, ready: true }] },
    }), 'POST', '/api/ai/analyze', { from: 1000, to: 2000 });
    assert.equal(result.status, 200);
    assert.equal(result.body.text, '確認結果');
    assert.equal(JSON.stringify(context).includes('secret-name'), false);
    assert.deepEqual(context.topServices, [{ port: 443, protocol: 'tcp', connections: 1 }]);
  });

  it('persists chat messages, restores them through the API, and deduplicates retries', async () => {
    historyStore._initForTest();
    const provider = createAiProvider({ fetchImpl: async () =>
      new Response(JSON.stringify({ response: 'persisted answer' }), { status: 200 }) });
    provider.configure({ provider: 'ollama', models: { ollama: 'local-model' } });
    const app = appFor(provider, undefined, {
      history: historyStore,
      threatIntel: null,
      routerManager: { list: () => [] },
    });
    const requestId = '11111111-1111-4111-8111-111111111111';
    const sent = await request(app, 'POST', '/api/ai/chat', {
      requestId, message: 'What changed?', from: 1000, to: 2000,
    });
    assert.equal(sent.status, 200);
    const conversationId = sent.body.conversationId;
    const loaded = await request(app, 'GET', `/api/ai/conversations/${conversationId}`);
    assert.deepEqual(loaded.body.messages.map(message => message.body), ['What changed?', 'persisted answer']);

    const retried = await request(app, 'POST', '/api/ai/chat', {
      conversationId, requestId, message: 'replacement', from: 1000, to: 2000,
    });
    assert.equal(retried.status, 200);
    const afterRetry = await request(app, 'GET', `/api/ai/conversations/${conversationId}`);
    assert.equal(afterRetry.body.messages.length, 2);
    assert.equal(afterRetry.body.messages[0].body, 'What changed?');
    assert.equal((await request(app, 'DELETE', `/api/ai/conversations/${conversationId}`)).status, 200);
    assert.equal((await request(app, 'GET', `/api/ai/conversations/${conversationId}`)).status, 404);
  });
});
