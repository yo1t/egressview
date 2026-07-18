import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { loadBeacons } from './beacon.js?v=__ASSET_VERSION__';

export function initBeaconSettings(showStatus) {
  async function loadBeaconConfig() {
    try {
      const { config } = await (await apiFetch(_BASE + '/api/beacons/config')).json();
      if (!config) return;
      document.getElementById('s-beacon-enabled').checked = config.enabled !== false;
      document.getElementById('s-beacon-minobs').value = config.minObs;
      document.getElementById('s-beacon-maxcov').value = config.maxCov;
      document.getElementById('s-beacon-minint').value = Math.round(config.minIntervalMs / 60000);
      document.getElementById('s-beacon-maxint').value = Math.round(config.maxIntervalMs / 60000);
      document.getElementById('s-beacon-scaninterval').value = String(Math.round(config.scanIntervalMs / 60000));
      document.getElementById('s-beacon-whitelist').value = (config.whitelistDomains || []).join('\n');
      document.getElementById('s-beacon-orgs').value = (config.orgAllowlist || []).join('\n');
    } catch {}
  }
  document.getElementById('beacon-save-btn').addEventListener('click', async () => {
    const button = document.getElementById('beacon-save-btn');
    button.disabled = true;
    try {
      const lines = id => document.getElementById(id).value.split('\n').map(value => value.trim()).filter(Boolean);
      const response = await apiFetch(_BASE + '/api/beacons/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('s-beacon-enabled').checked,
          minObs: parseInt(document.getElementById('s-beacon-minobs').value, 10) || 4,
          maxCov: parseFloat(document.getElementById('s-beacon-maxcov').value) || 0.5,
          minIntervalMs: (parseInt(document.getElementById('s-beacon-minint').value, 10) || 1) * 60000,
          maxIntervalMs: (parseInt(document.getElementById('s-beacon-maxint').value, 10) || 240) * 60000,
          scanIntervalMs: parseInt(document.getElementById('s-beacon-scaninterval').value, 10) * 60000,
          whitelistDomains: lines('s-beacon-whitelist'), orgAllowlist: lines('s-beacon-orgs'),
        }),
      });
      const data = await response.json();
      showStatus('beacon-status', data.success ? t('settings.beacon.savedScanning') : (data.error || t('settings.error.generic')), data.success);
      if (data.success) setTimeout(loadBeacons, 2000);
    } catch (error) {
      showStatus('beacon-status', tVars('settings.error.withMessage', { message: error.message }), false);
    } finally { button.disabled = false; }
  });
  document.querySelector('[data-tab="threat"]')?.addEventListener('click', loadBeaconConfig);
  return { loadBeaconConfig };
}
