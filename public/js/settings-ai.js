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
let modelPricing = new Map();
let modelDiscoveryRequest = 0;
let pricingCheckRequest = 0;
let pricingCheckTimer = null;
// Guardrails discovered by the last region lookup: [{ id, arn, name, versions }].
let discoveredGuardrails = [];
let guardrailDiscoveryRequest = 0;
const GEO_PREFIXES = ['global.', 'us.', 'eu.', 'apac.', 'jp.', 'au.'];
// Inference-profile (geo) filter options. Labels mirror the static markup; the
// list shown is narrowed to what the discovered model set actually contains.
const PROFILE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'global.', label: 'Global (global.)' },
  { value: 'us.', label: 'US (us.)' },
  { value: 'eu.', label: 'EU (eu.)' },
  { value: 'apac.', label: 'APAC (apac.)' },
  { value: 'jp.', label: 'Japan (jp.)' },
  { value: 'au.', label: 'Australia (au.)' },
  { value: 'ondemand', label: 'Single-Region (on-demand)' },
];

function modelMatchesProfile(id, prefix) {
  if (!prefix) return true;                       // "All"
  if (prefix === 'ondemand') return !GEO_PREFIXES.some(p => id.startsWith(p));
  return id.startsWith(prefix);                   // geo profile prefix
}

// Narrow the inference-profile (geo) dropdown to the geos actually present in
// the discovered model set for the selected region, so the user can't pick a
// geo that yields no models. Falls back to the full list before discovery.
function renderProfileSelect() {
  const select = byId('s-ai-profile-select');
  if (!select) return;
  const present = new Set();
  let hasOnDemand = false;
  for (const id of discoveredModels) {
    const geo = GEO_PREFIXES.find(prefix => id.startsWith(prefix));
    if (geo) present.add(geo);
    else hasOnDemand = true;
  }
  const options = discoveredModels.length
    ? PROFILE_OPTIONS.filter(option => option.value === ''
      || (option.value === 'ondemand' ? hasOnDemand : present.has(option.value)))
    : PROFILE_OPTIONS;
  const previous = select.value;
  select.replaceChildren(...options.map(option => {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    return element;
  }));
  // Keep the current geo if it still has models; otherwise fall back to "All".
  select.value = options.some(option => option.value === previous) ? previous : '';
}

function byId(id) {
  return document.getElementById(id);
}

function renderModelPricingStatus() {
  const status = byId('ai-model-pricing-status');
  if (!status) return;
  const model = byId('s-ai-model').value.trim();
  const priced = modelPricing.get(model);
  status.className = 'settings-field-hint ai-model-pricing-status';
  if (!model || !PROVIDERS.includes(activeProvider) || priced === undefined) {
    status.textContent = '';
    return;
  }
  status.textContent = t(priced ? 'settings.ai.pricingKnown' : 'settings.ai.pricingUnknown');
  status.classList.add(priced ? 'is-priced' : 'is-unpriced');
}

async function checkModelPricing() {
  const provider = activeProvider;
  const model = byId('s-ai-model').value.trim();
  if (!PROVIDERS.includes(provider) || !model) {
    renderModelPricingStatus();
    return;
  }
  const requestId = ++pricingCheckRequest;
  try {
    const response = await apiFetch(`${_BASE}/api/ai/pricing/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (requestId !== pricingCheckRequest || provider !== activeProvider || model !== byId('s-ai-model').value.trim()) return;
    modelPricing.set(model, !!result.priced);
    renderModelPricingStatus();
  } catch {
    // Pricing lookup is advisory; saving a valid provider model must remain possible.
  }
}

function queueModelPricingCheck() {
  if (pricingCheckTimer) clearTimeout(pricingCheckTimer);
  const model = byId('s-ai-model').value.trim();
  if (modelPricing.has(model)) {
    renderModelPricingStatus();
    return;
  }
  renderModelPricingStatus();
  pricingCheckTimer = setTimeout(checkModelPricing, 250);
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
    const priced = modelPricing.get(id);
    const suffix = priced === undefined ? ''
      : ` — ${t(priced ? 'settings.ai.pricingKnownShort' : 'settings.ai.pricingUnknownShort')}`;
    option.textContent = `${id}${suffix}`;
    return option;
  }));
  select.value = current && ids.includes(current) ? current : '';
  select.classList.remove('is-hidden');
}

function applyDiscoveredModels(models, pricingCoverage = null) {
  discoveredModels = Array.isArray(models) ? models : [];
  for (const status of pricingCoverage?.models || []) {
    modelPricing.set(status.model, !!status.priced);
  }
  byId('ai-model-options').replaceChildren(...discoveredModels.map(model => {
    const option = document.createElement('option');
    option.value = model;
    return option;
  }));
  // Narrow the geo profile options to what this region offers, then render the
  // model list for the (possibly reset) profile selection.
  renderProfileSelect();
  renderModelSelect();
  renderModelPricingStatus();
}

// Discovery-only model listing for the selected region (no InvokeModel, no
// config save). Auto-called silently when Bedrock is shown / the region
// changes; explicit calls surface a status message. Stale responses are
// dropped so overlapping requests don't clobber a newer one.
async function discoverBedrockModels({ silent = false } = {}) {
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
    if (requestId !== modelDiscoveryRequest || activeProvider !== 'bedrock') return;
    applyDiscoveredModels(result.models, result.modelPricing);
    if (!silent) setStatus(tVars('settings.ai.testModels', { count: discoveredModels.length }), true);
  } catch (error) {
    if (!silent && requestId === modelDiscoveryRequest) {
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
  modelPricing = new Map();
  if (config?.selectedModelPricing?.provider === provider
      && config.selectedModelPricing.model === modelInput.value) {
    modelPricing.set(modelInput.value, !!config.selectedModelPricing.priced);
  }
  if (provider === 'bedrock') renderGuardrail();
  byId('ai-model-options').replaceChildren();
  discoveredModels = [];
  // Show the configured model as a one-item dropdown now; "test connection"
  // fills it with the discovered list. renderModelSelect handles show/hide.
  renderModelSelect();
  renderModelPricingStatus();
  // Bedrock discovery is keyless, so auto-populate the model list (and narrow
  // the geo profile options) for the saved region without requiring a manual
  // "test connection". Silent: opening settings should not post a status.
  if (provider === 'bedrock') discoverBedrockModels({ silent: true });
  const keyInput = byId('s-ai-key');
  keyInput.value = '';
  keyInput.placeholder = config?.providers?.[provider]?.keySet ? t('settings.ai.keySaved') : '';
  byId('s-ai-key-clear').checked = false;
  byId('s-ai-cloud-consent').checked = !!config?.providers?.[provider]?.consented;
}

function renderGuardrail() {
  const enabled = byId('s-ai-guardrail-enabled').checked;
  byId('ai-guardrail-fields').classList.toggle('is-hidden', !enabled);
  if (enabled && activeProvider === 'bedrock') {
    discoverGuardrails();
  } else {
    // Invalidate an in-flight lookup so a late response cannot repopulate
    // options after Guardrails have been disabled.
    guardrailDiscoveryRequest++;
    discoveredGuardrails = [];
    renderGuardrailSelect();
  }
}

// Rebuild the Guardrail dropdown from the discovered list. Picking one fills
// the id input and refreshes the version dropdown. Hidden (manual entry only)
// when nothing was discovered — e.g. no bedrock:ListGuardrails permission.
function renderGuardrailSelect() {
  const select = byId('s-ai-guardrail-select');
  if (!select) return;
  if (!discoveredGuardrails.length) {
    select.replaceChildren();
    select.classList.add('is-hidden');
    renderGuardrailVersionSelect();
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t('settings.ai.modelPick');
  const current = byId('s-ai-guardrail-id').value.trim();
  select.replaceChildren(placeholder, ...discoveredGuardrails.map(guardrail => {
    const option = document.createElement('option');
    option.value = guardrail.id;
    option.textContent = guardrail.name && guardrail.name !== guardrail.id
      ? `${guardrail.name} (${guardrail.id})` : guardrail.id;
    return option;
  }));
  select.value = discoveredGuardrails.some(guardrail => guardrail.id === current) ? current : '';
  select.classList.remove('is-hidden');
  renderGuardrailVersionSelect();
}

// Version dropdown for the currently-selected guardrail (from discovery). Falls
// back to hidden (manual version entry) when the guardrail is not in the list.
function renderGuardrailVersionSelect() {
  const select = byId('s-ai-guardrail-version-select');
  if (!select) return;
  const currentId = byId('s-ai-guardrail-id').value.trim();
  const match = discoveredGuardrails.find(guardrail => guardrail.id === currentId);
  const versions = match?.versions?.length ? match.versions : [];
  if (!versions.length) {
    select.replaceChildren();
    select.classList.add('is-hidden');
    return;
  }
  const currentVersion = byId('s-ai-guardrail-version').value.trim();
  select.replaceChildren(...versions.map(version => {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    return option;
  }));
  select.value = versions.includes(currentVersion) ? currentVersion : versions[0];
  // The text input is the canonical value used by saveConfig. Keep it aligned
  // with the visible dropdown even when discovery selects a fallback version.
  byId('s-ai-guardrail-version').value = select.value;
  select.classList.remove('is-hidden');
}

// Always silent/best-effort: guardrails are optional, so a discovery failure
// (incl. missing permission) just leaves the manual id/version inputs in place.
async function discoverGuardrails() {
  const region = byId('s-ai-region').value.trim();
  if (activeProvider !== 'bedrock' || !region || !byId('s-ai-guardrail-enabled').checked) return;
  const requestId = ++guardrailDiscoveryRequest;
  try {
    const response = await apiFetch(`${_BASE}/api/ai/guardrails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok
      || requestId !== guardrailDiscoveryRequest
      || activeProvider !== 'bedrock'
      || !byId('s-ai-guardrail-enabled').checked
      || byId('s-ai-region').value.trim() !== region) return;
    discoveredGuardrails = Array.isArray(result.guardrails) ? result.guardrails : [];
    renderGuardrailSelect();
  } catch { /* best-effort; manual entry remains */ }
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
    selectedModelPricing: next.selectedModelPricing || null,
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
    applyDiscoveredModels(models, result.modelPricing);
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
    if (event.target.value) {
      byId('s-ai-model').value = event.target.value;
      queueModelPricingCheck();
    }
  });
  byId('s-ai-model')?.addEventListener('input', queueModelPricingCheck);
  byId('s-ai-region-select')?.addEventListener('change', event => {
    if (!event.target.value) return;
    byId('s-ai-region').value = event.target.value;
    // A new region can expose a different model set, geo profiles, and
    // guardrails — refresh all of them.
    if (activeProvider === 'bedrock') {
      discoverBedrockModels();
      discoverGuardrails();
    }
  });
  byId('s-ai-profile-select')?.addEventListener('change', handleProfileChange);
  byId('s-ai-guardrail-select')?.addEventListener('change', event => {
    if (!event.target.value) return;
    byId('s-ai-guardrail-id').value = event.target.value;
    // A version belongs to one guardrail only. Do not carry a version selected
    // for the previous guardrail into the newly-selected one.
    byId('s-ai-guardrail-version').value = '';
    renderGuardrailVersionSelect();
  });
  byId('s-ai-guardrail-version-select')?.addEventListener('change', event => {
    if (event.target.value) byId('s-ai-guardrail-version').value = event.target.value;
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
