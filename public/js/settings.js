// ─── Settings modal ───────────────────────────────────────────────────────────
const settingsOverlay = document.getElementById('settings-overlay');
const settingsBtn     = document.getElementById('settings-btn');

function openSettings() {
  settingsOverlay.classList.remove('hidden');
  settingsBtn.classList.remove('alert');
}
function closeSettings() { settingsOverlay.classList.add('hidden'); }

settingsBtn.addEventListener('click', openSettings);
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

// Checkbox toggles enable/disable of input fields and updates the button label
function toggleSection(inputsId, checkboxId, btnId) {
  const enabled = document.getElementById(checkboxId).checked;
  document.getElementById(inputsId).classList.toggle('disabled', !enabled);
  if (btnId) {
    document.getElementById(btnId).textContent = enabled ? t('settings.btn.connect') : t('settings.btn.disable');
  }
}
document.getElementById('enable-yamaha').addEventListener('change',
  () => toggleSection('yamaha-inputs', 'enable-yamaha', 'yamaha-connect-btn'));
document.getElementById('enable-asus').addEventListener('change',
  () => toggleSection('asus-inputs', 'enable-asus', 'asus-connect-btn'));

function showStatus(elId, msg, ok) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = 'settings-status ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
}

async function connectRouter(body, statusId, btnId, checkboxId) {
  const btn = document.getElementById(btnId);
  const enabled = checkboxId ? document.getElementById(checkboxId).checked : true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>' + (enabled ? t('settings.btn.connecting') : t('settings.btn.disabling'));
  document.getElementById(statusId).style.display = 'none';
  try {
    const res = await apiFetch(_BASE+'/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      if (data.routerIp) { connState.l2.ip = data.routerIp; updateConnBadge('l2'); }
      document.getElementById('disconnected-banner').style.display = 'none';
      showStatus(statusId, enabled ? t('settings.status.ok') : t('settings.status.disabled'), true);
      setTimeout(closeSettings, 1200);
      return true;
    } else {
      showStatus(statusId, data.error || (enabled ? t('badge.error') : t('badge.error')), false);
      return false;
    }
  } catch (err) {
    showStatus(statusId, t('err.serverGeneric') + err.message, false);
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = enabled ? t('settings.btn.connect') : t('settings.btn.disable');
  }
}

// Apply Yamaha settings (L3/L4 tab)
document.getElementById('yamaha-connect-btn').addEventListener('click', async () => {
  const doYamaha = document.getElementById('enable-yamaha').checked;
  const body = { doYamaha };
  if (doYamaha) {
    body.yamahaIp   = document.getElementById('s-yamaha-ip').value.trim()   || undefined;
    body.yamahaUser = document.getElementById('s-yamaha-user').value.trim() || undefined;
    const pw = document.getElementById('s-yamaha-pass').value;
    if (pw) body.yamahaPass = pw; // omit if empty (server uses saved password)
    const nat = document.getElementById('s-yamaha-nat').value.trim();
    if (nat) body.yamahaNat = nat;
  }
  const ok = await connectRouter(body, 'yamaha-status', 'yamaha-connect-btn', 'enable-yamaha');
  if (ok) {
    yamahaConfigured = doYamaha;
    connState.l3l4.enabled = doYamaha;
    connState.l3l4.ready   = false;        // wait for yamaha-status event for connection result
    connState.l3l4.err     = '';
    if (doYamaha && body.yamahaIp) connState.l3l4.ip = body.yamahaIp;
    updateConnBadge('l3l4');
    if (!doYamaha) {
      allConnections = [];
      dataRangeFrom = Date.now() - 86400_000;
      if (!asusActive) stopGraph();
      else if (simulation) updateOrgGraph();
    }
  }
});

// Apply ASUS settings (L2 tab)
document.getElementById('asus-connect-btn').addEventListener('click', async () => {
  const doAsus = document.getElementById('enable-asus').checked;
  const passEl = document.getElementById('s-asus-pass');
  // Even if password is empty, use the saved one if placeholder shows "saved"
  const hasSavedPass = /保存済み/.test(passEl.placeholder);
  if (doAsus) {
    const user = document.getElementById('s-asus-user').value.trim();
    const pass = passEl.value;
    if (!user) { showStatus('asus-status', t('err.userRequired'), false); return; }
    if (!pass && !hasSavedPass) {
      showStatus('asus-status', t('err.passRequired'), false); return;
    }
  }
  const body = { doAsus };
  if (doAsus) {
    body.routerIp = document.getElementById('s-asus-ip').value.trim() || undefined;
    body.username = document.getElementById('s-asus-user').value.trim();
    // Omit if empty (server uses saved password)
    if (passEl.value) body.password = passEl.value;
  }
  const ok = await connectRouter(body, 'asus-status', 'asus-connect-btn', 'enable-asus');
  if (ok) {
    connState.l2.enabled = doAsus;
    connState.l2.ready   = false; // becomes true on receiving network-update
    connState.l2.err     = '';
    if (doAsus && body.routerIp) connState.l2.ip = body.routerIp;
    updateConnBadge('l2');
    if (!doAsus) { asusActive = false; stopGraph(); }
  }
});

// ─── Slack notification settings UI ──────────────────────────────────────────
document.getElementById('slack-verify-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-verify-btn');
  const token = document.getElementById('s-slack-token').value.trim();
  // If token field is empty, server will use the stored token
  btn.disabled = true;
  try {
    const r = await apiFetch(_BASE+'/api/slack/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || undefined }),
    });
    const data = await r.json();
    const info = document.getElementById('slack-workspace-info');
    if (data.ok) {
      info.style.display = 'block';
      info.style.color = 'var(--green)';
      info.textContent = `✓ ${data.team} (${data.user})`;
    } else {
      info.style.display = 'block';
      info.style.color = '#ef4444';
      info.textContent = '✗ ' + (data.error || 'Failed');
    }
  } catch (e) {
    showStatus('slack-status', e.message, false);
  } finally { btn.disabled = false; }
});

document.getElementById('slack-lookup-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-lookup-btn');
  const username = document.getElementById('s-slack-username').value.trim();
  const token = document.getElementById('s-slack-token').value.trim();
  if (!username) { showStatus('slack-status', 'Username required', false); return; }
  btn.disabled = true;
  try {
    // token omitted → server reads from stored config
    const r = await apiFetch(_BASE+'/api/slack/lookup-user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, token: token || undefined }),
    });
    const data = await r.json();
    const info = document.getElementById('slack-user-info');
    if (data.ok) {
      const displayName = data.realName || data.displayName || data.name;
      info.style.display = 'block';
      info.style.color = 'var(--green)';
      info.textContent = `✓ ${displayName} (${data.userId})`;
      document.getElementById('s-slack-userid').value = data.userId;
      document.getElementById('s-slack-username').value = displayName;
    } else {
      info.style.display = 'block';
      info.style.color = '#ef4444';
      info.textContent = '✗ ' + (data.error === 'user_not_found' ? (currentLang === 'ja' ? 'ユーザーが見つかりません' : 'User not found') : data.error);
    }
  } catch (e) {
    showStatus('slack-status', e.message, false);
  } finally { btn.disabled = false; }
});

document.getElementById('slack-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-save-btn');
  btn.disabled = true; btn.textContent = t('settings.btn.saving');
  try {
    const token = document.getElementById('s-slack-token').value.trim();
    await apiFetch(_BASE+'/api/config/slack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: document.getElementById('s-slack-enabled').checked,
        token: token || undefined,
        userId: document.getElementById('s-slack-userid').value.trim(),
        displayName: document.getElementById('s-slack-username').value.trim(),
        cooldownMinutes: parseInt(document.getElementById('s-slack-cooldown').value),
      }),
    });
    if (token) document.getElementById('s-slack-token').value = '';
    showStatus('slack-status', t('settings.status.saved'), true);
  } catch (e) {
    showStatus('slack-status', t('err.serverGeneric') + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = t('settings.btn.save');
  }
});

document.getElementById('slack-test-btn').addEventListener('click', async () => {
  const btn = document.getElementById('slack-test-btn');
  btn.disabled = true; btn.textContent = t('settings.slack.test.sending');
  try {
    const r = await apiFetch(_BASE+'/api/slack/test', { method: 'POST', body: '{}' });
    const data = await r.json();
    if (data.success) {
      showStatus('slack-status', t('settings.slack.test.ok'), true);
    } else {
      showStatus('slack-status', t('settings.slack.test.fail') + (data.error || 'error'), false);
    }
  } catch (e) {
    showStatus('slack-status', t('settings.slack.test.fail') + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = t('settings.slack.test');
  }
});

(function loadSlackSettings() {
  apiFetch(_BASE+'/api/config/slack').then(async r => {
    const data = await r.json();
    if (!data) return;
    document.getElementById('s-slack-enabled').checked = !!data.config?.enabled;
    if (data.config?.userId) document.getElementById('s-slack-userid').value = data.config.userId;
    if (data.config?.displayName) document.getElementById('s-slack-username').value = data.config.displayName;
    if (data.config?.cooldownMinutes) document.getElementById('s-slack-cooldown').value = String(data.config.cooldownMinutes);
    if (data.config?.tokenSet) {
      document.getElementById('s-slack-token').placeholder = currentLang === 'ja' ? '(保存済み)' : '(saved)';
    }
  }).catch(() => {});
})();

// Load threat settings from localStorage on init
(function loadThreatSettings() {
  try {
    const raw = localStorage.getItem('widemap_threat_config');
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

// ─── Backup settings UI ───────────────────────────────────────────────────────
async function loadBackupList() {
  try {
    const r = await apiFetch(_BASE+'/api/backup/list');
    const data = await r.json();
    const listEl = document.getElementById('backup-list');
    if (data.config) {
      document.getElementById('s-backup-interval').value = String(data.config.intervalHours);
      document.getElementById('s-backup-generations').value = String(data.config.maxGenerations);
    }
    if (!data.backups || data.backups.length === 0) {
      listEl.innerHTML = '<div style="padding:4px;">' + (currentLang === 'ja' ? 'バックアップなし' : 'No backups') + '</div>';
      return;
    }
    listEl.innerHTML = data.backups.reverse().map(b => {
      const size = (b.size / 1024 / 1024).toFixed(1) + ' MB';
      const date = new Date(b.created).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US');
      return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="flex:1">${date} (${size})</span>
        <button class="connect-btn" style="font-size:9px;padding:2px 6px;" onclick="backupDownload('${b.name}')">DL</button>
        <button class="connect-btn" style="font-size:9px;padding:2px 6px;" onclick="backupRestore('${b.name}')">Restore</button>
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('backup-list').textContent = 'Error: ' + e.message;
  }
}

document.getElementById('backup-config-save').addEventListener('click', async () => {
  try {
    await apiFetch(_BASE+'/api/backup/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intervalHours: parseInt(document.getElementById('s-backup-interval').value),
        maxGenerations: parseInt(document.getElementById('s-backup-generations').value),
      }),
    });
    showStatus('backup-config-status', t('settings.status.saved'), true);
  } catch (e) {
    showStatus('backup-config-status', 'Error: ' + e.message, false);
  }
});

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
      showStatus('datasource-status', '✓ 保存しました', true);
    } else {
      showStatus('datasource-status', data.error || 'エラー', false);
    }
  } catch (e) {
    showStatus('datasource-status', 'Error: ' + e.message, false);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('backup-create-btn').addEventListener('click', async () => {
  try {
    const r = await apiFetch(_BASE+'/api/backup/create', { method: 'POST' });
    const data = await r.json();
    showStatus('backup-action-status', data.success ? '✓ ' + data.name : 'Failed', data.success);
    loadBackupList();
  } catch (e) {
    showStatus('backup-action-status', 'Error: ' + e.message, false);
  }
});

function backupDownload(name) {
  window.open(_BASE+'/api/backup/download/' + encodeURIComponent(name));
}

async function backupRestore(name) {
  const msg = currentLang === 'ja'
    ? `バックアップ "${name}" からリストアします。\n現在のデータは上書きされます（リストア前にバックアップが自動作成されます）。\n\n続行しますか？`
    : `Restore from "${name}"?\nCurrent data will be overwritten (a safety backup is created first).\n\nContinue?`;
  if (!confirm(msg)) return;
  try {
    const r = await apiFetch(_BASE+'/api/backup/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await r.json();
    showStatus('backup-action-status', data.success ? '✓ Restored. Reload recommended.' : data.error, data.success);
  } catch (e) {
    showStatus('backup-action-status', 'Error: ' + e.message, false);
  }
}

const backupUploadInput = document.getElementById('backup-upload-input');
if (backupUploadInput) backupUploadInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = currentLang === 'ja'
    ? `ファイル "${file.name}" からリストアします。\n現在のデータは上書きされます。\n\n続行しますか？`
    : `Restore from "${file.name}"?\nCurrent data will be overwritten.\n\nContinue?`;
  if (!confirm(msg)) { e.target.value = ''; return; }
  try {
    const buf = await file.arrayBuffer();
    const r = await apiFetch(_BASE+'/api/backup/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    const data = await r.json();
    showStatus('backup-action-status', data.success ? '✓ Restored. Reload recommended.' : data.error, data.success);
    loadBackupList();
  } catch (err) {
    showStatus('backup-action-status', 'Error: ' + err.message, false);
  }
  e.target.value = '';
});

// Load backup list when backup tab is opened
const backupTabBtn = document.querySelector('[data-tab="backup"]');
if (backupTabBtn) backupTabBtn.addEventListener('click', () => loadBackupList());
