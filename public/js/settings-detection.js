import { t } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

// Per-detection delivery switches for the two notifications the server raises
// directly. The AI event rules live in settings-ai.js and are configured
// through a different endpoint; keep the two apart in the UI as well.
export function initDetectionSettings(showStatus) {
const FIELDS = [
  ['threat', 'slack', 'detection-threat-slack'],
  ['threat', 'history', 'detection-threat-history'],
  ['newDevice', 'slack', 'detection-new-device-slack'],
  ['newDevice', 'history', 'detection-new-device-history'],
];

function applyConfig(config) {
  for (const [kind, channel, id] of FIELDS) {
    const input = document.getElementById(id);
    if (input) input.checked = config?.[kind]?.[channel] !== false;
  }
}

function readConfig() {
  const config = { threat: {}, newDevice: {} };
  for (const [kind, channel, id] of FIELDS) {
    config[kind][channel] = !!document.getElementById(id)?.checked;
  }
  return config;
}

async function loadDetectionSettings({ silent = false } = {}) {
  try {
    const r = await apiFetch(_BASE + '/api/config/detection-notifications');
    const data = await r.json();
    if (!r.ok || !data?.config) throw new Error(data?.error || t('settings.detection.saveFailed'));
    applyConfig(data.config);
  } catch (error) {
    // The first load runs before the operator has opened this pane, so a
    // failure there must not leave an error sitting in the status area.
    if (!silent) {
      showStatus('detection-status', error.message || t('settings.detection.saveFailed'), false);
    }
  }
}

document.getElementById('detection-save-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('detection-save-btn');
  btn.disabled = true;
  try {
    const r = await apiFetch(_BASE + '/api/config/detection-notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readConfig()),
    });
    const data = await r.json();
    if (!r.ok || !data?.success) throw new Error(data?.error || t('settings.detection.saveFailed'));
    // Re-render from the server response so the UI never claims a state the
    // server did not persist.
    applyConfig(data.config);
    showStatus('detection-status', t('settings.detection.saved'), true);
  } catch (error) {
    showStatus('detection-status', error.message || t('settings.detection.saveFailed'), false);
  } finally {
    btn.disabled = false;
  }
});

document.querySelector('.settings-tab[data-tab="notifications"]')
  ?.addEventListener('click', () => loadDetectionSettings());

// Deliberately no load at module evaluation. This endpoint is permission
// gated, and an unauthenticated browser must not issue protected requests
// before login. settings.js calls the returned loader when the settings
// dialog opens, which only happens for an authenticated operator.

return { loadDetectionSettings };
}
