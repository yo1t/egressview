import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

const PROVIDERS = ['abuseipdb', 'virustotal', 'otx'];
const byId = id => document.getElementById(id);

function showStatus(id, message, ok) {
  const element = byId(id);
  element.textContent = message;
  element.className = `settings-status is-visible ${ok ? 'ok' : 'err'}`;
}

function setKeyState(provider, keySet) {
  const input = byId(`s-manual-threat-${provider}`);
  input.value = '';
  input.placeholder = keySet ? t('settings.pass.saved') : '';
  input.dataset.saved = String(keySet);
  byId(`s-manual-threat-${provider}-clear`).checked = false;
}

async function loadConfig() {
  try {
    const response = await apiFetch(`${_BASE}/api/config/manual-threat`);
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || response.statusText);
    for (const provider of PROVIDERS) setKeyState(provider, config.providers?.[provider]?.keySet);
    byId('s-manual-threat-cache').value = String(config.cacheTtlMinutes || 60);
    byId('s-manual-threat-interval').value = String(config.minIntervalSeconds || 15);
  } catch (error) {
    showStatus('manual-threat-config-status', error.message, false);
  }
}

async function saveConfig() {
  const button = byId('manual-threat-config-save');
  button.disabled = true;
  const keys = {};
  const clearKeys = [];
  for (const provider of PROVIDERS) {
    const value = byId(`s-manual-threat-${provider}`).value.trim();
    if (value) keys[provider] = value;
    if (byId(`s-manual-threat-${provider}-clear`).checked) clearKeys.push(provider);
  }
  try {
    const response = await apiFetch(`${_BASE}/api/config/manual-threat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys,
        clearKeys,
        cacheTtlMinutes: Number(byId('s-manual-threat-cache').value),
        minIntervalSeconds: Number(byId('s-manual-threat-interval').value),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    for (const provider of PROVIDERS) setKeyState(provider, data.providers?.[provider]?.keySet);
    showStatus('manual-threat-config-status', t('settings.status.saved'), true);
  } catch (error) {
    showStatus('manual-threat-config-status', error.message, false);
  } finally {
    button.disabled = false;
  }
}

function resultCard(provider, result) {
  const card = document.createElement('article');
  card.className = `manual-threat-result ${result.ok ? 'ok' : 'error'}`;
  const title = document.createElement('strong');
  title.textContent = provider === 'abuseipdb' ? 'AbuseIPDB' : provider === 'virustotal' ? 'VirusTotal' : 'AlienVault OTX';
  card.appendChild(title);
  if (!result.ok) {
    const error = document.createElement('p');
    error.textContent = result.error || t('settings.error.generic');
    card.appendChild(error);
    return card;
  }
  const list = document.createElement('dl');
  for (const [key, value] of Object.entries(result.summary || {})) {
    if (value == null || Array.isArray(value)) continue;
    const term = document.createElement('dt');
    term.textContent = key;
    const detail = document.createElement('dd');
    detail.textContent = String(value);
    list.append(term, detail);
  }
  card.appendChild(list);
  if (result.cached) {
    const cached = document.createElement('small');
    cached.textContent = t('settings.manualThreat.cached');
    card.appendChild(cached);
  }
  return card;
}

async function lookup() {
  const ip = byId('manual-threat-ip').value.trim();
  const providers = PROVIDERS.filter(provider => byId(`manual-threat-use-${provider}`).checked);
  if (!ip || !providers.length) {
    showStatus('manual-threat-lookup-status', t('settings.manualThreat.required'), false);
    return;
  }
  if (!confirm(tVars('settings.manualThreat.confirm', { ip }))) return;
  const button = byId('manual-threat-lookup-btn');
  button.disabled = true;
  byId('manual-threat-results').replaceChildren();
  showStatus('manual-threat-lookup-status', t('settings.manualThreat.checking'), true);
  try {
    const response = await apiFetch(`${_BASE}/api/threat/manual-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, providers }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    byId('manual-threat-results').replaceChildren(...providers.map(provider => resultCard(provider, data.results?.[provider] || {})));
    showStatus('manual-threat-lookup-status', t('settings.manualThreat.complete'), true);
  } catch (error) {
    showStatus('manual-threat-lookup-status', error.message, false);
  } finally {
    button.disabled = false;
  }
}

export function initManualThreatSettings() {
  byId('manual-threat-config-save')?.addEventListener('click', saveConfig);
  byId('manual-threat-lookup-btn')?.addEventListener('click', lookup);
  document.querySelector('[data-tab="threat"]')?.addEventListener('click', loadConfig);
  loadConfig();
}
