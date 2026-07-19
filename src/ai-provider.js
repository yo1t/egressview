'use strict';

const PROVIDERS = Object.freeze(['ollama', 'anthropic', 'openai']);
const CLOUD_PROVIDERS = Object.freeze(['anthropic', 'openai']);
const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const GENERATE_TIMEOUT_MS = 30_000;
const MAX_PROMPT_BYTES = 64 * 1024;

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

// ─── Provider adapters ─────────────────────────────────────────────────────────
// Each adapter only supplies provider-specific request shapes and response
// parsing. The shared orchestration (disabled/key/consent/single-flight checks,
// timeouts, error mapping) stays in createAiProvider so behavior is uniform.
//
// `transport: 'fetch'` adapters go through the injected fetchImpl. Future
// non-fetch providers (e.g. Amazon Bedrock via the AWS SDK) will register with a
// different transport and their own invoke seam.
const ADAPTERS = Object.freeze({
  ollama: {
    transport: 'fetch',
    needsKey: false,
    needsConsent: false,
    listRequest: state => ({ url: `${state.ollamaEndpoint}/api/tags`, headers: { Accept: 'application/json' } }),
    generateRequest: (state, prompt) => ({
      url: `${state.ollamaEndpoint}/api/generate`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: { model: state.models.ollama, stream: false, prompt },
    }),
    parseText: body => body?.response,
  },
  anthropic: {
    transport: 'fetch',
    needsKey: true,
    needsConsent: true,
    listRequest: state => ({
      url: 'https://api.anthropic.com/v1/models?limit=100',
      headers: { Accept: 'application/json', 'x-api-key': state.keys.anthropic, 'anthropic-version': '2023-06-01' },
    }),
    generateRequest: (state, prompt) => ({
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        'x-api-key': state.keys.anthropic, 'anthropic-version': '2023-06-01',
      },
      body: { model: state.models.anthropic, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] },
    }),
    parseText: body => body?.content?.find(item => item?.type === 'text')?.text,
  },
  openai: {
    transport: 'fetch',
    needsKey: true,
    needsConsent: true,
    listRequest: state => ({
      url: 'https://api.openai.com/v1/models',
      headers: { Accept: 'application/json', Authorization: `Bearer ${state.keys.openai}` },
    }),
    generateRequest: (state, prompt) => ({
      url: 'https://api.openai.com/v1/responses',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${state.keys.openai}` },
      body: { model: state.models.openai, input: prompt, max_output_tokens: 2048 },
    }),
    parseText: body => body?.output_text || body?.output?.flatMap(item => item?.content || [])
      .find(item => item?.type === 'output_text')?.text,
  },
});

function buildPrompt(context, { question = '', conversation = [] } = {}) {
  const contextText = JSON.stringify(context);
  const task = question
    ? [
      'Answer the user question using only the anonymized facts and prior displayed conversation.',
      `Prior conversation: ${JSON.stringify(conversation.slice(-20))}`,
      `User question: ${question}`,
    ].join('\n')
    : 'Reply in concise Japanese with sections: 概要, 注目すべき変化, リスク, 推奨確認事項.';
  return {
    contextText,
    prompt: [
      'You are a read-only network security analyst.',
      'Use only the anonymized JSON facts below. Do not invent hosts, IP addresses, or events.',
      task,
      contextText,
    ].join('\n\n'),
  };
}

function createAiProvider({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  let provider = 'disabled';
  let models = { ollama: '', anthropic: '', openai: '' };
  let keys = { anthropic: '', openai: '' };
  let cloudConsent = { anthropic: false, openai: false };
  let ollamaEndpoint = DEFAULT_OLLAMA_ENDPOINT;
  let generationInFlight = false;

  function state() {
    return { provider, models, keys, cloudConsent, ollamaEndpoint };
  }

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
    if (input.cloudConsent) {
      for (const name of CLOUD_PROVIDERS) {
        if (typeof input.cloudConsent[name] === 'boolean') cloudConsent[name] = input.cloudConsent[name];
      }
    }
    if (input.ollamaEndpoint !== undefined) ollamaEndpoint = normalizeEndpoint(input.ollamaEndpoint);
  }

  function exportConfig() {
    return {
      provider,
      models: { ...models },
      keys: { ...keys },
      cloudConsent: { ...cloudConsent },
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
        anthropic: { keySet: !!keys.anthropic, consented: cloudConsent.anthropic },
        openai: { keySet: !!keys.openai, consented: cloudConsent.openai },
      },
    };
  }

  async function listModels() {
    if (provider === 'disabled') throw new Error('AI provider is disabled');
    const adapter = ADAPTERS[provider];
    if (adapter.needsKey && !keys[provider]) {
      throw new Error('API key is not configured');
    }
    const { url, headers } = adapter.listRequest(state());
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { provider, models: modelIds(await readJsonResponse(response), provider) };
  }

  async function generateInsight(context, {
    signal,
    cloudConsentConfirmed = false,
    question = '',
    conversation = [],
  } = {}) {
    if (provider === 'disabled') throw new Error('AI provider is disabled');
    if (!models[provider]) throw new Error(`${provider} model is not configured`);
    const adapter = ADAPTERS[provider];
    if (adapter.needsKey && !keys[provider]) throw new Error('API key is not configured');
    if (adapter.needsConsent) {
      if (!cloudConsent[provider] || !cloudConsentConfirmed) {
        const error = new Error('Cloud AI data sharing consent is required');
        error.code = 'AI_CONSENT_REQUIRED';
        throw error;
      }
    }
    if (generationInFlight) {
      const error = new Error('Another AI analysis is already running');
      error.code = 'AI_BUSY';
      throw error;
    }
    const { contextText, prompt } = buildPrompt(context, { question, conversation });
    if (Buffer.byteLength(contextText) > MAX_PROMPT_BYTES) throw new Error('AI context was too large');
    generationInFlight = true;
    const timeoutSignal = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const { url, headers, body } = adapter.generateRequest(state(), prompt);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      const parsed = await readJsonResponse(response);
      const text = String(adapter.parseText(parsed) || '').trim();
      if (!text) throw new Error('Provider returned an empty analysis');
      return { provider, model: models[provider], text, generatedAt: Date.now() };
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error('AI analysis timed out', { cause: error });
      if (error?.name === 'AbortError') throw new Error('AI analysis was cancelled', { cause: error });
      throw error;
    } finally {
      generationInFlight = false;
    }
  }

  return { configure, exportConfig, generateInsight, getPublicConfig, listModels };
}

const aiProvider = createAiProvider();

module.exports = {
  CLOUD_PROVIDERS,
  DEFAULT_OLLAMA_ENDPOINT,
  GENERATE_TIMEOUT_MS,
  PROVIDERS,
  aiProvider,
  createAiProvider,
  modelIds,
  normalizeEndpoint,
};
