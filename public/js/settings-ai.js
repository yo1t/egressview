import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai']);
// Providers that require explicit consent before sending data externally.
const CONSENT_PROVIDERS = new Set(['anthropic', 'openai', 'bedrock']);
const PROVIDERS = ['ollama', 'anthropic', 'openai', 'bedrock'];
let config = {
  provider: 'disabled',
  models: { ollama: '', anthropic: '', openai: '', bedrock: '' },
  ollamaEndpoint: 'http://127.0.0.1:11434',
  region: '',
  guardrail: { enabled: false, id: '', version: '' },
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
  byId('ai-bedrock-group').classList.toggle('is-hidden', provider !== 'bedrock');
  byId('ai-key-group').classList.toggle('is-hidden', !CLOUD_PROVIDERS.has(provider));
  byId('ai-consent-group').classList.toggle('is-hidden', !CONSENT_PROVIDERS.has(provider));
  byId('ai-test-btn').disabled = !enabled;
  const modelInput = byId('s-ai-model');
  modelInput.disabled = !enabled;
  // Bedrock model/inference-profile ids (and ARNs) can exceed the 200-char cap
  // used for the other providers.
  modelInput.maxLength = provider === 'bedrock' ? 400 : 200;
  modelInput.value = enabled ? (config?.models?.[provider] || '') : '';
  if (provider === 'bedrock') renderGuardrail();
  byId('ai-model-options').replaceChildren();
  const modelSelect = byId('s-ai-model-select');
  modelSelect.replaceChildren();
  modelSelect.classList.add('is-hidden');
  const keyInput = byId('s-ai-key');
  keyInput.value = '';
  keyInput.placeholder = config?.providers?.[provider]?.keySet ? t('settings.ai.keySaved') : '';
  byId('s-ai-key-clear').checked = false;
  byId('s-ai-cloud-consent').checked = !!config?.providers?.[provider]?.consented;
}

function renderGuardrail() {
  const enabled = byId('s-ai-guardrail-enabled').checked;
  byId('ai-guardrail-fields').classList.toggle('is-hidden', !enabled);
}

function applyConfig(next) {
  const guardrail = next.guardrail || {};
  config = {
    provider: next.provider || 'disabled',
    models: Object.fromEntries(PROVIDERS.map(name => [name, next.models?.[name] || ''])),
    ollamaEndpoint: next.ollamaEndpoint || 'http://127.0.0.1:11434',
    region: next.region || '',
    guardrail: { enabled: !!guardrail.enabled, id: guardrail.id || '', version: guardrail.version || '' },
    providers: next.providers || {},
  };
  byId('s-ai-provider').value = config.provider;
  byId('s-ai-endpoint').value = config.ollamaEndpoint;
  byId('s-ai-region').value = config.region;
  byId('s-ai-guardrail-enabled').checked = config.guardrail.enabled;
  byId('s-ai-guardrail-id').value = config.guardrail.id;
  byId('s-ai-guardrail-version').value = config.guardrail.version;
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
    region: byId('s-ai-region').value.trim(),
  };
  if (CLOUD_PROVIDERS.has(provider)) {
    const key = byId('s-ai-key').value.trim();
    if (key) body.keys = { [provider]: key };
    if (byId('s-ai-key-clear').checked) body.clearKeys = [provider];
  }
  if (CONSENT_PROVIDERS.has(provider)) {
    body.cloudConsent = { [provider]: byId('s-ai-cloud-consent').checked };
  }
  if (provider === 'bedrock') {
    body.guardrail = {
      enabled: byId('s-ai-guardrail-enabled').checked,
      id: byId('s-ai-guardrail-id').value.trim(),
      version: byId('s-ai-guardrail-version').value.trim(),
    };
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
    const models = result.models || [];
    byId('ai-model-options').replaceChildren(...models.map(model => {
      const option = document.createElement('option');
      option.value = model;
      return option;
    }));
    // Populate a real clickable dropdown; picking an entry fills the text input.
    const select = byId('s-ai-model-select');
    if (models.length) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = t('settings.ai.modelPick');
      select.replaceChildren(placeholder, ...models.map(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        return option;
      }));
      const current = byId('s-ai-model').value.trim();
      if (current && models.includes(current)) select.value = current;
      select.classList.remove('is-hidden');
    } else {
      select.replaceChildren();
      select.classList.add('is-hidden');
    }
    setStatus(tVars('settings.ai.testOk', { count: models.length }), true);
  } catch (error) {
    setStatus(tVars('settings.ai.testFailed', { message: error.message }), false);
  } finally {
    button.disabled = byId('s-ai-provider').value === 'disabled';
  }
}

function initAiSettings() {
  byId('s-ai-provider')?.addEventListener('change', event => renderProvider(event.target.value));
  byId('s-ai-guardrail-enabled')?.addEventListener('change', renderGuardrail);
  byId('s-ai-model-select')?.addEventListener('change', event => {
    if (event.target.value) byId('s-ai-model').value = event.target.value;
  });
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
  // settings.js calls this after authentication when the settings modal opens.
  return loadConfig;
}

export { applyConfig, initAiSettings, renderProvider };
