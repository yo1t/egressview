// ─── Connections panel ────────────────────────────────────────────────────────
import { t } from './i18n.js?v=__ASSET_VERSION__';

let allConnections = [];
let serverTimeOffset = 0; // diff between client and server clocks (ms)
let currentTimeFilter = '1h';
// Oldest timestamp we have loaded in allConnections (Date.now()-24h after initial WS load)
let dataRangeFrom = Date.now() - 86400_000;

// Period filter: returns [from, to] against lastSeen (null = no limit)
let customRangeFrom = null; // ms (for custom filter)
let customRangeTo   = null;

// ── Fetch-in-progress indicator ───────────────────────────────────────────────
let _fetchingCount = 0;
function setFetching(delta) {
  _fetchingCount = Math.max(0, _fetchingCount + delta);
  const show = _fetchingCount > 0;
  // Absolutely-positioned indicator inside graph-container
  const el = document.getElementById('data-fetching');
  if (el) el.classList.toggle('is-visible', show);
  // Indicators inside the stats/log/notif-log headers
  ['data-fetching-stats', 'data-fetching-log'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.classList.toggle('is-visible', show);
  });
}

function connectionKey(c) {
  return `${c.src}|${c.dst}|${c.dport}|${c.proto}`;
}

function mergeConnections(existing, incoming) {
  const map = new Map((existing || []).map(c => [connectionKey(c), c]));
  for (const c of incoming || []) {
    const key = connectionKey(c);
    const prev = map.get(key);
    map.set(key, { ...prev, ...c, threat: c.threat || prev?.threat || null });
  }
  return [...map.values()];
}

function getTimeRange() {
  const now = Date.now() + serverTimeOffset; // server time basis
  switch (currentTimeFilter) {
    // Keep the detailed live graph bounded; longer periods use summaries.
    case 'live':      return { from: now - 5 * 60_000,    to: null };
    case '15m':       return { from: now - 15 * 60_000,   to: null };
    case '1h':        return { from: now - 3600_000,      to: null };
    case '3h':        return { from: now - 3 * 3600_000,  to: null };
    case '6h':        return { from: now - 6 * 3600_000,  to: null };
    case '12h':       return { from: now - 12 * 3600_000, to: null };
    case '24h':       return { from: now - 86400_000,     to: null };
    case '7d':        return { from: now - 604800_000,    to: null };
    case '14d':       return { from: now - 14 * 86400_000, to: null };
    case 'today': {
      const d = new Date(now); d.setHours(0,0,0,0);
      return { from: d.getTime(), to: null };
    }
    case 'yesterday': {
      const d = new Date(now); d.setHours(0,0,0,0);
      return { from: d.getTime() - 86400_000, to: d.getTime() };
    }
    case 'custom':    return { from: customRangeFrom, to: customRangeTo };
    default:          return { from: now - 3600_000, to: null };
  }
}
function getFilteredConnections() {
  const { from, to, minTtl = 0 } = getTimeRange();
  return allConnections.filter(c => {
    // All filters judge by lastSeen: "connections active within the period"
    // live=5min means currently active; 15m and longer ranges are progressively broader.
    const t = c.lastSeen || c.firstSeen || 0;
    if (from !== null && t < from) return false;
    if (to   !== null && t > to)   return false;
    if (minTtl && (c.ttl || 0) < minTtl) return false;
    return true;
  });
}

function connTextElement(tagName, text, { className = '', title = '' } = {}) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (title) element.title = title;
  element.textContent = text == null ? '' : String(text);
  return element;
}

function createConnectionPanelRow(connection) {
  const label = connection.dstHost && connection.dstHost !== connection.dst
    ? connection.dstHost
    : connection.dst;
  const port = connection.dport === 443 ? 'HTTPS' : connection.dport === 80 ? 'HTTP' : `:${connection.dport}`;
  const count = connection.count > 1 ? ` ×${connection.count}` : '';
  const flag = (connection.country && connection.country.length === 2)
    ? String.fromCodePoint(
      0x1F1E6 + connection.country.charCodeAt(0) - 65,
      0x1F1E6 + connection.country.charCodeAt(1) - 65
    )
    : '';
  const rdapText = (flag || connection.org)
    ? `${flag} ${connection.org || connection.country || ''}`.trim()
    : '';

  const row = document.createElement('div');
  row.className = `conn-row${connection.threat ? ' threat-row' : ''}`;
  row.appendChild(connTextElement('span', connection.proto, { className: 'conn-proto' }));
  if (connection.threat) {
    row.appendChild(connTextElement('span', '🚨', {
      className: 'conn-threat',
      title: connection.threat.tag,
    }));
  }
  const host = document.createElement('span');
  host.className = 'conn-host';
  host.title = `${connection.dst || ''}:${connection.dport ?? ''}`;
  host.appendChild(connTextElement('span', label, { className: 'conn-hostname' }));
  if (rdapText) host.appendChild(connTextElement('span', rdapText, { className: 'conn-rdap' }));
  row.appendChild(host);
  row.appendChild(connTextElement('span', `${port}${count}`, { className: 'conn-port' }));
  return row;
}

function updateConnPanel(selectedIp) {
  const panel = document.getElementById('conn-panel');
  const list  = document.getElementById('conn-list');
  const title = document.getElementById('conn-panel-title');
  const count = document.getElementById('conn-count');

  if (!selectedIp) { panel.classList.remove('is-visible'); return; }

  const conns = getFilteredConnections().filter(c => c.src === selectedIp);
  panel.classList.add('is-visible');
  title.textContent = `${t('panel.conn')} — ${selectedIp}`;
  count.textContent = conns.length ? `${conns.length} ${t('panel.conn.session')}` : '';

  if (!conns.length) {
    list.replaceChildren(connTextElement('div', t('panel.conn.empty'), { className: 'conn-empty' }));
    return;
  }

  // Group by destination host
  const byHost = new Map();
  for (const c of conns) {
    const key = `${c.dstHost || c.dst}:${c.dport}`;
    if (!byHost.has(key)) byHost.set(key, { ...c, count: 0 });
    byHost.get(key).count++;
  }

  const rows = document.createDocumentFragment();
  [...byHost.values()]
    .sort((a, b) => b.count - a.count)
    .forEach(connection => rows.appendChild(createConnectionPanelRow(connection)));
  list.replaceChildren(rows);
}

export function setAllConnections(v) { allConnections = v; }
export function mergeAndSet(incoming) { allConnections = mergeConnections(allConnections, incoming); return allConnections; }
export function setServerTimeOffset(v) { serverTimeOffset = v; }
export function setDataRangeFrom(v) { dataRangeFrom = v; }
export function setCustomRangeFrom(v) { customRangeFrom = v; }
export function setCustomRangeTo(v) { customRangeTo = v; }
export function setCurrentTimeFilter(v) { currentTimeFilter = v; }
export { allConnections, serverTimeOffset, dataRangeFrom, customRangeFrom, customRangeTo, currentTimeFilter, mergeConnections, getFilteredConnections, getTimeRange, setFetching, updateConnPanel };
