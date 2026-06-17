// ─── Socket.IO ────────────────────────────────────────────────────────────────
// ─── Admin token auth (saved in localStorage) ─────────────────────────
const TOKEN_KEY = 'widemap_admin_token';
let adminToken = localStorage.getItem(TOKEN_KEY) || '';

// Short device label sent at login so the sessions list in settings is readable
function describeThisDevice() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
                : /Chrome\//.test(ua) ? 'Chrome'
                : /Firefox\//.test(ua) ? 'Firefox'
                : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS'
           : /Android/.test(ua) ? 'Android'
           : /Mac/.test(ua) ? 'macOS'
           : /Windows/.test(ua) ? 'Windows'
           : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function refreshSavedPlaceholders() {
  ['s-asus-pass', 's-yamaha-pass', 's-slack-token'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.dataset.saved === 'true') el.placeholder = t('settings.pass.saved');
  });
}

// Password login → per-device session token, stored under the same key so
// apiFetch / Socket.IO need no changes.  A legacy admin token already in
// localStorage keeps working — the server accepts both credentials.
async function promptAdminToken(reason = '') {
  while (true) {
    const pw = prompt((reason ? reason + '\n\n' : '') + t('prompt.password'));
    if (pw === null) { alert(t('alert.passwordRequired')); continue; }
    try {
      const r = await fetch(_BASE+'/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, deviceLabel: describeThisDevice() }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.token) {
        adminToken = data.token;
        localStorage.setItem(TOKEN_KEY, data.token);
        return;
      }
      alert(data.error || t('err.passwordInvalid'));
    } catch (e) {
      alert(t('err.serverGeneric') + e.message);
    }
  }
}
// On startup, show dialog if no saved token
// Apply i18n once on startup (default 'ja' before config arrives) as a safeguard
applyI18n();
if (!adminToken) {
  promptAdminToken().then(() => location.reload());
}

// Wrapper that auto-adds the token header to every fetch
async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}), 'X-Admin-Token': adminToken };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    // Session expired or revoked → log in again
    localStorage.removeItem(TOKEN_KEY);
    adminToken = '';
    await promptAdminToken(t('err.sessionExpired'));
    return apiFetch(url, opts); // retry
  }
  return res;
}

const socket = io({ path: _BASE+'/socket.io/', auth: { token: adminToken } });
socket.on('connect_error', err => {
  if (String(err.message).toLowerCase().includes('unauth')) {
    localStorage.removeItem(TOKEN_KEY);
    adminToken = '';
    promptAdminToken(t('err.sessionExpired'))
      .then(() => location.reload());
  }
});
const dot = document.getElementById('status-dot');
const errorBanner = document.getElementById('error-banner');

socket.on('connect', () => { dot.className = 'status-dot online'; errorBanner.style.display = 'none'; });
socket.on('disconnect', () => { dot.className = 'status-dot error'; });

let asusActive      = false; // becomes true upon receiving network-update
let yamahaConfigured = true; // mirrors the server-side yamahaEnabled state
let notesMap = {}; // { "ip|mac" or "ip" or "mac": "note" }

// Re-render the note display of every device card (after note save / notes-update)
function refreshAllNotes() {
  document.querySelectorAll('.device-card').forEach(card => {
    const mac = card.dataset.mac;
    const c = (lastClients || []).find(c => c.mac === mac);
    if (!c) return;
    const dev = devicesData.find(d => d.mac === mac || d.ip === c.ip);
    const noteText = lookupNote(c.ip, c.mac, dev?.deviceId);
    const noteEl = card.querySelector('.device-note');
    if (!noteEl) return;
    if (noteText) {
      noteEl.textContent = noteText;
      noteEl.className = 'device-note';
    } else {
      noteEl.textContent = '';
      noteEl.className = 'device-note empty';
    }
  });
}

// Look up a note using deviceId (preferred), IP, or MAC.
// Pass deviceId when available so UUID-keyed notes (set by POST /api/notes) are found correctly.
function lookupNote(ip, mac, deviceId) {
  if (deviceId && notesMap[deviceId] != null) return notesMap[deviceId];
  if (ip && mac && notesMap[`${ip}|${mac}`]) return notesMap[`${ip}|${mac}`];
  // Search entries that match by only one of ip/mac
  for (const k of Object.keys(notesMap)) {
    const [kip, kmac] = k.split('|');
    if (ip && kip === ip)  return notesMap[k];
    if (mac && (kmac === mac || (!kmac && kip === mac))) return notesMap[k];
  }
  return '';
}

// ── Note modal ─────────────────────────────────────────────────
let noteEditIp = null;
let noteEditMac = null;
const noteOverlay = document.getElementById('note-overlay');
function openNoteModal(ip, mac, displayName) {
  noteEditIp = ip;
  noteEditMac = mac;
  const idLabel = [ip, mac].filter(Boolean).join(' / ');
  document.getElementById('note-target').textContent = `${displayName || ''} (${idLabel})`;
  const ta = document.getElementById('note-textarea');
  ta.value = lookupNote(ip, mac);
  ta.placeholder = t('note.placeholder');
  noteOverlay.classList.remove('hidden');
  setTimeout(() => ta.focus(), 50);
}
function closeNoteModal() {
  noteOverlay.classList.add('hidden');
  noteEditIp = null;
  noteEditMac = null;
}
noteOverlay.addEventListener('click', e => { if (e.target === noteOverlay) closeNoteModal(); });
document.getElementById('note-cancel').addEventListener('click', closeNoteModal);
document.getElementById('note-save').addEventListener('click', async () => {
  if (!noteEditIp && !noteEditMac) return;
  const note = document.getElementById('note-textarea').value;
  try {
    await apiFetch(_BASE+'/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: noteEditIp, mac: noteEditMac, note }),
    });
    // Update local state too (server also broadcasts)
    const key = (noteEditIp && noteEditMac) ? `${noteEditIp}|${noteEditMac}`
              : noteEditIp || noteEditMac;
    // Clean up related existing entries before writing
    for (const k of Object.keys(notesMap)) {
      const [kip, kmac] = k.split('|');
      if ((noteEditIp && kip === noteEditIp) || (noteEditMac && (kmac === noteEditMac || kip === noteEditMac))) {
        delete notesMap[k];
      }
    }
    if (note.trim()) notesMap[key] = note.trim();
    refreshAllNotes();
    closeNoteModal();
  } catch (e) {
    alert(t('err.serverGeneric') + e.message);
  }
});
document.getElementById('note-investigate-btn').addEventListener('click', async () => {
  if (!noteEditIp) {
    alert(t('note.investigate.noIp'));
    return;
  }
  const btn = document.getElementById('note-investigate-btn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('note.investigating');
  try {
    const r = await apiFetch(_BASE+'/api/notes/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: noteEditIp }),
    });
    const data = await r.json();
    const ta = document.getElementById('note-textarea');
    const sep = ta.value ? '\n---\n' : '';
    ta.value = ta.value + sep + (data.draft || '(no info)');
  } catch (e) {
    alert(t('note.investigate.fail') + ': ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// ── Connection badge management ────────────────────────────
const connState = {
  l3l4: { enabled: false, ready: false, ip: '', err: '' },
  l2:   { enabled: false, ready: false, ip: '', err: '' },
};
function updateConnBadge(key) {
  const s = connState[key];
  const badge = document.getElementById('badge-' + key);
  const ipEl  = document.getElementById('badge-' + key + '-ip');
  const prefix = (key === 'l3l4' ? 'L3/L4 Yamaha' : 'L2 ASUS');
  badge.classList.remove('on', 'off', 'err', 'wait');
  if (!s.enabled) {
    badge.classList.add('off');
    ipEl.textContent = t('badge.unused');
    badge.title = prefix + ' — ' + t('badge.unused');
  } else if (s.ready) {
    badge.classList.add('on');
    ipEl.textContent = s.ip || t('badge.ready');
    badge.title = prefix + ' — ' + t('badge.ready') + ' ' + (s.ip || '');
  } else {
    const isWaiting = !s.err || s.err === 'connecting' || s.err === 'reconnecting';
    badge.classList.add(isWaiting ? 'wait' : 'err');
    // s.err is an internal state string; translate for display
    const errLabel = s.err === 'session-expired' ? t('badge.timeout')
                   : s.err === 'failed'          ? t('badge.error')
                   : s.err === 'connecting'      ? t('badge.waiting')
                   : s.err === 'reconnecting'    ? t('badge.waiting')
                   : s.err || t('badge.waiting');
    ipEl.textContent = errLabel;
    badge.title = prefix + ' — ' + errLabel;
  }
}

socket.on('config', cfg => {
  if (cfg.routerIp)   document.getElementById('s-asus-ip').value       = cfg.routerIp;
  if (cfg.asusUser)   document.getElementById('s-asus-user').value     = cfg.asusUser;
  if (cfg.yamahaIp)   document.getElementById('s-yamaha-ip').value     = cfg.yamahaIp;
  if (cfg.yamahaUser) document.getElementById('s-yamaha-user').value   = cfg.yamahaUser;
  if (cfg.yamahaNat)  document.getElementById('s-yamaha-nat').value    = cfg.yamahaNat;
  // Passwords are not sent in plaintext for security; show "saved" placeholder instead
  const asusPwEl = document.getElementById('s-asus-pass');
  asusPwEl.placeholder = cfg.asusPassSet ? t('settings.pass.saved') : t('settings.pass.empty');
  asusPwEl.dataset.saved = cfg.asusPassSet ? 'true' : 'false';
  const yamahaPwEl = document.getElementById('s-yamaha-pass');
  yamahaPwEl.placeholder = cfg.yamahaPassSet ? t('settings.pass.saved') : t('settings.pass.empty');
  yamahaPwEl.dataset.saved = cfg.yamahaPassSet ? 'true' : 'false';
  if (cfg.yamahaEnabled !== undefined) {
    yamahaConfigured = cfg.yamahaEnabled;
    document.getElementById('enable-yamaha').checked = yamahaConfigured;
    toggleSection('yamaha-inputs', 'enable-yamaha', 'yamaha-connect-btn');
    connState.l3l4.enabled = cfg.yamahaEnabled;
    connState.l3l4.ready   = !!cfg.yamahaReady;
    connState.l3l4.ip      = cfg.yamahaIp || '';
    connState.l3l4.err     = cfg.yamahaEnabled && !cfg.yamahaReady ? 'connecting' : '';
    updateConnBadge('l3l4');
  }
  if (cfg.asusEnabled !== undefined) {
    document.getElementById('enable-asus').checked = cfg.asusEnabled;
    toggleSection('asus-inputs', 'enable-asus', 'asus-connect-btn');
    connState.l2.enabled = cfg.asusEnabled;
    connState.l2.ready   = !!cfg.authenticated;
    connState.l2.ip      = cfg.routerIp || '';
    updateConnBadge('l2');
  }
  if (cfg.homeCountry) {
    homeCountry = cfg.homeCountry;
    document.getElementById('s-home-country').value = homeCountry;
  }
  if (cfg.notes) {
    notesMap = cfg.notes;
    refreshAllNotes();
  }
  if (typeof cfg.autoInvestigate === 'boolean') {
    document.getElementById('s-auto-investigate').checked = cfg.autoInvestigate;
  }
  if (cfg.retentionDays) {
    document.getElementById('s-retention').value = String(cfg.retentionDays);
    document.getElementById('s-retention').dataset.saved = String(cfg.retentionDays);
  }
  if (cfg.language && cfg.language !== currentLang) {
    currentLang = cfg.language;
    document.getElementById('s-language').value = currentLang;
    applyI18n();
    refreshSavedPlaceholders();
    // Re-render dynamic UI (existing badges/statuses) too
    Object.keys(connState).forEach(updateConnBadge);
  } else if (cfg.language) {
    document.getElementById('s-language').value = cfg.language;
  }
  if (cfg.asusEnabled && !cfg.authenticated) {
    document.getElementById('disconnected-banner').style.display = 'block';
    settingsBtn.classList.add('alert');
  }
  // Data sources
  if (cfg.dnsmasqLogFile) {
    document.getElementById('s-dnsmasq-logfile').value = cfg.dnsmasqLogFile;
  }
  if (typeof cfg.dnsmasqEnabled === 'boolean') {
    document.getElementById('enable-dnsmasq').checked = cfg.dnsmasqEnabled;
    toggleSection('dnsmasq-inputs', 'enable-dnsmasq', null);
  }
  if (cfg.inspectLogFile) {
    document.getElementById('s-inspect-logfile').value = cfg.inspectLogFile;
  }
  if (typeof cfg.inspectEnabled === 'boolean') {
    document.getElementById('enable-inspect').checked = cfg.inspectEnabled;
    toggleSection('inspect-inputs', 'enable-inspect', null);
  }
  if (cfg.dhcpdLogFile) {
    document.getElementById('s-dhcpd-logfile').value = cfg.dhcpdLogFile;
  }
  if (typeof cfg.dhcpdEnabled === 'boolean') {
    document.getElementById('enable-dhcpd').checked = cfg.dhcpdEnabled;
    toggleSection('dhcpd-inputs', 'enable-dhcpd', null);
  }
});

// Save general settings
document.getElementById('general-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('general-save-btn');
  const newCountry = document.getElementById('s-home-country').value;
  const newLang    = document.getElementById('s-language').value;
  const newAuto    = document.getElementById('s-auto-investigate').checked;
  const newRetention = parseInt(document.getElementById('s-retention').value);
  // Confirm if retention is being shortened
  const currentRetention = parseInt(document.getElementById('s-retention').dataset.saved || '730');
  if (newRetention < currentRetention) {
    const msg = tVars('settings.confirm.retention', { current: currentRetention, next: newRetention });
    if (!confirm(msg)) { btn.disabled = false; btn.textContent = t('settings.btn.save'); return; }
  }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + t('settings.btn.saving');
  try {
    const res = await apiFetch(_BASE+'/api/config/general', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeCountry: newCountry, language: newLang, autoInvestigate: newAuto, retentionDays: newRetention }),
    });
    if (res.ok) {
      homeCountry = newCountry;
      if (newLang !== currentLang) {
        currentLang = newLang;
        applyI18n();
        refreshSavedPlaceholders();
        Object.keys(connState).forEach(updateConnBadge);
        if (typeof renderBeaconBanner === 'function') renderBeaconBanner();
        if (typeof updateLogView === 'function' && currentView === 'log') updateLogView();
        if (typeof renderDevicesTable === 'function' && currentView === 'devices') renderDevicesTable();
        if (typeof updateFilterTabs === 'function' && lastMeshNodes && lastClients) updateFilterTabs(lastMeshNodes, lastMainMac || '', lastClients);
        // Re-render stats if shown (to update legend labels)
        if (statsMode) updateStats();
      }
      showStatus('general-status', t('settings.status.saved'), true);
      document.getElementById('s-retention').dataset.saved = String(newRetention);
      // Reset stats maps so they rebuild with new rotation on next visit
      if (typeof stFlatSvg !== 'undefined') { stFlatSvg = null; stGlobeSvg = null; stGlobeRotate = null; }
      if (statsMode && worldGeo) initStatsMaps(true);
    } else {
      showStatus('general-status', t('settings.status.saveFailed'), false);
    }
  } catch (e) {
    showStatus('general-status', tVars('settings.error.withMessage', { message: e.message }), false);
  } finally {
    btn.disabled = false; btn.textContent = t('settings.btn.save');
  }
});

// Save threat settings (client-side only for now — stored in localStorage)
document.getElementById('threat-save-btn').addEventListener('click', () => {
  const config = {
    feeds: {
      feodo: document.getElementById('s-feed-feodo').checked,
      threatfox: document.getElementById('s-feed-threatfox').checked,
      urlhaus: document.getElementById('s-feed-urlhaus').checked,
      spamhaus: document.getElementById('s-feed-spamhaus').checked,
    },
    intervalMin: parseInt(document.getElementById('s-threat-interval').value),
  };
  localStorage.setItem('widemap_threat_config', JSON.stringify(config));
  showStatus('threat-status', t('settings.status.saved'), true);
});
