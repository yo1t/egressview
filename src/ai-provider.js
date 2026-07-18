'use strict';

const PROVIDERS = Object.freeze(['ollama', 'anthropic', 'openai']);
const CLOUD_PROVIDERS = Object.freeze(['anthropic', 'openai']);
const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function normalizeEndpoint(value) {
  const raw = String(value || DEFAULT_OLLAMA_ENDPOINT).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Ollama endpoint must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Ollama endpoint must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Ollama endpoint must not contain credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function modelIds(body, provider) {
  const rows = provider === 'ollama' ? body?.models : body?.data;
  if (!Array.isArray(rows)) throw new Error('Provider returned an invalid model list');
  return [...new Set(rows.map(row => String(row?.id || row?.model || row?.name || '').trim())
    .filter(id => id && id.length <= 200))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 200);
}

async function readBoundedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('Provider response was too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Provider response was too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readJsonResponse(response) {
  const text = await readBoundedText(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('API key was rejected');
    if (response.status === 429) throw new Error('Provider rate limit exceeded');
    throw new Error(`Provider request failed (${response.status})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Provider returned invalid JSON');
  }
}

function createAiProvider({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  let provider = 'disabled';
  let models = { ollama: '', anthropic: '', openai: '' };
  let keys = { anthropic: '', openai: '' };
  let ollamaEndpoint = DEFAULT_OLLAMA_ENDPOINT;

  function configure(input = {}) {
    if (input.provider !== undefined) {
      if (input.provider !== 'disabled' && !PROVIDERS.includes(input.provider)) {
        throw new Error('Unsupported AI provider');
      }
      provider = input.provider;
    }
    if (input.models) {
      for (const name of PROVIDERS) {
        if (typeof input.models[name] === 'string') models[name] = input.models[name].trim();
      }
    }
    if (input.keys) {
      for (const name of CLOUD_PROVIDERS) {
        if (typeof input.keys[name] === 'string') keys[name] = input.keys[name].trim();
      }
    }
    if (input.ollamaEndpoint !== undefined) ollamaEndpoint = normalizeEndpoint(input.ollamaEndpoint);
  }

  function exportConfig() {
    return {
      provider,
      models: { ...models },
      keys: { ...keys },
      ollamaEndpoint,
    };
  }

  function getPublicConfig() {
    return {
      provider,
      models: { ...models },
      ollamaEndpoint,
      providers: {
        ollama: { keySet: false },
        anthropic: { keySet: !!keys.anthropic },
        openai: { keySet: !!keys.openai },
      },
    };
  }

  async function listModels() {
    if (provider === 'disabled') throw new Error('AI provider is disabled');
    if (CLOUD_PROVIDERS.includes(provider) && !keys[provider]) {
      throw new Error('API key is not configured');
    }
    let url;
    const headers = { Accept: 'application/json' };
    if (provider === 'ollama') {
      url = `${ollamaEndpoint}/api/tags`;
    } else if (provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models?limit=100';
      headers['x-api-key'] = keys.anthropic;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      url = 'https://api.openai.com/v1/models';
      headers.Authorization = `Bearer ${keys.openai}`;
    }
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { provider, models: modelIds(await readJsonResponse(response), provider) };
  }

  return { configure, exportConfig, getPublicConfig, listModels };
}

const aiProvider = createAiProvider();

module.exports = {
  CLOUD_PROVIDERS,
  DEFAULT_OLLAMA_ENDPOINT,
  PROVIDERS,
  aiProvider,
  createAiProvider,
  modelIds,
  normalizeEndpoint,
};
