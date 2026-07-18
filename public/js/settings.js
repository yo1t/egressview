// ─── Settings modal ───────────────────────────────────────────────────────────
import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { toggleSection } from './settings-legacy-routers.js?v=__ASSET_VERSION__';
import { initBackupSettings } from './settings-backup.js?v=__ASSET_VERSION__';
import { initSessionSettings } from './settings-sessions.js?v=__ASSET_VERSION__';
import { initBeaconSettings } from './settings-beacons.js?v=__ASSET_VERSION__';
import { initSlackSettings } from './settings-slack.js?v=__ASSET_VERSION__';
const settingsOverlay = document.getElementById('settings-overlay');
const settingsBtn     = document.getElementById('settings-btn');

function openSettings(tab) {
  settingsOverlay.classList.remove('hidden');
  settingsBtn.classList.remove('alert');
  if (typeof tab === 'string' && tab) {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
    const tabEl = document.querySelector(`.settings-tab[data-tab="${tab}"]`);
    if (tabEl) tabEl.classList.add('active');
    const paneEl = document.getElementById('pane-' + tab);
    if (paneEl) paneEl.classList.add('active');
  }
}
function closeSettings() { settingsOverlay.classList.add('hidden'); }
function showStatus(elId, msg, ok) {
  const element = document.getElementById(elId);
  element.textContent = msg;
  element.className = 'settings-status is-visible ' + (ok ? 'ok' : 'err');
}

settingsBtn.addEventListener('click', () => openSettings());
document.getElementById('settings-close').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) closeSettings(); });

// Tab switching
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('pane-' + name).classList.add('active');
  });
});

// Load threat settings from localStorage on init
(function loadThreatSettings() {
  try {
    const raw = localStorage.getItem('egressview_threat_config');
    if (!raw) return;
    const config = JSON.parse(raw);
    if (config.feeds) {
      document.getElementById('s-feed-feodo').checked = config.feeds.feodo !== false;
      document.getElementById('s-feed-threatfox').checked = config.feeds.threatfox !== false;
      document.getElementById('s-feed-urlhaus').checked = config.feeds.urlhaus !== false;
      document.getElementById('s-feed-spamhaus').checked = config.feeds.spamhaus !== false;
    }
    if (config.intervalMin) document.getElementById('s-threat-interval').value = String(config.intervalMin);
  } catch {}
})();

// ── Data sources save ────────────────────────────────────────────────────────
document.getElementById('enable-dnsmasq').addEventListener('change', () => {
  toggleSection('dnsmasq-inputs', 'enable-dnsmasq', null);
});
document.getElementById('enable-inspect').addEventListener('change', () => {
  toggleSection('inspect-inputs', 'enable-inspect', null);
});
document.getElementById('enable-dhcpd').addEventListener('change', () => {
  toggleSection('dhcpd-inputs', 'enable-dhcpd', null);
});

document.getElementById('datasource-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('datasource-save-btn');
  btn.disabled = true;
  try {
    const body = {
      dnsmasq: {
        enabled: document.getElementById('enable-dnsmasq').checked,
        logFile: document.getElementById('s-dnsmasq-logfile').value.trim()
                 || '/var/log/dnsmasq-queries.log',
      },
      inspect: {
        enabled: document.getElementById('enable-inspect').checked,
        logFile: document.getElementById('s-inspect-logfile').value.trim()
                 || '/var/log/yamaha-router.log',
      },
      dhcpd: {
        enabled: document.getElementById('enable-dhcpd').checked,
        logFile: document.getElementById('s-dhcpd-logfile').value.trim()
                 || '/var/log/yamaha-router.log',
      },
    };
    const r = await apiFetch(_BASE+'/api/config/datasources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.success) {
      showStatus('datasource-status', t('settings.status.saved'), true);
    } else {
      showStatus('datasource-status', data.error || t('settings.error.generic'), false);
    }
  } catch (e) {
    showStatus('datasource-status', tVars('settings.error.withMessage', { message: e.message }), false);
  } finally {
    btn.disabled = false;
  }
});

// ── API token regeneration (P2-22) ────────────────────────────────────────────
// The API token is an automation credential; the browser itself authenticates
// with a login session, so we just display the new value once for copying.

document.getElementById('token-regen-btn').addEventListener('click', async () => {
  const pw = document.getElementById('s-token-pw').value;
  if (!pw) {
    showStatus('token-status', t('settings.token.pwRequired'), false);
    return;
  }
  const msg = t('settings.token.confirm');
  if (!confirm(msg)) return;
  const btn = document.getElementById('token-regen-btn');
  btn.disabled = true;
  try {
    const r = await apiFetch(_BASE+'/api/admin/regenerate-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: pw }),
    });
    const data = await r.json();
    document.getElementById('s-token-pw').value = '';
    if (data.success && data.token) {
      prompt(t('settings.token.prompt'), data.token);
      showStatus('token-status', t('settings.token.regenerated'), true);
    } else {
      showStatus('token-status', data.error || 'Error', false);
    }
  } catch (e) {
    showStatus('token-status', tVars('settings.error.withMessage', { message: e.message }), false);
  } finally {
    btn.disabled = false;
  }
});

const { loadBackupList } = initBackupSettings(showStatus);
initSessionSettings(showStatus);
initBeaconSettings(showStatus);
initSlackSettings(showStatus);

export { openSettings, showStatus, loadBackupList, toggleSection, settingsBtn };
