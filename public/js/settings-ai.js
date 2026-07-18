import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai']);
const PROVIDERS = ['ollama', 'anthropic', 'openai'];
let config = {
  provider: 'disabled',
  models: { ollama: '', anthropic: '', openai: '' },
  ollamaEndpoint: 'http://127.0.0.1:11434',
  providers: {},
};
let activeProvider = 'disabled';

function byId(id) {
  return document.getElementById(id);
}

function setStatus(message, ok) {
  const status = byId('ai-status');
  status.textContent = message;
  status.className = `settings-status is-visible ${ok ? 'ok' : 'err'}`;
}

function rememberModel() {
  if (config && PROVIDERS.includes(activeProvider)) {
    config.models[activeProvider] = byId('s-ai-model').value.trim();
  }
}

function renderProvider(provider) {
  rememberModel();
  activeProvider = provider;
  const enabled = PROVIDERS.includes(provider);
  byId('ai-provider-fields').classList.toggle('disabled', !enabled);
  byId('ai-endpoint-group').classList.toggle('is-hidden', provider !== 'ollama');
  byId('ai-key-group').classList.toggle('is-hidden', !CLOUD_PROVIDERS.has(provider));
  byId('ai-consent-group').classList.toggle('is-hidden', !CLOUD_PROVIDERS.has(provider));
  byId('ai-test-btn').disabled = !enabled;
  byId('s-ai-model').disabled = !enabled;
  byId('s-ai-model').value = enabled ? (config?.models?.[provider] || '') : '';
  byId('ai-model-options').replaceChildren();
  const keyInput = byId('s-ai-key');
  keyInput.value = '';
  keyInput.placeholder = config?.providers?.[provider]?.keySet ? t('settings.ai.keySaved') : '';
  byId('s-ai-key-clear').checked = false;
  byId('s-ai-cloud-consent').checked = !!config?.providers?.[provider]?.consented;
}

function applyConfig(next) {
  config = {
    provider: next.provider || 'disabled',
    models: Object.fromEntries(PROVIDERS.map(name => [name, next.models?.[name] || ''])),
    ollamaEndpoint: next.ollamaEndpoint || 'http://127.0.0.1:11434',
    providers: next.providers || {},
  };
  byId('s-ai-provider').value = config.provider;
  byId('s-ai-endpoint').value = config.ollamaEndpoint;
  activeProvider = 'disabled';
  renderProvider(config.provider);
}

async function loadConfig() {
  try {
    const response = await apiFetch(`${_BASE}/api/config/ai`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    applyConfig(body);
  } catch (error) {
    setStatus(tVars('settings.error.withMessage', { message: error.message }), false);
  }
}

async function saveConfig({ showSuccess = true } = {}) {
  rememberModel();
  const provider = byId('s-ai-provider').value;
  const body = {
    provider,
    models: { ...config.models },
    ollamaEndpoint: byId('s-ai-endpoint').value.trim(),
  };
  if (CLOUD_PROVIDERS.has(provider)) {
    const key = byId('s-ai-key').value.trim();
    if (key) body.keys = { [provider]: key };
    if (byId('s-ai-key-clear').checked) body.clearKeys = [provider];
    body.cloudConsent = { [provider]: byId('s-ai-cloud-consent').checked };
  }
  const response = await apiFetch(`${_BASE}/api/config/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  applyConfig(result);
  if (showSuccess) setStatus(t('settings.status.saved'), true);
  return result;
}

async function testConnection() {
  const button = byId('ai-test-btn');
  button.disabled = true;
  try {
    await saveConfig({ showSuccess: false });
    const response = await apiFetch(`${_BASE}/api/ai/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const options = (result.models || []).map(model => {
      const option = document.createElement('option');
      option.value = model;
      return option;
    });
    byId('ai-model-options').replaceChildren(...options);
    setStatus(tVars('settings.ai.testOk', { count: options.length }), true);
  } catch (error) {
    setStatus(tVars('settings.ai.testFailed', { message: error.message }), false);
  } finally {
    button.disabled = byId('s-ai-provider').value === 'disabled';
  }
}

function initAiSettings() {
  byId('s-ai-provider')?.addEventListener('change', event => renderProvider(event.target.value));
  byId('ai-save-btn')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      await saveConfig();
    } catch (error) {
      setStatus(tVars('settings.error.withMessage', { message: error.message }), false);
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  byId('ai-test-btn')?.addEventListener('click', testConnection);
  loadConfig();
}

export { applyConfig, initAiSettings, renderProvider };
