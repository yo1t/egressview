import { t } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch, authReady, socket, setRouterList } from './auth-socket.js?v=__ASSET_VERSION__';

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

function routerTextElement(tagName, text, { className = '', title = '' } = {}) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (title) element.title = title;
  element.textContent = text == null ? '' : String(text);
  return element;
}

function createRouterAction(router, action, label, title, handler) {
  const button = routerTextElement('button', label, {
    className: `router-icon-btn router-${action}`,
    title,
  });
  button.type = 'button';
  button.dataset.id = String(router.id ?? '');
  button.addEventListener('click', handler);
  return button;
}

function createRouterCard(router) {
  const card = document.createElement('article');
  card.className = 'router-card';
  card.dataset.routerId = String(router.id ?? '');
  const status = stateClass(router);
  card.appendChild(routerTextElement('span', '', {
    className: `router-card-dot${status ? ` ${status}` : ''}`,
  }));

  const details = document.createElement('div');
  details.appendChild(routerTextElement('div', router.displayName, { className: 'router-card-name' }));
  const labels = { yamaha: 'Yamaha RTX', cisco: 'Cisco IOS', conntrack: 'Linux conntrack' };
  const meta = [
    labels[router.kind] || router.kind,
    router.ip,
    stateLabel(router),
  ];
  if (router.lastSuccessAt) meta.push(fmtTs(router.lastSuccessAt));
  details.appendChild(routerTextElement('div', meta.join(' · '), { className: 'router-card-meta' }));
  card.appendChild(details);

  const actions = document.createElement('div');
  actions.className = 'router-card-actions';
  actions.appendChild(createRouterAction(
    router, 'edit', 'Edit', t('settings.routers.edit'), () => openEditor(router)
  ));
  actions.appendChild(createRouterAction(
    router, 'delete', '×', t('settings.routers.delete'), () => removeRouter(router.id)
  ));
  card.appendChild(actions);
  return card;
}

function render() {
  byId('router-count').textContent = `${routers.length} / ${maxRouters}`;
  byId('router-add-btn').disabled = routers.length >= maxRouters;
  const list = byId('router-list');
  if (routers.length) list.replaceChildren(...routers.map(createRouterCard));
  else list.replaceChildren(routerTextElement('div', t('settings.routers.empty'), { className: 'router-empty' }));
  setRouterList(routers);
}

function updateKindFields() {
  const kind = byId('router-kind').value;
  const isCisco = kind === 'cisco';
  byId('router-nat-group').classList.toggle('hidden', kind !== 'yamaha');
  byId('router-enable-group').classList.toggle('hidden', !isCisco);
  byId('router-display-name').placeholder = {
    yamaha: 'Yamaha RTX', cisco: 'Cisco IOS', conntrack: 'Linux conntrack',
  }[kind];
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
  byId('router-editor-status').classList.remove('is-visible');
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
  status.className = `settings-status ${ok ? 'ok' : 'err'} is-visible`;
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
    byId('router-list').replaceChildren(
      routerTextElement('div', error.message, { className: 'router-empty' })
    );
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

authReady.then(loadRouters).catch(error => {
  byId('router-list').replaceChildren(
    routerTextElement('div', error.message, { className: 'router-empty' })
  );
});
