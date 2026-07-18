import { t } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, setButtonLoading } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch, connState, updateConnBadge, asusActive, setAsusActive, setYamahaConfigured, routerState } from './auth-socket.js?v=__ASSET_VERSION__';
import { setAllConnections, setDataRangeFrom } from './connections-panel.js?v=__ASSET_VERSION__';
import { stopGraph, updateOrgGraph, simulation } from './graph.js?v=__ASSET_VERSION__';

const settingsOverlay = document.getElementById('settings-overlay');
function closeSettings() { settingsOverlay.classList.add('hidden'); }
function showStatus(elId, msg, ok) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = 'settings-status is-visible ' + (ok ? 'ok' : 'err');
}

// Checkbox toggles enable/disable of input fields and updates the button label
function connectButtonLabel(btnId, enabled) {
  if (!enabled) return t('settings.btn.disable');
  if (btnId === 'yamaha-connect-btn') return t('settings.yamaha.saveSuggested');
  if (btnId === 'cisco-connect-btn')  return t('settings.cisco.saveSuggested');
  return t('settings.btn.connect');
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
document.getElementById('enable-cisco').addEventListener('change',
  () => toggleSection('cisco-inputs', 'enable-cisco', 'cisco-connect-btn'));
document.getElementById('enable-asus').addEventListener('change',
  () => toggleSection('asus-inputs', 'enable-asus', 'asus-connect-btn'));

async function connectRouter(body, statusId, btnId, checkboxId) {
  const btn = document.getElementById(btnId);
  const enabled = checkboxId ? document.getElementById(checkboxId).checked : true;
  btn.disabled = true;
  setButtonLoading(btn, enabled ? t('settings.btn.connecting') : t('settings.btn.disabling'));
  document.getElementById(statusId).classList.remove('is-visible');
  try {
    const res = await apiFetch(_BASE+'/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      if (data.routerIp) { connState.l2.ip = data.routerIp; updateConnBadge('l2'); }
      document.getElementById('disconnected-banner').classList.remove('is-visible');
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
  const lanIp = data?.lan?.ip || data?.diag?.lanIp || '-';
  const sessionsText = data?.nat?.sessionsOk
    ? (data.nat.sessions > 0 ? `${data.nat.sessions} ${t('settings.yamaha.sessions')}` : t('settings.yamaha.sessionsOk'))
    : t('settings.yamaha.sessionsFailed');

  let lines;
  if (ok && data?.nat?.ok) {
    lines = [
      `✓ ${t('settings.yamaha.sshOk')}`,
      `✓ ${t('settings.yamaha.natDetected')}: ${natDescriptor}`,
      `  ${t('settings.yamaha.lanIp')}: ${lanIp}`,
      `  ${t('settings.yamaha.natSessions')}: ${sessionsText}`,
      `✓ ${t('settings.yamaha.suggestedReady')}`,
    ];
  } else if (ok && !data?.nat?.ok) {
    const candidateStr = data?.diag?.natCandidates
      ?.map(c => `${c.candidate}${c.ok ? '✓' : '✗'}`)
      .join(' ') || '-';
    lines = [
      `✓ ${t('settings.yamaha.sshOk')}`,
      `✗ ${t('settings.yamaha.natNotFound')}`,
      `  ${t('settings.yamaha.natTriedCandidates')}: ${candidateStr}`,
      `  ${t('settings.yamaha.lanIp')}: ${lanIp}`,
      `  ${t('settings.yamaha.natHint')}`,
    ];
  } else if (data?.diag?.ssh?.ok === false) {
    const code = data.diag.ssh.code || 'unknown';
    lines = [
      `✗ ${t('settings.yamaha.sshFailed')}`,
      `  ${t('settings.yamaha.sshError.' + code)}`,
    ];
  } else {
    lines = [data?.code ? t('err.' + data.code) : (data?.error || t('settings.yamaha.detectFailed'))];
  }

  el.textContent = lines.join('\n');
  el.className = 'settings-status multiline is-visible ' + (ok ? 'ok' : 'err');
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
  setButtonLoading(btn, t('settings.yamaha.detecting'));
  document.getElementById('yamaha-status').classList.remove('is-visible');
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
    setYamahaConfigured(doYamaha);
    routerState.yamaha.enabled = doYamaha;
    routerState.yamaha.ready   = false;    // wait for yamaha-status event for connection result
    if (doYamaha && body.yamahaIp) routerState.yamaha.ip = body.yamahaIp;
    connState.l3l4.enabled = doYamaha || routerState.cisco.enabled;
    connState.l3l4.ready   = routerState.cisco.ready; // keep ready if Cisco is still alive
    connState.l3l4.err     = '';
    if (doYamaha && body.yamahaIp) connState.l3l4.ip = body.yamahaIp;
    updateConnBadge('l3l4');
    if (!doYamaha && !routerState.cisco.enabled) {
      setAllConnections([]);
      setDataRangeFrom(Date.now() - 86400_000);
      if (!asusActive) stopGraph();
      else if (simulation) updateOrgGraph();
    }
  }
});

// ── Cisco detect ─────────────────────────────────────────────────────────────

function renderCiscoDetectStatus(data, ok) {
  const el = document.getElementById('cisco-detect-status');
  const lanIp = data?.lan?.ip || data?.diag?.lanIp || '-';
  const sessionsText = data?.nat?.sessionsOk
    ? (data.nat.sessions > 0 ? `${data.nat.sessions} ${t('settings.cisco.sessions')}` : t('settings.cisco.sessionsOk'))
    : t('settings.cisco.sessionsFailed');
  let lines;
  if (ok && data?.nat?.ok) {
    lines = [
      `✓ ${t('settings.cisco.sshOk')}`,
      `  ${t('settings.cisco.lanIp')}: ${lanIp}`,
      `  ${t('settings.cisco.natSessions')}: ${sessionsText}`,
      `✓ ${t('settings.cisco.suggestedReady')}`,
    ];
  } else if (ok && data?.diag?.privilegeError) {
    // SSH succeeded but not in privileged mode, so the NAT table can't be read (enable password missing/incorrect)
    lines = [
      `✓ ${t('settings.cisco.sshOk')}`,
      `✗ ${t('settings.cisco.privilegeError')}`,
    ];
  } else if (data?.diag?.ssh?.ok === false) {
    const code = data.diag.ssh.code || 'unknown';
    lines = [
      `✗ ${t('settings.cisco.sshFailed')}`,
      `  ${t('settings.cisco.sshError.' + code)}`,
    ];
  } else {
    lines = [data?.code ? t('err.' + data.code) : (data?.error || t('settings.cisco.detectFailed'))];
  }
  el.textContent = lines.join('\n');
  // Don't show a success style if the NAT table couldn't be read, even on HTTP 200
  el.className = 'settings-status multiline is-visible ' + ((ok && data?.nat?.ok) ? 'ok' : 'err');
}

document.getElementById('cisco-detect-btn').addEventListener('click', async () => {
  const btn = document.getElementById('cisco-detect-btn');
  const passEl = document.getElementById('s-cisco-pass');
  const hasSavedPass = passEl.dataset.saved === 'true';
  const ip   = document.getElementById('s-cisco-ip').value.trim();
  const user = document.getElementById('s-cisco-user').value.trim();
  const pass = passEl.value;
  if (!ip)   { showStatus('cisco-detect-status', t('err.ipRequired'),   false); return; }
  if (!user) { showStatus('cisco-detect-status', t('err.userRequired'), false); return; }
  if (!pass && !hasSavedPass) { showStatus('cisco-detect-status', t('err.passRequired'), false); return; }

  btn.disabled = true;
  setButtonLoading(btn, t('settings.cisco.detecting'));
  document.getElementById('cisco-status').classList.remove('is-visible');
  try {
    const body = { ciscoIp: ip, ciscoUser: user };
    if (pass) body.ciscoPass = pass;
    const enablePass = document.getElementById('s-cisco-enable-pass').value;
    if (enablePass) body.ciscoEnablePass = enablePass;
    const res = await apiFetch(_BASE+'/api/cisco/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { renderCiscoDetectStatus(data, false); return; }
    if (data.suggested?.ciscoIp)   document.getElementById('s-cisco-ip').value   = data.suggested.ciscoIp;
    if (data.suggested?.ciscoUser) document.getElementById('s-cisco-user').value = data.suggested.ciscoUser;
    renderCiscoDetectStatus(data, true);
  } catch (err) {
    renderCiscoDetectStatus({ error: t('err.serverGeneric') + err.message }, false);
  } finally {
    btn.disabled = false;
    btn.textContent = t('settings.cisco.detect');
  }
});

// Apply Cisco settings (L3/L4 tab)
document.getElementById('cisco-connect-btn').addEventListener('click', async () => {
  const doCisco = document.getElementById('enable-cisco').checked;
  const body = { doCisco };
  if (doCisco) {
    body.ciscoIp   = document.getElementById('s-cisco-ip').value.trim()   || undefined;
    body.ciscoUser = document.getElementById('s-cisco-user').value.trim() || undefined;
    const pw = document.getElementById('s-cisco-pass').value;
    if (pw) body.ciscoPass = pw;
    const ep = document.getElementById('s-cisco-enable-pass').value;
    if (ep) body.ciscoEnablePass = ep;
  }
  const ok = await connectRouter(body, 'cisco-status', 'cisco-connect-btn', 'enable-cisco');
  if (ok) {
    routerState.cisco.enabled = doCisco;
    routerState.cisco.ready   = false;     // wait for cisco-status event for connection result
    if (doCisco && body.ciscoIp) routerState.cisco.ip = body.ciscoIp;
    connState.l3l4.enabled = doCisco || routerState.yamaha.enabled;
    connState.l3l4.ready   = routerState.yamaha.ready; // keep ready if Yamaha is still alive
    connState.l3l4.err     = '';
    if (doCisco && body.ciscoIp) connState.l3l4.ip = body.ciscoIp;
    updateConnBadge('l3l4');
    if (!doCisco && !routerState.yamaha.enabled) {
      setAllConnections([]);
      setDataRangeFrom(Date.now() - 86400_000);
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
    if (!doAsus) { setAsusActive(false); stopGraph(); }
  }
});


export { toggleSection };
