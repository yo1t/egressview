'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_OLLAMA_ENDPOINT,
  createAiProvider,
  normalizeEndpoint,
} = require('../../src/ai-provider');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AI provider configuration', () => {
  it('starts disabled and never exposes API key values', () => {
    const provider = createAiProvider();
    provider.configure({ provider: 'anthropic', keys: { anthropic: 'secret-value' }, models: { anthropic: 'claude-test' } });
    const publicConfig = provider.getPublicConfig();
    assert.equal(publicConfig.provider, 'anthropic');
    assert.equal(publicConfig.providers.anthropic.keySet, true);
    assert.equal(publicConfig.models.anthropic, 'claude-test');
    assert.equal(JSON.stringify(publicConfig).includes('secret-value'), false);
  });

  it('validates and normalizes only http(s) Ollama endpoints', () => {
    assert.equal(normalizeEndpoint('http://localhost:11434/'), 'http://localhost:11434');
    assert.equal(normalizeEndpoint(''), DEFAULT_OLLAMA_ENDPOINT);
    assert.throws(() => normalizeEndpoint('file:///tmp/ollama'), /http or https/);
    const endpointWithCredentials = ['http://user', ':', 'pass@localhost:11434'].join('');
    assert.throws(() => normalizeEndpoint(endpointWithCredentials), /credentials/);
    assert.throws(() => normalizeEndpoint('http://localhost:11434?token=x'), /query/);
  });
});

describe('AI provider model discovery', () => {
  it('lists Ollama models without credentials', async () => {
    let request;
    const provider = createAiProvider({
      fetchImpl: async (url, options) => {
        request = { url, options };
        return jsonResponse({ models: [{ name: 'qwen3:8b' }, { model: 'llama3.2:latest' }] });
      },
    });
    provider.configure({ provider: 'ollama', ollamaEndpoint: 'http://ollama.local:11434/' });
    const result = await provider.listModels();
    assert.deepEqual(result.models, ['llama3.2:latest', 'qwen3:8b']);
    assert.equal(request.url, 'http://ollama.local:11434/api/tags');
    assert.equal(request.options.headers.Authorization, undefined);
  });

  it('uses provider-specific cloud authentication without returning keys', async () => {
    const requests = [];
    const provider = createAiProvider({
      fetchImpl: async (url, options) => {
        requests.push({ url, headers: options.headers });
        return jsonResponse({ data: [{ id: url.includes('anthropic') ? 'claude-test' : 'gpt-test' }] });
      },
    });
    provider.configure({ provider: 'anthropic', keys: { anthropic: 'anthropic-secret', openai: 'openai-secret' } });
    assert.deepEqual((await provider.listModels()).models, ['claude-test']);
    provider.configure({ provider: 'openai' });
    assert.deepEqual((await provider.listModels()).models, ['gpt-test']);
    assert.equal(requests[0].headers['x-api-key'], 'anthropic-secret');
    assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(requests[1].headers.Authorization, 'Bearer openai-secret');
  });

  it('fails before fetching when disabled or a cloud key is missing', async () => {
    let calls = 0;
    const provider = createAiProvider({ fetchImpl: async () => { calls++; return jsonResponse({}); } });
    await assert.rejects(provider.listModels(), /disabled/);
    provider.configure({ provider: 'openai' });
    await assert.rejects(provider.listModels(), /API key is not configured/);
    assert.equal(calls, 0);
  });

  it('bounds model results and rejects unsafe provider responses', async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({ id: `model-${index}` }));
    const bounded = createAiProvider({ fetchImpl: async () => jsonResponse({ data: many }) });
    bounded.configure({ provider: 'openai', keys: { openai: 'key' } });
    assert.equal((await bounded.listModels()).models.length, 200);

    const invalid = createAiProvider({ fetchImpl: async () => new Response('not-json', { status: 200 }) });
    invalid.configure({ provider: 'ollama' });
    await assert.rejects(invalid.listModels(), /invalid JSON/);

    const huge = createAiProvider({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }) });
    huge.configure({ provider: 'ollama' });
    await assert.rejects(huge.listModels(), /too large/);
  });

  it('normalizes authentication and rate limit errors', async () => {
    const rejected = createAiProvider({ fetchImpl: async () => jsonResponse({}, 401) });
    rejected.configure({ provider: 'anthropic', keys: { anthropic: 'bad' } });
    await assert.rejects(rejected.listModels(), /API key was rejected/);

    const limited = createAiProvider({ fetchImpl: async () => jsonResponse({}, 429) });
    limited.configure({ provider: 'openai', keys: { openai: 'key' } });
    await assert.rejects(limited.listModels(), /rate limit/);
  });
});

describe('AI insight generation', () => {
  it('sends a bounded non-streaming request and returns display metadata', async () => {
    let request;
    const provider = createAiProvider({ fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ response: '概要\n異常なし' });
    } });
    provider.configure({ provider: 'ollama', models: { ollama: 'qwen3:8b' }, ollamaEndpoint: 'http://ollama:11434' });
    const result = await provider.generateInsight({ current: { connections: 4 } });
    assert.equal(request.url, 'http://ollama:11434/api/generate');
    assert.equal(JSON.parse(request.options.body).stream, false);
    assert.equal(result.provider, 'ollama');
    assert.equal(result.model, 'qwen3:8b');
    assert.match(result.text, /異常なし/);
  });

  it('requires explicit cloud consent and limits concurrent work', async () => {
    const cloud = createAiProvider();
    cloud.configure({ provider: 'openai', models: { openai: 'gpt-test' }, keys: { openai: 'key' } });
    await assert.rejects(cloud.generateInsight({}), error => error.code === 'AI_CONSENT_REQUIRED');

    let release;
    const provider = createAiProvider({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
    provider.configure({ provider: 'ollama', models: { ollama: 'model' } });
    const first = provider.generateInsight({});
    await assert.rejects(provider.generateInsight({}), error => error.code === 'AI_BUSY');
    release(jsonResponse({ response: 'ok' }));
    await first;
  });

  it('uses the official Anthropic and OpenAI generation APIs after double consent', async () => {
    const requests = [];
    const provider = createAiProvider({ fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('anthropic')) return jsonResponse({ content: [{ type: 'text', text: 'Claude result' }] });
      return jsonResponse({ output_text: 'OpenAI result' });
    } });
    provider.configure({
      provider: 'anthropic', models: { anthropic: 'claude-test', openai: 'gpt-test' },
      keys: { anthropic: 'anthropic-key', openai: 'openai-key' },
      cloudConsent: { anthropic: true, openai: true },
    });
    assert.equal((await provider.generateInsight({}, { cloudConsentConfirmed: true })).text, 'Claude result');
    provider.configure({ provider: 'openai' });
    assert.equal((await provider.generateInsight({}, { cloudConsentConfirmed: true })).text, 'OpenAI result');
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(requests[0].options.headers['x-api-key'], 'anthropic-key');
    assert.equal(requests[1].url, 'https://api.openai.com/v1/responses');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer openai-key');
  });
});
