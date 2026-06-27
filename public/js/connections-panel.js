// ─── Connections panel ────────────────────────────────────────────────────────
import { t } from './i18n.js';
import { esc } from './utils.js';

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
  // graph-container の絶対配置インジケーター
  const el = document.getElementById('data-fetching');
  if (el) el.style.display = show ? '' : 'none';
  // stats/log/notif-log ヘッダー内インジケーター
  ['data-fetching-stats', 'data-fetching-log'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.style.display = show ? 'flex' : 'none';
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
    // Live: sessions observed within the last 15 min (matches Yamaha NAT default TTL=15min)
    case 'live':      return { from: now - 15 * 60_000,   to: null };
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
    // live=15min means currently active; 1h means seen in last hour (superset of live), etc.
    const t = c.lastSeen || c.firstSeen || 0;
    if (from !== null && t < from) return false;
    if (to   !== null && t > to)   return false;
    if (minTtl && (c.ttl || 0) < minTtl) return false;
    return true;
  });
}

function updateConnPanel(selectedIp) {
  const panel = document.getElementById('conn-panel');
  const list  = document.getElementById('conn-list');
  const title = document.getElementById('conn-panel-title');
  const count = document.getElementById('conn-count');

  if (!selectedIp) { panel.style.display = 'none'; return; }

  const conns = getFilteredConnections().filter(c => c.src === selectedIp);
  panel.style.display = 'flex';
  title.textContent = `${t('panel.conn')} — ${selectedIp}`;
  count.textContent = conns.length ? `${conns.length} ${t('panel.conn.session')}` : '';

  if (!conns.length) {
    list.innerHTML = `<div class="conn-empty">${esc(t('panel.conn.empty'))}</div>`;
    return;
  }

  // Group by destination host
  const byHost = new Map();
  for (const c of conns) {
    const key = `${c.dstHost}:${c.dport}`;
    if (!byHost.has(key)) byHost.set(key, { ...c, count: 0 });
    byHost.get(key).count++;
  }

  list.innerHTML = [...byHost.values()]
    .sort((a, b) => b.count - a.count)
    .map(c => {
      const label   = c.dstHost !== c.dst ? c.dstHost : c.dst;
      const port    = c.dport === 443 ? 'HTTPS' : c.dport === 80 ? 'HTTP' : `:${c.dport}`;
      const cnt     = c.count > 1 ? ` ×${c.count}` : '';
      const flag    = (c.country && c.country.length === 2)
        ? String.fromCodePoint(0x1F1E6 + c.country.charCodeAt(0) - 65, 0x1F1E6 + c.country.charCodeAt(1) - 65)
        : '';
      const rdapStr = (flag || c.org) ? `${flag} ${c.org || c.country || ''}`.trim() : '';
      const rdapLine = rdapStr ? `<span class="conn-rdap">${esc(rdapStr)}</span>` : '';
      const threatIcon = c.threat ? `<span class="conn-threat" title="${esc(c.threat.tag)}">🚨</span>` : '';
      return `<div class="conn-row${c.threat ? ' threat-row' : ''}">
        <span class="conn-proto">${esc(c.proto)}</span>
        ${threatIcon}
        <span class="conn-host" title="${esc(c.dst)}:${esc(c.dport)}">
          <span class="conn-hostname">${esc(label)}</span>${rdapLine}
        </span>
        <span class="conn-port">${esc(port)}${esc(cnt)}</span>
      </div>`;
    }).join('');
}

export function setAllConnections(v) { allConnections = v; }
export function mergeAndSet(incoming) { allConnections = mergeConnections(allConnections, incoming); return allConnections; }
export function setServerTimeOffset(v) { serverTimeOffset = v; }
export function setDataRangeFrom(v) { dataRangeFrom = v; }
export function setCustomRangeFrom(v) { customRangeFrom = v; }
export function setCustomRangeTo(v) { customRangeTo = v; }
export function setCurrentTimeFilter(v) { currentTimeFilter = v; }
export { allConnections, serverTimeOffset, dataRangeFrom, customRangeFrom, customRangeTo, currentTimeFilter, mergeConnections, getFilteredConnections, getTimeRange, setFetching, updateConnPanel };
