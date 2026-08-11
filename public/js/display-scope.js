import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';

const STORAGE_KEY = 'egressview_display_scope_v1';
const AGENT_ONLINE_WINDOW_MS = 5 * 60 * 1000;
const VALID_SOURCE_KINDS = new Set(['router', 'agent']);

let displayScope = null;
let rawRouters = [];
let rawAgents = [];
let routerSources = [];
let agentSources = [];
let routerCatalogLoaded = false;
let agentCatalogLoaded = false;
let selector = null;
let fallbackNotifier = null;
let changeHandler = null;

function isControlCharacter(character) {
  const code = character.charCodeAt(0);
  return code <= 31 || (code >= 127 && code <= 159);
}

function normalizeDisplayText(value, maxLength = 80) {
  return Array.from(String(value ?? ''), character => isControlCharacter(character) ? ' ' : character)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function shortSourceId(value) {
  const normalized = normalizeDisplayText(value, 128);
  return normalized ? normalized.slice(0, 8) : 'unknown';
}

function normalizeScope(value) {
  if (!value || typeof value !== 'object') return null;
  const sourceKind = String(value.sourceKind || '');
  const sourceId = String(value.sourceId ?? '').trim();
  if (!sourceId || sourceId.length > 128 || Array.from(sourceId).some(isControlCharacter)) return null;
  return VALID_SOURCE_KINDS.has(sourceKind) && sourceId ? { sourceKind, sourceId } : null;
}

function scopeValue(scope) {
  const normalized = normalizeScope(scope);
  return normalized ? JSON.stringify(normalized) : '';
}

function parseScopeValue(value) {
  if (!value) return null;
  try {
    return normalizeScope(JSON.parse(value));
  } catch (_) {
    return null;
  }
}

function loadStoredScope(storage = localStorage) {
  try {
    return parseScopeValue(storage.getItem(STORAGE_KEY));
  } catch (_) {
    return null;
  }
}

function persistScope(scope, storage = localStorage) {
  try {
    if (scope) storage.setItem(STORAGE_KEY, scopeValue(scope));
    else storage.removeItem(STORAGE_KEY);
  } catch (_) { /* Browser privacy settings can make storage unavailable. */ }
}

function activeRouterSources(routers) {
  return (Array.isArray(routers) ? routers : [])
    .filter(router => router?.enabled && router.id)
    .map(router => {
      const displayName = normalizeDisplayText(router.hostName || router.displayName)
        || normalizeDisplayText(router.kind)
        || t('source.router.fallback');
      const managementIp = normalizeDisplayText(router.ip, 64);
      return {
        sourceKind: 'router',
        sourceId: String(router.id),
        label: managementIp ? `${displayName} (${managementIp})` : displayName,
        ready: !!router.ready,
        state: router.state || (router.ready ? 'ready' : 'connecting'),
      };
    });
}

function activeAgentSources(agents, now = Date.now()) {
  const active = (Array.isArray(agents) ? agents : []).filter(agent => agent?.agentId && !agent.revokedAt);
  const names = active.map(agent => normalizeDisplayText(agent.hostName));
  const nameCounts = new Map();
  names.forEach(name => {
    if (!name) return;
    const key = name.toLocaleLowerCase();
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });
  return active.map((agent, index) => {
    const shortId = shortSourceId(agent.agentId);
    const name = names[index];
    const duplicate = name && nameCounts.get(name.toLocaleLowerCase()) > 1;
    const baseLabel = name
      ? `${name}${duplicate ? ` (${shortId})` : ''}`
      : tVars('source.agent.fallback', { id: shortId });
    const online = Number(agent.lastSeenAt) > 0 && now - Number(agent.lastSeenAt) <= AGENT_ONLINE_WINDOW_MS;
    return {
      sourceKind: 'agent',
      sourceId: String(agent.agentId),
      label: `${baseLabel} · ${t(online ? 'source.online' : 'source.offline')}`,
      online,
    };
  });
}

function allSources() {
  return [...routerSources, ...agentSources];
}

function findSource(scope = displayScope) {
  const normalized = normalizeScope(scope);
  return normalized
    ? allSources().find(source => source.sourceKind === normalized.sourceKind && source.sourceId === normalized.sourceId) || null
    : null;
}

function appendSourceGroup(groupKey, sources) {
  if (!selector || !sources.length) return;
  const group = document.createElement('optgroup');
  group.label = t(groupKey);
  sources.forEach(source => {
    const option = document.createElement('option');
    option.value = scopeValue(source);
    option.textContent = source.label;
    group.appendChild(option);
  });
  selector.appendChild(group);
}

function renderSelector() {
  if (!selector) return;
  routerSources = activeRouterSources(rawRouters);
  agentSources = activeAgentSources(rawAgents);
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = t('source.all');
  selector.replaceChildren(allOption);
  appendSourceGroup('source.group.routers', routerSources);
  appendSourceGroup('source.group.agents', agentSources);
  selector.value = scopeValue(displayScope);
  selector.setAttribute('aria-label', t('source.selector.label'));
}

function emitScopeChange() {
  changeHandler?.(displayScope);
  if (typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('egressview:display-scope-change', {
      detail: { scope: displayScope },
    }));
  }
}

function setDisplayScope(nextScope, options = {}) {
  const normalized = normalizeScope(nextScope);
  const unchanged = scopeValue(normalized) === scopeValue(displayScope);
  displayScope = normalized;
  if (options.persist !== false) persistScope(displayScope, options.storage);
  renderSelector();
  if (!unchanged && options.emit !== false) emitScopeChange();
  return displayScope;
}

function reconcileScope() {
  if (!displayScope || !routerCatalogLoaded || !agentCatalogLoaded || findSource()) return;
  setDisplayScope(null);
  fallbackNotifier?.(t('source.unavailable'));
}

function updateRouterSources(routers, options = {}) {
  rawRouters = Array.isArray(routers) ? routers : [];
  routerSources = activeRouterSources(rawRouters);
  if (options.complete !== false) routerCatalogLoaded = true;
  renderSelector();
  reconcileScope();
}

function updateAgentSources(agents, options = {}) {
  rawAgents = Array.isArray(agents) ? agents : [];
  agentSources = activeAgentSources(rawAgents, options.now);
  if (options.complete !== false) agentCatalogLoaded = true;
  renderSelector();
  reconcileScope();
}

async function initDisplayScopeSelector({ request, notify, onChange } = {}) {
  selector = document.getElementById('source-filter-select');
  if (!selector || typeof request !== 'function') return;
  fallbackNotifier = typeof notify === 'function' ? notify : null;
  changeHandler = typeof onChange === 'function' ? onChange : null;
  displayScope = loadStoredScope();
  renderSelector();
  selector.addEventListener('change', () => setDisplayScope(parseScopeValue(selector.value)));
  window.addEventListener('egressview:language-change', renderSelector);

  const [routersResult, agentsResult] = await Promise.allSettled([
    request(`${_BASE}/api/routers`).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load routers');
      updateRouterSources(body.routers || []);
    }),
    request(`${_BASE}/api/agents`).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load agents');
      updateAgentSources(body.agents || []);
    }),
  ]);
  if (routersResult.status === 'rejected') console.warn('[source-filter] router catalog unavailable');
  if (agentsResult.status === 'rejected') console.warn('[source-filter] agent catalog unavailable');
}

function getDisplayScope() {
  return displayScope ? { ...displayScope } : null;
}

function getRouterSource(sourceId) {
  return routerSources.find(source => source.sourceId === String(sourceId)) || null;
}

export {
  STORAGE_KEY,
  activeAgentSources,
  activeRouterSources,
  getDisplayScope,
  getRouterSource,
  initDisplayScopeSelector,
  loadStoredScope,
  normalizeScope,
  parseScopeValue,
  setDisplayScope,
  updateAgentSources,
  updateRouterSources,
};
