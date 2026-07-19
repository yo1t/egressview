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
// Models discovered by the last "test connection" (Bedrock), kept so the geo
// inference-profile selector can re-filter the model dropdown client-side.
let discoveredModels = [];
let modelDiscoveryRequest = 0;
const GEO_PREFIXES = ['global.', 'us.', 'eu.', 'apac.', 'jp.', 'au.'];

function modelMatchesProfile(id, prefix) {
  if (!prefix) return true;                       // "All"
  if (prefix === 'ondemand') return !GEO_PREFIXES.some(p => id.startsWith(p));
  return id.startsWith(prefix);                   // geo profile prefix
}

function byId(id) {
  return document.getElementById(id);
}

// Rebuild the model dropdown from the discovered list, filtered by the selected
// inference-profile geo. Picking an entry fills the model text input.
function renderModelSelect() {
  const select = byId('s-ai-model-select');
  if (!select) return;
  const prefix = byId('s-ai-profile-select')?.value || '';
  const current = byId('s-ai-model').value.trim();
  const ids = discoveredModels.filter(id => modelMatchesProfile(id, prefix));
  // Fallback only: when nothing is discovered yet (or none match the selected
  // profile), still offer the configured model so the dropdown stays usable.
  // Once discovery populates the list, the profile filter drives the options.
  if (!ids.length && current) ids.push(current);
  if (!ids.length) {
    select.replaceChildren();
    select.classList.add('is-hidden');
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t('settings.ai.modelPick');
  select.replaceChildren(placeholder, ...ids.map(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    return option;
  }));
  select.value = current && ids.includes(current) ? current : '';
  select.classList.remove('is-hidden');
}

function applyDiscoveredModels(models) {
  discoveredModels = Array.isArray(models) ? models : [];
  byId('ai-model-options').replaceChildren(...discoveredModels.map(model => {
    const option = document.createElement('option');
    option.value = model;
    return option;
  }));
  renderModelSelect();
}

async function discoverBedrockModels() {
  const region = byId('s-ai-region').value.trim();
  if (activeProvider !== 'bedrock' || !region) return;
  const requestId = ++modelDiscoveryRequest;
  const select = byId('s-ai-model-select');
  select.disabled = true;
  try {
    const response = await apiFetch(`${_BASE}/api/ai/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (requestId !== modelDiscoveryRequest) return;
    applyDiscoveredModels(result.models);
    setStatus(tVars('settings.ai.testModels', { count: discoveredModels.length }), true);
  } catch (error) {
    if (requestId === modelDiscoveryRequest) {
      setStatus(tVars('settings.ai.testFailed', { message: error.message }), false);
    }
  } finally {
    if (requestId === modelDiscoveryRequest) select.disabled = false;
  }
}

function handleProfileChange() {
  renderModelSelect();
  if (activeProvider === 'bedrock' && !discoveredModels.length) discoverBedrockModels();
}

function setStatus(message, ok) {
  const status = byId('ai-status');
  status.textContent = message;
  status.className = `settings-status is-visible ${ok ? 'ok' : 'err'}`;
}

// Populate the discovered model list without a full "test connection" (no
// InvokeModel verification, no save). Used so the model dropdown and the
// inference-profile filter have data as soon as Bedrock is shown. Best-effort:
// discovery is fail-open and any error just leaves the list as-is.
async function discoverModels(provider) {
  const region = byId('s-ai-region').value.trim();
  if (region.length === 0) return;                 // discovery needs a region
  try {
    const response = await apiFetch(`${_BASE}/api/ai/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region }),
    });
    const body = await response.json().catch(() => ({}));
    // Ignore stale responses if the user switched provider meanwhile.
    if (!response.ok || activeProvider !== provider) return;
    discoveredModels = Array.isArray(body.models) ? body.models : [];
    byId('ai-model-options').replaceChildren(...discoveredModels.map(model => {
      const option = document.createElement('option');
      option.value = model;
      return option;
    }));
    renderModelSelect();
  } catch { /* best-effort discovery */ }
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
  discoveredModels = [];
  // Show the configured model as a one-item dropdown now; "test connection"
  // fills it with the discovered list. renderModelSelect handles show/hide.
  renderModelSelect();
  // Bedrock discovery is keyless, so auto-populate the model list for the saved
  // provider. This gives the inference-profile filter data to work with without
  // requiring a manual "test connection" first.
  if (provider === 'bedrock') discoverModels(provider);
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
  // Reflect the saved region in the dropdown when it matches a known option.
  const regionSelect = byId('s-ai-region-select');
  if (regionSelect) {
    regionSelect.value = [...regionSelect.options].some(o => o.value === config.region) ? config.region : '';
  }
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
    applyDiscoveredModels(models);
    if (result.verified === false) {
      // Bedrock discovery succeeded but no model is selected yet — prompt the
      // user to pick one and test again (the InvokeModel check needs a model).
      setStatus(tVars('settings.ai.testModels', { count: models.length }), true);
    } else {
      setStatus(tVars('settings.ai.testOk', { count: models.length }), true);
    }
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
  byId('s-ai-region-select')?.addEventListener('change', event => {
    if (!event.target.value) return;
    byId('s-ai-region').value = event.target.value;
    // A new region can expose a different model set — refresh the dropdown.
    if (activeProvider === 'bedrock') discoverModels('bedrock');
  });
  byId('s-ai-profile-select')?.addEventListener('change', handleProfileChange);
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
