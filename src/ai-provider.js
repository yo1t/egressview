'use strict';

const PROVIDERS = Object.freeze(['ollama', 'anthropic', 'openai', 'bedrock']);
// Cloud providers authenticated with a stored API key.
const CLOUD_PROVIDERS = Object.freeze(['anthropic', 'openai']);
// Providers that send data to a third party and therefore require explicit
// consent. Bedrock is cloud + consent but keyless (AWS SDK credential chain).
const CONSENT_PROVIDERS = Object.freeze(['anthropic', 'openai', 'bedrock']);
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
  // Amazon Bedrock: keyless (AWS SDK default credential chain), region-based,
  // invoked via the Converse API through an injected transport rather than
  // fetch. modelId may be a foundation model ID, a geographic cross-region
  // inference profile (us./eu./apac./jp./au.) or a Global profile ID/ARN.
  bedrock: {
    transport: 'sdk',
    needsKey: false,
    needsConsent: true,
    needsRegion: true,
  },
});

function buildPrompt(context, { question = '', conversation = [], priorAnalysis = '', language = 'ja' } = {}) {
  const contextText = JSON.stringify(context);
  const langName = language === 'en' ? 'English' : 'Japanese';
  const headings = language === 'en'
    ? { status: 'Situation', actions: 'Recommended actions' }
    : { status: '状況', actions: '推奨アクション' };
  // Readability rules applied to every response: no tables, keep it short.
  const formatRules = [
    'Do not use tables of any kind (no Markdown tables, no ASCII or pipe-delimited tables). Use only prose and short bullet lists.',
    'Keep the whole response readable and concise — at most about 20 lines total.',
  ];
  const task = question
    ? [
      'Answer the user question about this network monitoring period.',
      'Base your answer on the JSON facts, the prior period analysis (if provided), and the displayed conversation. Do not invent hosts, IP addresses, devices, or events that are not present.',
      'When relevant, focus on threats and cite the specific devices (name/IP) and destinations (host/IP) involved.',
      `Reply in ${langName}.`,
      ...formatRules,
      priorAnalysis ? `Prior period analysis you produced:\n${String(priorAnalysis).slice(0, 8000)}` : '',
      `Prior conversation: ${JSON.stringify(conversation.slice(-20))}`,
      `User question: ${question}`,
    ].filter(Boolean).join('\n')
    : [
      `Respond in ${langName} with two parts and nothing else.`,
      `Part 1 — a heading "${headings.status}" followed by a single narrative of about 300 characters (do not exceed 350). Summarize overall activity, the most notable changes versus the previous period, and the current threat posture. Cite specific devices (name/IP) and destinations (host/IP) where they matter.`,
      `Part 2 — a heading "${headings.actions}" followed by a bulleted list ordered by priority: list danger-level threats first, then warn-level threats, then general hygiene items. Each bullet must state the concrete action, the device and destination involved (name/IP), and the reason. If there are no threats, say so in a single bullet.`,
      'For each flagged threat, briefly assess whether it may be a false positive using the destination IP/host — for example a well-known CDN, cloud, or platform (such as GitHub, Google, Microsoft) or shared hosting where the threat intel likely targets a specific URL or subdomain rather than the whole host. State the false-positive likelihood and recommend verifying before taking disruptive action.',
      ...formatRules,
    ].join('\n');
  return {
    contextText,
    prompt: [
      'You are a read-only network security analyst.',
      'Use the JSON facts below. They include real IP addresses, hostnames, and device names, which you may cite. Do not invent hosts, IP addresses, devices, or events that are not present in the facts.',
      task,
      contextText,
    ].join('\n\n'),
  };
}

function createAiProvider({ fetchImpl = globalThis.fetch, bedrock = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  let provider = 'disabled';
  let models = { ollama: '', anthropic: '', openai: '', bedrock: '' };
  let keys = { anthropic: '', openai: '' };
  let cloudConsent = { anthropic: false, openai: false, bedrock: false };
  let ollamaEndpoint = DEFAULT_OLLAMA_ENDPOINT;
  let region = '';
  // Amazon Bedrock Guardrails (opt-in, default off). id/version are not secrets.
  let guardrail = { enabled: false, id: '', version: '' };
  let generationInFlight = false;

  function state() {
    return { provider, models, keys, cloudConsent, ollamaEndpoint, region, guardrail };
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
      for (const name of CONSENT_PROVIDERS) {
        if (typeof input.cloudConsent[name] === 'boolean') cloudConsent[name] = input.cloudConsent[name];
      }
    }
    if (input.ollamaEndpoint !== undefined) ollamaEndpoint = normalizeEndpoint(input.ollamaEndpoint);
    if (input.region !== undefined) region = String(input.region || '').trim();
    if (input.guardrail) {
      if (typeof input.guardrail.enabled === 'boolean') guardrail.enabled = input.guardrail.enabled;
      if (typeof input.guardrail.id === 'string') guardrail.id = input.guardrail.id.trim();
      if (typeof input.guardrail.version === 'string') guardrail.version = input.guardrail.version.trim();
    }
  }

  function exportConfig() {
    return {
      provider,
      models: { ...models },
      keys: { ...keys },
      cloudConsent: { ...cloudConsent },
      ollamaEndpoint,
      region,
      guardrail: { ...guardrail },
    };
  }

  function getPublicConfig() {
    return {
      provider,
      models: { ...models },
      ollamaEndpoint,
      region,
      guardrail: { ...guardrail },
      providers: {
        ollama: { keySet: false },
        anthropic: { keySet: !!keys.anthropic, consented: cloudConsent.anthropic },
        openai: { keySet: !!keys.openai, consented: cloudConsent.openai },
        bedrock: { keySet: false, consented: cloudConsent.bedrock },
      },
    };
  }

  async function listModels(overrides = {}) {
    const selectedProvider = overrides.provider ?? provider;
    const selectedRegion = overrides.region ?? region;
    if (selectedProvider === 'disabled') throw new Error('AI provider is disabled');
    const adapter = ADAPTERS[selectedProvider];
    if (!adapter) throw new Error(`Unsupported AI provider: ${selectedProvider}`);
    if (adapter.needsKey && !keys[selectedProvider]) {
      throw new Error('API key is not configured');
    }
    if (adapter.needsRegion && !selectedRegion) throw new Error('AWS region is not configured');
    if (adapter.transport === 'sdk') {
      // Discovery is best-effort/fail-open; callers fall back to direct
      // model/inference-profile ID entry when this is unavailable.
      if (!bedrock?.listModels) return { provider: selectedProvider, models: [] };
      const ids = await bedrock.listModels({ region: selectedRegion, timeoutMs: REQUEST_TIMEOUT_MS });
      return { provider: selectedProvider, models: (Array.isArray(ids) ? ids : []).slice(0, 200) };
    }
    const requestState = { ...state(), provider: selectedProvider, region: selectedRegion };
    const { url, headers } = adapter.listRequest(requestState);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { provider: selectedProvider, models: modelIds(await readJsonResponse(response), selectedProvider) };
  }

  // Connection test. Fetch providers list models (also confirms auth). Bedrock
  // lists models via fail-open discovery AND sends a minimal fixed-string
  // Converse to verify bedrock:InvokeModel — because model discovery uses a
  // different (control-plane) permission and can succeed while generation is
  // denied. No network/device/threat data is sent by the test.
  async function testConnection() {
    if (provider === 'disabled') throw new Error('AI provider is disabled');
    const adapter = ADAPTERS[provider];
    if (adapter.needsKey && !keys[provider]) throw new Error('API key is not configured');
    if (adapter.needsRegion && !region) throw new Error('AWS region is not configured');
    if (adapter.transport === 'sdk') {
      // Discovery first so the model dropdown can be populated before a model is
      // chosen (avoids a chicken-and-egg where the InvokeModel check needs a
      // model that the user can only discover via this same test).
      const { models: discovered } = await listModels().catch(() => ({ models: [] }));
      if (!models[provider]) {
        // No model selected yet: return the candidate list unverified so the UI
        // can prompt the user to pick one and test again.
        return { provider, models: discovered, verified: false };
      }
      if (!bedrock?.converse) throw new Error('Bedrock transport is not configured');
      await bedrock.converse({
        region,
        modelId: models.bedrock,
        prompt: 'Reply with the single word OK.',
        maxTokens: 8,
        maxBytes: MAX_RESPONSE_BYTES,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { provider, models: discovered, verified: true };
    }
    return listModels();
  }

  async function generateInsight(context, {
    signal,
    cloudConsentConfirmed = false,
    question = '',
    conversation = [],
    priorAnalysis = '',
    language = 'ja',
  } = {}) {
    if (provider === 'disabled') throw new Error('AI provider is disabled');
    if (!models[provider]) throw new Error(`${provider} model is not configured`);
    const adapter = ADAPTERS[provider];
    if (adapter.needsKey && !keys[provider]) throw new Error('API key is not configured');
    if (adapter.needsRegion && !region) throw new Error('AWS region is not configured');
    if (adapter.needsConsent) {
      if (!cloudConsent[provider] || !cloudConsentConfirmed) {
        const error = new Error('Cloud AI data sharing consent is required');
        error.code = 'AI_CONSENT_REQUIRED';
        throw error;
      }
    }
    if (adapter.transport === 'sdk' && !bedrock?.converse) {
      throw new Error('Bedrock transport is not configured');
    }
    if (generationInFlight) {
      const error = new Error('Another AI analysis is already running');
      error.code = 'AI_BUSY';
      throw error;
    }
    const { contextText, prompt } = buildPrompt(context, { question, conversation, priorAnalysis, language });
    if (Buffer.byteLength(contextText) > MAX_PROMPT_BYTES) throw new Error('AI context was too large');
    generationInFlight = true;
    const timeoutSignal = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      let text;
      if (adapter.transport === 'sdk') {
        // Amazon Bedrock Converse via injected transport. The transport maps
        // AWS SDK errors (AccessDenied/Throttling/credential/timeout) to plain
        // Error messages and enforces the response byte bound.
        text = String(await bedrock.converse({
          region,
          modelId: models.bedrock,
          prompt,
          maxTokens: 2048,
          maxBytes: MAX_RESPONSE_BYTES,
          guardrail: guardrail.enabled && guardrail.id
            ? { id: guardrail.id, version: guardrail.version || 'DRAFT' }
            : null,
          signal: requestSignal,
        }) || '').trim();
      } else {
        const { url, headers, body } = adapter.generateRequest(state(), prompt);
        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        const parsed = await readJsonResponse(response);
        text = String(adapter.parseText(parsed) || '').trim();
      }
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

  return { configure, exportConfig, generateInsight, getPublicConfig, listModels, testConnection };
}

// Lazy Bedrock transport for the shared singleton: the AWS SDK (via
// ./ai-bedrock) is only require()d the first time Bedrock is actually used, so
// startup stays light and non-Bedrock deployments never load it.
function defaultBedrockTransport() {
  let transport = null;
  const get = () => (transport ||= require('./ai-bedrock').createBedrockTransport());
  return {
    converse: args => get().converse(args),
    listModels: args => get().listModels(args),
  };
}

const aiProvider = createAiProvider({ bedrock: defaultBedrockTransport() });

module.exports = {
  CLOUD_PROVIDERS,
  CONSENT_PROVIDERS,
  DEFAULT_OLLAMA_ENDPOINT,
  GENERATE_TIMEOUT_MS,
  PROVIDERS,
  aiProvider,
  createAiProvider,
  modelIds,
  normalizeEndpoint,
};
