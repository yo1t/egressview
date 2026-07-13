import { t } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, esc, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch, socket, setRouterList } from './auth-socket.js?v=__ASSET_VERSION__';

let routers = [];
let maxRouters = 10;

const byId = id => document.getElementById(id);
const editor = byId('router-editor');

function stateClass(router) {
  if (!router.enabled) return '';
  if (router.ready) return 'ready';
  return ['connecting', 'reconnecting'].includes(router.state) ? 'wait' : 'error';
}

function stateLabel(router) {
  if (!router.enabled) return t('settings.routers.disabled');
  if (router.ready) return `${t('settings.routers.connected')} · ${router.sessionCount || 0} sessions`;
  if (['connecting', 'reconnecting'].includes(router.state)) return t('settings.routers.connecting');
  return router.lastError || router.message || t('settings.routers.error');
}

function render() {
  byId('router-count').textContent = `${routers.length} / ${maxRouters}`;
  byId('router-add-btn').disabled = routers.length >= maxRouters;
  byId('router-list').innerHTML = routers.length ? routers.map(router => `
    <article class="router-card" data-router-id="${esc(router.id)}">
      <span class="router-card-dot ${stateClass(router)}"></span>
      <div>
        <div class="router-card-name">${esc(router.displayName)}</div>
        <div class="router-card-meta">${router.kind === 'yamaha' ? 'Yamaha RTX' : 'Cisco IOS'} · ${esc(router.ip)} · ${esc(stateLabel(router))}${router.lastSuccessAt ? ` · ${esc(fmtTs(router.lastSuccessAt))}` : ''}</div>
      </div>
      <div class="router-card-actions">
        <button class="router-icon-btn router-edit" type="button" data-id="${esc(router.id)}" title="${esc(t('settings.routers.edit'))}">Edit</button>
        <button class="router-icon-btn router-delete" type="button" data-id="${esc(router.id)}" title="${esc(t('settings.routers.delete'))}">×</button>
      </div>
    </article>`).join('') : `<div class="router-empty">${esc(t('settings.routers.empty'))}</div>`;

  document.querySelectorAll('.router-edit').forEach(button => button.addEventListener('click', () => openEditor(routers.find(r => r.id === button.dataset.id))));
  document.querySelectorAll('.router-delete').forEach(button => button.addEventListener('click', () => removeRouter(button.dataset.id)));
  setRouterList(routers);
}

function updateKindFields() {
  const isCisco = byId('router-kind').value === 'cisco';
  byId('router-nat-group').classList.toggle('hidden', isCisco);
  byId('router-enable-group').classList.toggle('hidden', !isCisco);
  byId('router-display-name').placeholder = isCisco ? 'Cisco IOS' : 'Yamaha RTX';
}

function openEditor(router = null) {
  byId('router-edit-id').value = router?.id || '';
  byId('router-kind').value = router?.kind || 'yamaha';
  byId('router-kind').disabled = !!router;
  byId('router-display-name').value = router?.displayName || '';
  byId('router-ip').value = router?.ip || '';
  byId('router-user').value = router?.user || '';
  byId('router-pass').value = '';
  byId('router-pass').placeholder = router?.passSet ? t('settings.pass.saved') : '';
  byId('router-enable-pass').value = '';
  byId('router-enable-pass').placeholder = router?.enablePassSet ? t('settings.pass.saved') : '';
  byId('router-nat').value = router?.nat || '100';
  byId('router-enabled').checked = router?.enabled ?? true;
  byId('router-editor-title').textContent = router ? t('settings.routers.editTitle') : t('settings.routers.addTitle');
  byId('router-editor-status').style.display = 'none';
  updateKindFields();
  editor.classList.remove('hidden');
  byId('router-ip').focus();
}

function closeEditor() { editor.classList.add('hidden'); }

function formData() {
  return {
    kind: byId('router-kind').value,
    displayName: byId('router-display-name').value.trim(),
    ip: byId('router-ip').value.trim(),
    user: byId('router-user').value.trim(),
    pass: byId('router-pass').value,
    enablePass: byId('router-enable-pass').value,
    nat: byId('router-nat').value.trim(),
    enabled: byId('router-enabled').checked,
  };
}

function showEditorStatus(message, ok) {
  const status = byId('router-editor-status');
  status.textContent = message;
  status.className = `settings-status ${ok ? 'ok' : 'err'}`;
  status.style.display = 'block';
}

async function loadRouters() {
  try {
    const response = await apiFetch(`${_BASE}/api/routers`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    routers = data.routers || [];
    maxRouters = data.maxRouters || 10;
    render();
  } catch (error) {
    byId('router-list').innerHTML = `<div class="router-empty">${esc(error.message)}</div>`;
  }
}

async function saveRouter() {
  const id = byId('router-edit-id').value;
  const button = byId('router-save-btn');
  button.disabled = true;
  try {
    const response = await apiFetch(id ? `${_BASE}/api/routers/${encodeURIComponent(id)}` : `${_BASE}/api/routers`, {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData()),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    closeEditor();
    await loadRouters();
  } catch (error) { showEditorStatus(error.message, false); }
  finally { button.disabled = false; }
}

async function detectRouter() {
  const button = byId('router-detect-btn');
  button.disabled = true;
  showEditorStatus(t('settings.routers.detecting'), true);
  try {
    const response = await apiFetch(`${_BASE}/api/routers/detect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...formData(), id: byId('router-edit-id').value || undefined }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    if (data.nat?.descriptor) byId('router-nat').value = data.nat.descriptor;
    const parts = [t('settings.routers.sshOk')];
    if (data.lan?.ip) parts.push(`LAN IP: ${data.lan.ip}`);
    if (data.nat) parts.push(`NAT sessions: ${data.nat.sessionsOk ? data.nat.sessions : t('settings.routers.unavailable')}`);
    showEditorStatus(parts.join(' · '), true);
  } catch (error) { showEditorStatus(error.message, false); }
  finally { button.disabled = false; }
}

async function removeRouter(id) {
  const router = routers.find(item => item.id === id);
  if (!router || !confirm(t('settings.routers.confirmDelete').replace('{name}', router.displayName))) return;
  const response = await apiFetch(`${_BASE}/api/routers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    alert(data.error || response.statusText);
    return;
  }
  if (byId('router-edit-id').value === id) closeEditor();
  await loadRouters();
}

byId('router-add-btn').addEventListener('click', () => openEditor());
byId('router-cancel-btn').addEventListener('click', closeEditor);
byId('router-kind').addEventListener('change', updateKindFields);
byId('router-save-btn').addEventListener('click', saveRouter);
byId('router-detect-btn').addEventListener('click', detectRouter);
socket.on('routers-status', next => { routers = next || []; render(); });

loadRouters();
