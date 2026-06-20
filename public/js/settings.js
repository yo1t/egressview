// ─── Settings modal ───────────────────────────────────────────────────────────
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

// Checkbox toggles enable/disable of input fields and updates the button label
function connectButtonLabel(btnId, enabled) {
  if (!enabled) return t('settings.btn.disable');
  return btnId === 'yamaha-connect-btn' ? t('settings.yamaha.saveSuggested') : t('settings.btn.connect');
}

function toggleSection(inputsId, checkboxId, btnId) {
  const enabled = document.getElementById(checkboxId).checked;
  document.getElementById(inputsId).classList.toggle('disabled', !enabled);
  if (btnId) {
    document.getElementById(btnId).textContent = connectButtonLabel(btnId, enabled);
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
    btn.textContent = connectButtonLabel(btnId, enabled);
  }
}

function renderYamahaDetectStatus(data, ok) {
  const el = document.getElementById('yamaha-detect-status');
  const natDescriptor = data?.nat?.descriptor || data?.suggested?.yamahaNat || '-';
  const lanIp = data?.lan?.ip || '-';
  const sessionsText = data?.nat?.sessionsOk
    ? (data.nat.sessions > 0 ? `${data.nat.sessions} ${t('settings.yamaha.sessions')}` : t('settings.yamaha.sessionsOk'))
    : t('settings.yamaha.sessionsFailed');
  const lines = ok ? [
    `${t('settings.yamaha.sshOk')}`,
    `${t('settings.yamaha.natDetected')}: ${natDescriptor}`,
    `${t('settings.yamaha.lanIp')}: ${lanIp}`,
    `${t('settings.yamaha.natSessions')}: ${sessionsText}`,
    `${t('settings.yamaha.suggestedReady')}`,
  ] : [data?.code ? t('err.' + data.code) : (data?.error || t('settings.yamaha.detectFailed'))];
  el.textContent = lines.join('\n');
  el.className = 'settings-status ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
  el.style.whiteSpace = 'pre-line';
}

document.getElementById('yamaha-detect-btn').addEventListener('click', async () => {
  const btn = document.getElementById('yamaha-detect-btn');
  const passEl = document.getElementById('s-yamaha-pass');
  const hasSavedPass = passEl.dataset.saved === 'true';
  const ip = document.getElementById('s-yamaha-ip').value.trim();
  const user = document.getElementById('s-yamaha-user').value.trim();
  const pass = passEl.value;
  if (!ip) { showStatus('yamaha-detect-status', t('err.ipRequired'), false); return; }
  if (!user) { showStatus('yamaha-detect-status', t('err.userRequired'), false); return; }
  if (!pass && !hasSavedPass) { showStatus('yamaha-detect-status', t('err.passRequired'), false); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>' + t('settings.yamaha.detecting');
  document.getElementById('yamaha-status').style.display = 'none';
  try {
    const body = {
      yamahaIp: ip,
      yamahaUser: user,
      yamahaNat: document.getElementById('s-yamaha-nat').value.trim() || undefined,
    };
    if (pass) body.yamahaPass = pass;
    const res = await apiFetch(_BASE+'/api/yamaha/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      renderYamahaDetectStatus(data, false);
      return;
    }
    if (data.suggested?.yamahaNat) document.getElementById('s-yamaha-nat').value = data.suggested.yamahaNat;
    if (data.suggested?.yamahaIp) document.getElementById('s-yamaha-ip').value = data.suggested.yamahaIp;
    if (data.suggested?.yamahaUser) document.getElementById('s-yamaha-user').value = data.suggested.yamahaUser;
    renderYamahaDetectStatus(data, true);
  } catch (err) {
    renderYamahaDetectStatus({ error: t('err.serverGeneric') + err.message }, false);
  } finally {
    btn.disabled = false;
    btn.textContent = t('settings.yamaha.detect');
  }
});

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
  const hasSavedPass = passEl.dataset.saved === 'true';
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
      info.textContent = '✗ ' + (data.error === 'user_not_found' ? t('settings.slack.userNotFound') : data.error);
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
      document.getElementById('s-slack-token').placeholder = t('settings.pass.saved');
      document.getElementById('s-slack-token').dataset.saved = 'true';
    }
  }).catch(() => {});
})();

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
      listEl.innerHTML = '<div style="padding:4px;">' + t('settings.backup.none') + '</div>';
      return;
    }
    listEl.innerHTML = data.backups.reverse().map(b => {
      const size = (b.size / 1024 / 1024).toFixed(1) + ' MB';
      const date = new Date(b.created).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US');
      return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="flex:1">${date} (${size})</span>
        <button class="connect-btn" style="font-size:9px;padding:2px 6px;" onclick="backupDownload('${b.name}')">DL</button>
        <button class="connect-btn" style="font-size:9px;padding:2px 6px;" onclick="backupRestore('${b.name}')">${t('settings.backup.restore')}</button>
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('backup-list').textContent = tVars('settings.error.withMessage', { message: e.message });
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
    showStatus('backup-config-status', tVars('settings.error.withMessage', { message: e.message }), false);
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

// ── Password change (P2-23) ───────────────────────────────────────────────────

document.getElementById('pw-change-btn').addEventListener('click', async () => {
  const btn = document.getElementById('pw-change-btn');
  const current = document.getElementById('s-pw-current').value;
  const next    = document.getElementById('s-pw-new').value;
  if (next.length < 8) {
    showStatus('pw-status', t('settings.password.tooShort'), false);
    return;
  }
  btn.disabled = true;
  try {
    const r = await apiFetch(_BASE+'/api/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: document.getElementById('s-pw-revoke-others').checked,
      }),
    });
    const data = await r.json();
    if (data.success) {
      document.getElementById('s-pw-current').value = '';
      document.getElementById('s-pw-new').value = '';
      showStatus('pw-status', tVars('settings.password.changed', { count: data.revoked }), true);
      loadSessionsList();
    } else {
      showStatus('pw-status', data.error || 'Error', false);
    }
  } catch (e) {
    showStatus('pw-status', tVars('settings.error.withMessage', { message: e.message }), false);
  } finally {
    btn.disabled = false;
  }
});

// ── Login sessions list (P2-23) ───────────────────────────────────────────────

async function loadSessionsList() {
  const box = document.getElementById('sessions-list');
  try {
    const r = await apiFetch(_BASE+'/api/auth/sessions');
    const { sessions } = await r.json();
    if (!sessions || !sessions.length) {
      box.innerHTML = `<span style="color:var(--muted)">${esc(t('settings.sessions.none'))}</span>`;
      return;
    }
    box.innerHTML = sessions.map(s => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <span style="flex:1">${esc(s.deviceLabel || 'Unknown device')}${s.current ? ` <span style="color:var(--green);font-size:9px">● ${esc(t('settings.sessions.current'))}</span>` : ''}</span>
        <span style="color:var(--muted);font-size:10px">${fmtTs(s.lastSeenAt)}</span>
        ${s.current ? '' : `<button class="beacon-dismiss-btn" data-session-id="${s.id}">${esc(t('settings.sessions.revoke'))}</button>`}
      </div>`).join('');
    box.querySelectorAll('[data-session-id]').forEach(b => {
      b.addEventListener('click', async () => {
        await apiFetch(_BASE+`/api/auth/sessions/${b.dataset.sessionId}/revoke`, { method: 'POST' });
        loadSessionsList();
      });
    });
  } catch (e) {
    box.innerHTML = `<span style="color:var(--muted)">Error: ${esc(e.message)}</span>`;
  }
}

document.getElementById('sessions-revoke-all-btn').addEventListener('click', async () => {
  try {
    const r = await apiFetch(_BASE+'/api/auth/sessions/revoke-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await r.json();
    showStatus('sessions-status', data.success ? `✓ ${data.revoked}` : (data.error || 'Error'), data.success);
    loadSessionsList();
  } catch (e) {
    showStatus('sessions-status', 'Error: ' + e.message, false);
  }
});

// Load sessions when the General tab is opened
const generalTabBtn = document.querySelector('[data-tab="general"]');
if (generalTabBtn) generalTabBtn.addEventListener('click', loadSessionsList);

// ── Beacon detection settings (P2-20) ─────────────────────────────────────────

async function loadBeaconConfig() {
  try {
    const r = await apiFetch(_BASE+'/api/beacons/config');
    const { config } = await r.json();
    if (!config) return;
    document.getElementById('s-beacon-enabled').checked = config.enabled !== false;
    document.getElementById('s-beacon-minobs').value    = config.minObs;
    document.getElementById('s-beacon-maxcov').value    = config.maxCov;
    document.getElementById('s-beacon-minint').value    = Math.round(config.minIntervalMs / 60000);
    document.getElementById('s-beacon-maxint').value    = Math.round(config.maxIntervalMs / 60000);
    document.getElementById('s-beacon-scaninterval').value = String(Math.round(config.scanIntervalMs / 60000));
    document.getElementById('s-beacon-whitelist').value = (config.whitelistDomains || []).join('\n');
    document.getElementById('s-beacon-orgs').value      = (config.orgAllowlist || []).join('\n');
  } catch (e) { /* settings pane stays at defaults */ }
}

document.getElementById('beacon-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('beacon-save-btn');
  btn.disabled = true;
  try {
    const lines = id => document.getElementById(id).value
      .split('\n').map(s => s.trim()).filter(Boolean);
    const body = {
      enabled:          document.getElementById('s-beacon-enabled').checked,
      minObs:           parseInt(document.getElementById('s-beacon-minobs').value, 10) || 4,
      maxCov:           parseFloat(document.getElementById('s-beacon-maxcov').value) || 0.5,
      minIntervalMs:    (parseInt(document.getElementById('s-beacon-minint').value, 10) || 1) * 60000,
      maxIntervalMs:    (parseInt(document.getElementById('s-beacon-maxint').value, 10) || 240) * 60000,
      scanIntervalMs:   parseInt(document.getElementById('s-beacon-scaninterval').value, 10) * 60000,
      whitelistDomains: lines('s-beacon-whitelist'),
      orgAllowlist:     lines('s-beacon-orgs'),
    };
    const r = await apiFetch(_BASE+'/api/beacons/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.success) {
      showStatus('beacon-status', t('settings.beacon.savedScanning'), true);
      if (typeof loadBeacons === 'function') setTimeout(loadBeacons, 2000); // refresh banner after rescan
    } else {
      showStatus('beacon-status', data.error || t('settings.error.generic'), false);
    }
  } catch (e) {
    showStatus('beacon-status', tVars('settings.error.withMessage', { message: e.message }), false);
  } finally {
    btn.disabled = false;
  }
});

// Load beacon config when the threat tab is opened
const threatTabBtn = document.querySelector('[data-tab="threat"]');
if (threatTabBtn) threatTabBtn.addEventListener('click', loadBeaconConfig);

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
  const msg = tVars('settings.backup.confirmRestore', { name });
  if (!confirm(msg)) return;
  try {
    const r = await apiFetch(_BASE+'/api/backup/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await r.json();
    showStatus('backup-action-status', data.success ? t('settings.backup.restored') : data.error, data.success);
  } catch (e) {
    showStatus('backup-action-status', tVars('settings.error.withMessage', { message: e.message }), false);
  }
}

const backupUploadInput = document.getElementById('backup-upload-input');
if (backupUploadInput) backupUploadInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = tVars('settings.backup.confirmUpload', { name: file.name });
  if (!confirm(msg)) { e.target.value = ''; return; }
  try {
    const buf = await file.arrayBuffer();
    const r = await apiFetch(_BASE+'/api/backup/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    const data = await r.json();
    showStatus('backup-action-status', data.success ? t('settings.backup.restored') : data.error, data.success);
    loadBackupList();
  } catch (err) {
    showStatus('backup-action-status', tVars('settings.error.withMessage', { message: err.message }), false);
  }
  e.target.value = '';
});

// Load backup list when backup tab is opened
const backupTabBtn = document.querySelector('[data-tab="backup"]');
if (backupTabBtn) backupTabBtn.addEventListener('click', () => loadBackupList());
