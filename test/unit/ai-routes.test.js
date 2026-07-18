'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { describe, it } = require('node:test');
const express = require('express');
const aiRoutes = require('../../src/routes/ai');
const { createAiProvider } = require('../../src/ai-provider');

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

function appFor(aiProvider, saveConfig = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', aiRoutes({ requireAdmin, aiProvider, saveConfig }));
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
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.provider, 'anthropic');
    assert.equal(saved.body.providers.anthropic.keySet, true);
    assert.equal(JSON.stringify(saved.body).includes('secret-key'), false);

    const loaded = await request(app, 'GET', '/api/config/ai');
    assert.equal(loaded.status, 200);
    assert.equal(JSON.stringify(loaded.body).includes('secret-key'), false);
  });

  it('rolls runtime configuration back when persistence fails', async () => {
    const aiProvider = createAiProvider();
    aiProvider.configure({ provider: 'ollama', models: { ollama: 'old-model' } });
    const app = appFor(aiProvider, () => { throw new Error('disk full'); });
    const result = await request(app, 'POST', '/api/config/ai', {
      provider: 'openai', keys: { openai: 'new-secret' }, models: { openai: 'new-model' },
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

  it('rejects test payload fields and disabled providers before fetching', async () => {
    let calls = 0;
    const aiProvider = createAiProvider({ fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
    const app = appFor(aiProvider);
    const fields = await request(app, 'POST', '/api/ai/test', { apiKey: 'must-not-be-accepted' });
    const disabled = await request(app, 'POST', '/api/ai/test', {});
    assert.equal(fields.status, 400);
    assert.equal(disabled.status, 400);
    assert.equal(calls, 0);
  });
});
