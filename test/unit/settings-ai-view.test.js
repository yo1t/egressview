'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function stripEsModule(source) {
  return source
    .replace(/^import\s[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(default\s+)?(function|class|const|let|var)\s/gm, '$2 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}

const settingsAiJs = stripEsModule(fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'settings-ai.js'),
  'utf8'
));

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.placeholder = '';
    this.children = [];
    this.listeners = new Map();
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (enabled) this._classes.add(name);
        else this._classes.delete(name);
        return enabled;
      },
    };
  }

  get options() { return this.children; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  replaceChildren(...children) { this.children = children; }
  async dispatch(type) {
    await Promise.all((this.listeners.get(type) || []).map(listener => listener({
      target: this,
      currentTarget: this,
    })));
  }
}

function makeHarness({ models = [], guardrailFetch = null } = {}) {
  const ids = new Map();
  const elementIds = [
    's-ai-provider', 'ai-provider-fields', 'ai-model-group', 's-ai-model',
    's-ai-model-select', 'ai-model-options', 's-ai-profile-select',
    'ai-endpoint-group', 'ai-bedrock-group', 's-ai-endpoint', 'ai-region-group', 's-ai-region',
    's-ai-region-select', 's-ai-guardrail-enabled', 'ai-guardrail-fields',
    's-ai-guardrail-select', 's-ai-guardrail-id', 's-ai-guardrail-version-select',
    's-ai-guardrail-version', 'ai-key-group', 's-ai-key', 's-ai-key-clear',
    'ai-consent-group', 's-ai-cloud-consent', 'ai-status', 'ai-test-btn',
    'ai-save-btn',
  ];
  elementIds.forEach(id => ids.set(id, new FakeElement('div', id)));
  const savedBodies = [];
  const apiFetch = async (url, options = {}) => {
    if (url.endsWith('/api/ai/models')) {
      return { ok: true, json: async () => ({ models }) };
    }
    if (url.endsWith('/api/ai/guardrails')) {
      if (guardrailFetch) return guardrailFetch();
      return { ok: true, json: async () => ({
        guardrails: [{ id: 'gr-1', name: 'PII Filter', versions: ['DRAFT', '2'] }],
      }) };
    }
    if (url.endsWith('/api/config/ai') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      savedBodies.push(body);
      return { ok: true, json: async () => ({
        ...body,
        providers: { bedrock: { consented: true, keySet: false } },
      }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = {
    console,
    Set,
    _BASE: '',
    t: key => key,
    tVars: (key, vars) => `${key}:${JSON.stringify(vars)}`,
    apiFetch,
    document: {
      createElement: tagName => new FakeElement(tagName),
      getElementById: id => ids.get(id) || null,
    },
  };
  vm.createContext(context);
  vm.runInContext(settingsAiJs, context, { filename: 'public/js/settings-ai.js' });
  context.initAiSettings();
  return { context, ids, savedBodies };
}

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

describe('AI settings DOM behavior', () => {
  it('keeps the discovered Guardrail version aligned with the value that is saved', async () => {
    const { context, ids, savedBodies } = makeHarness();
    context.applyConfig({
      provider: 'bedrock',
      models: { bedrock: 'jp.example-model' },
      region: 'ap-northeast-1',
      guardrail: { enabled: true, id: '', version: '' },
      cloudConsent: { bedrock: true },
      providers: { bedrock: { consented: true, keySet: false } },
    });
    await flushPromises();

    const guardrailSelect = ids.get('s-ai-guardrail-select');
    guardrailSelect.value = 'gr-1';
    await guardrailSelect.dispatch('change');

    assert.equal(ids.get('s-ai-guardrail-version-select').value, 'DRAFT');
    assert.equal(ids.get('s-ai-guardrail-version').value, 'DRAFT');
    await ids.get('ai-save-btn').dispatch('click');
    assert.equal(savedBodies.at(-1).guardrail.id, 'gr-1');
    assert.equal(savedBodies.at(-1).guardrail.version, 'DRAFT');
  });

  it('filters discovered Bedrock models by geo and applies the selected model', async () => {
    const { context, ids } = makeHarness({
      models: ['jp.example-sonnet', 'us.example-sonnet', 'example-on-demand'],
    });
    context.applyConfig({
      provider: 'bedrock',
      models: { bedrock: '' },
      region: 'ap-northeast-1',
      guardrail: { enabled: false, id: '', version: '' },
      providers: { bedrock: { consented: true, keySet: false } },
    });
    await flushPromises();

    const profileSelect = ids.get('s-ai-profile-select');
    assert.deepEqual(profileSelect.options.map(option => option.value), ['', 'us.', 'jp.', 'ondemand']);
    profileSelect.value = 'jp.';
    await profileSelect.dispatch('change');

    const modelSelect = ids.get('s-ai-model-select');
    assert.deepEqual(modelSelect.options.map(option => option.value), ['', 'jp.example-sonnet']);
    modelSelect.value = 'jp.example-sonnet';
    await modelSelect.dispatch('change');
    assert.equal(ids.get('s-ai-model').value, 'jp.example-sonnet');
  });

  it('ignores a Guardrail discovery response that arrives after disabling it', async () => {
    let resolveGuardrails;
    const guardrailResponse = new Promise(resolve => { resolveGuardrails = resolve; });
    const { context, ids } = makeHarness({ guardrailFetch: () => guardrailResponse });
    context.applyConfig({
      provider: 'bedrock',
      models: { bedrock: 'jp.example-model' },
      region: 'ap-northeast-1',
      guardrail: { enabled: true, id: '', version: '' },
      providers: { bedrock: { consented: true, keySet: false } },
    });
    await flushPromises();

    ids.get('s-ai-guardrail-enabled').checked = false;
    await ids.get('s-ai-guardrail-enabled').dispatch('change');
    resolveGuardrails({ ok: true, json: async () => ({
      guardrails: [{ id: 'stale-guardrail', versions: ['DRAFT'] }],
    }) });
    await flushPromises();

    assert.equal(ids.get('s-ai-guardrail-select').children.length, 0);
    assert.equal(ids.get('s-ai-guardrail-select').classList.contains('is-hidden'), true);
  });
});
