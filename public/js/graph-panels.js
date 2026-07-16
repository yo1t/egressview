// Graph tooltip and side panel rendering (P2-25 stage 2, extracted from graph.js).
// Owns the panel-only state (filter tab selection, devices-data reference) and
// all DOM updates for #tooltip, #filter-tabs, #device-list, and the WAN bars.
// Graph-owned state (selection, mesh colors, rate scale) is read through the
// accessors graph.js exports; the circular imports are function-body-only.
import { t } from './i18n.js?v=__ASSET_VERSION__';
import { fmtBytes, nodeClass, typeLabel } from './utils.js?v=__ASSET_VERSION__';
import { updateConnPanel } from './connections-panel.js?v=__ASSET_VERSION__';
import { statsMode, nlMode, logMode, devicesMode } from './view-tabs.js?v=__ASSET_VERSION__';
import { lookupNote, openNoteModal } from './auth-socket.js?v=__ASSET_VERSION__';
// Circular imports resolved at runtime (function-body-only calls):
import { selectedMac, setSelection, applyGraphFilter, lastMeshNodes, lastRouterIp, getMaxRate, setMaxRate, getMeshColorMap } from './graph.js?v=__ASSET_VERSION__';
import { updateStats } from './stats.js?v=__ASSET_VERSION__';
import { updateLogView } from './log.js?v=__ASSET_VERSION__';
import { nlRender } from './notif-log.js?v=__ASSET_VERSION__';
import { renderDevicesTable, setDvSelectedIp } from './devices.js?v=__ASSET_VERSION__';

let _devicesDataRef = [];
export function setGraphDevicesDataRef(v) { _devicesDataRef = v; }

let currentFilter = 'all';

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');

function textElement(tagName, text, className = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text == null ? '' : String(text);
  return element;
}

function renderClientTooltip(client) {
  const lines = [
    textElement('div', client.name || client.ip, 'graph-tooltip-heading'),
  ];
  if (client.ipv6Addrs?.length) {
    lines.push(textElement('span', 'IPv6', 'proto-badge proto-v6-grey'));
  }
  lines.push(textElement('div', client.ip));
  if (client.mac) lines.push(textElement('div', client.mac, 'graph-tooltip-muted'));
  if (client.vendor) lines.push(textElement('div', client.vendor, 'graph-tooltip-muted'));
  if (client.dnsName) lines.push(textElement('div', `DNS: ${client.dnsName}`, 'graph-tooltip-detail'));
  if (client.mdnsName) lines.push(textElement('div', `mDNS: ${client.mdnsName}`, 'graph-tooltip-detail'));
  if (client.summarySessions) {
    lines.push(textElement(
      'div', `summary: ${Number(client.summarySessions).toLocaleString()} sessions`, 'graph-tooltip-summary'
    ));
  }
  lines.push(textElement('div', `↓ ${fmtBytes(client.rxRate)} ↑ ${fmtBytes(client.txRate)}`));
  if (client.rssi != null) lines.push(textElement('div', `RSSI: ${client.rssi} dBm`));
  tooltip.replaceChildren(...lines);
}

function renderOrgTooltip(node) {
  const lines = [
    textElement('div', node.label, 'graph-tooltip-heading'),
    textElement('div', `${node.flag || ''} ${node.country || ''}`),
    textElement('div', `${Number(node.totalSessions || 0).toLocaleString()} sessions`),
  ];
  if (node.summary) {
    lines.push(textElement('div', 'summary destination', 'graph-tooltip-summary-destination'));
  }
  tooltip.replaceChildren(...lines);
}

export function showTooltip(e, d) {
  if (d.type === 'client' && d.client) {
    renderClientTooltip(d.client);
  } else if (d.type === 'org') {
    renderOrgTooltip(d);
  } else {
    tooltip.replaceChildren(textElement('div', d.label || d.id));
  }
  tooltip.classList.add('is-visible');
  moveTooltip(e);
}

export function moveTooltip(e) {
  const r = document.getElementById('graph-container').getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top - 10;
  if (x + 220 > r.width) x = e.clientX - r.left - 230;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}

export function hideTooltip() { tooltip.classList.remove('is-visible'); }

// ─── Side Panel ───────────────────────────────────────────────────────────────

function createDeviceCard(client) {
  const card = document.createElement('div');
  card.className = `device-card ${nodeClass(client.type)}`;
  card.dataset.mac = client.mac;

  const header = document.createElement('div');
  header.className = 'device-card-header';
  header.append(
    textElement('div', '', 'device-title'),
    textElement('span', '📝', 'device-note-edit'),
  );
  header.querySelector('.device-note-edit').title = t('note.edit.tip');

  const traffic = document.createElement('div');
  traffic.className = 'device-traffic';
  for (const [direction, arrow] of [['rx', '↓ '], ['tx', '↑ ']]) {
    const pill = textElement('span', arrow, `traffic-pill ${direction}`);
    pill.appendChild(textElement('span', '', `${direction}-val`));
    traffic.appendChild(pill);
  }

  const bars = document.createElement('div');
  bars.className = 'device-traffic-bars';
  for (const direction of ['rx', 'tx']) {
    const bar = document.createElement('div');
    bar.className = `traffic-bar${direction === 'tx' ? ' traffic-bar-spaced' : ''}`;
    bar.appendChild(textElement('div', '', `traffic-bar-fill ${direction}`));
    bars.appendChild(bar);
  }

  card.append(
    header,
    textElement('div', '', 'device-name empty'),
    textElement('div', '', 'device-meta empty'),
    textElement('div', '', 'device-resolved empty'),
    textElement('div', '', 'device-note empty'),
    traffic,
    bars,
  );
  return card;
}

export function renderLogLoading(tbody) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 9;
  cell.className = 'log-loading-cell';
  cell.append(
    textElement('span', '', 'spinner-xs'),
    document.createTextNode(` ${t('data.loading') || '読み込み中'}`),
  );
  row.appendChild(cell);
  tbody.replaceChildren(row);
}

function renderDeviceMeta(metaEl, client, papNode, nodeColor) {
  const badges = [textElement('span', 'IPv4', 'proto-badge proto-v4')];
  if (client.ipv6Addrs?.length) {
    badges.push(textElement('span', 'IPv6', 'proto-badge proto-v6-grey'));
  }

  const nodeBadge = textElement(
    'span', papNode?.model?.replace(/RT-BE/, '') || 'Main', 'node-badge'
  );
  nodeBadge.style.setProperty('--node-color', nodeColor);
  badges.push(nodeBadge);

  if (client.deviceFirstSeen && Date.now() - client.deviceFirstSeen < 24 * 60 * 60 * 1000) {
    badges.push(textElement('span', t('device.new'), 'new-badge'));
  }

  const metaParts = [client.vendor, typeLabel(client.type)].filter(Boolean);
  if (metaParts.length) badges.push(document.createTextNode(` ${metaParts.join(' · ')}`));
  metaEl.replaceChildren(...badges);
  metaEl.className = 'device-meta';
}

export function updateFilterTabs(meshNodes, mainMac, clients) {
  const tabs = document.getElementById('filter-tabs');
  const counts = { all: clients.length };
  meshNodes.forEach(n => {
    counts[n.mac] = clients.filter(c => c.amesh_papMac === n.mac || (!c.amesh_papMac && n.mac === mainMac)).length;
  });

  // Rebuild tabs
  tabs.replaceChildren();
  const addTab = (filter, label) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (currentFilter === filter ? ' active' : '');
    btn.dataset.filter = filter;
    btn.textContent = `${label} (${counts[filter] ?? 0})`;
    btn.addEventListener('click', () => {
      currentFilter = filter;
      tabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
      applyFilter(clients);
    });
    tabs.appendChild(btn);
  };
  addTab('all', t('panel.tab.all'));
  meshNodes.forEach(n => addTab(n.mac, n.model || 'Node'));
}

export function applyFilter(clients) {
  const list = document.getElementById('device-list');
  const searchRaw = (document.getElementById('device-search-input')?.value || '').trim().toLowerCase();
  list.querySelectorAll('.device-card').forEach(el => {
    const mac = el.dataset.mac;
    const c = clients.find(c => c.mac === mac);
    if (!c) return;
    const filterNode = lastMeshNodes.find(n => n.mac === currentFilter);
    const filterIsMain = filterNode?.ip === lastRouterIp;
    const tabMatch = currentFilter === 'all'
      || c.amesh_papMac === currentFilter
      || (filterIsMain && !c.amesh_papMac);
    const searchMatch = !searchRaw
      || (c.name || '').toLowerCase().includes(searchRaw)
      || (c.ip   || '').toLowerCase().includes(searchRaw)
      || (c.mac  || '').toLowerCase().includes(searchRaw);
    el.classList.toggle('is-filtered', !(tabMatch && searchMatch));
  });
}

export function updateSidePanel(clients, data, meshNodes, _mainMac) {
  clients.forEach(c => { const r = Math.max(c.rxRate, c.txRate); if (r > getMaxRate()) setMaxRate(r * 1.2); });
  const meshColorMap = getMeshColorMap();
  const list = document.getElementById('device-list');
  const existing = {};
  list.querySelectorAll('.device-card').forEach(el => existing[el.dataset.mac] = el);
  const seen = new Set();

  clients.sort((a, b) => (b.rxRate + b.txRate) - (a.rxRate + a.txRate)).forEach(c => {
    seen.add(c.mac);
    const papNode = meshNodes.find(n => n.mac === c.amesh_papMac);
    const nodeColor = meshColorMap[c.amesh_papMac] || '#6b7280';
    let card = existing[c.mac];
    if (!card) {
      card = createDeviceCard(c);
      card.addEventListener('click', () => {
        const nextMac = c.mac === selectedMac ? null : c.mac;
        setSelection(nextMac, nextMac ? c.ip : null);
        updateSideHighlight();
        applyGraphFilter();
        if (statsMode) updateStats();
        updateConnPanel(nextMac ? c.ip : null);
        if (logMode) {
          if (nextMac) {
            const tb = document.getElementById('log-tbody');
            if (tb) renderLogLoading(tb);
          }
          updateLogView();
        }
        if (nlMode) nlRender();
        if (devicesMode) {
          setDvSelectedIp(nextMac ? c.ip : null);
          renderDevicesTable();
        }
      });
      // Only the edit-icon click opens the edit modal
      card.querySelector('.device-note-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        openNoteModal(c.ip, c.mac, c.name || c.ip);
      });
      // Clicks on the note body do NOT trigger card selection (preserves scroll)
      card.querySelector('.device-note').addEventListener('click', (e) => e.stopPropagation());
      list.appendChild(card);
    }
    // Note display — prefer deviceId key (MCP-set notes) over IP/MAC composite
    const _noteDev = _devicesDataRef.find(d => d.ip === c.ip || (c.mac && c.mac !== c.ip && d.mac === c.mac));
    const noteText = lookupNote(c.ip, c.mac, _noteDev?.deviceId);
    const noteEl = card.querySelector('.device-note');
    if (noteEl) {
      if (noteText) {
        noteEl.textContent = noteText;
        noteEl.className = 'device-note';
      } else {
        noteEl.textContent = '';
        noteEl.className = 'device-note empty';
      }
    }
    // Title: IP / MAC (IP only when MAC is missing or equals IP)
    const macKnown = c.mac && c.mac !== c.ip;
    card.querySelector('.device-title').textContent = macKnown ? `${c.ip} / ${c.mac}` : c.ip;
    // Name (shown only when different from IP, dedupe)
    const nameEl = card.querySelector('.device-name');
    if (c.name && c.name !== c.ip) {
      nameEl.textContent = c.name;
      nameEl.className = 'device-name';
    } else {
      nameEl.textContent = '';
      nameEl.className = 'device-name empty';
    }
    // Meta: protocol badges + node badge + NEW badge + OUI vendor · connection type
    const metaEl = card.querySelector('.device-meta');
    renderDeviceMeta(metaEl, c, papNode, nodeColor);
    // Name resolution: DNS / mDNS (omit if same as already-known name)
    const resolvedEl = card.querySelector('.device-resolved');
    const known = new Set([c.name, c.ip].filter(Boolean));
    const resolvedParts = [];
    if (c.dnsName  && !known.has(c.dnsName))  resolvedParts.push('DNS: '  + c.dnsName);
    if (c.mdnsName && !known.has(c.mdnsName) && c.mdnsName !== c.dnsName) resolvedParts.push('mDNS: ' + c.mdnsName);
    if (resolvedParts.length) {
      resolvedEl.textContent = resolvedParts.join(' · ');
      resolvedEl.className = 'device-resolved';
    } else {
      resolvedEl.textContent = '';
      resolvedEl.className = 'device-resolved empty';
    }
    card.querySelector('.rx-val').textContent = fmtBytes(c.rxRate);
    card.querySelector('.tx-val').textContent = fmtBytes(c.txRate);
    const rxPct = Math.min(100, (c.rxRate / getMaxRate()) * 100);
    const txPct = Math.min(100, (c.txRate / getMaxRate()) * 100);
    card.querySelectorAll('.traffic-bar-fill')[0].style.width = rxPct + '%';
    card.querySelectorAll('.traffic-bar-fill')[1].style.width = txPct + '%';
  });
  Object.keys(existing).forEach(mac => { if (!seen.has(mac)) existing[mac].remove(); });
  applyFilter(clients);

  const wMax = Math.max(getMaxRate(), data.wanRx, data.wanTx, 1);
  document.getElementById('wan-rx-label').textContent = fmtBytes(data.wanRx);
  document.getElementById('wan-tx-label').textContent = fmtBytes(data.wanTx);
  document.getElementById('wan-rx-bar').style.width = Math.min(100, (data.wanRx / wMax) * 100) + '%';
  document.getElementById('wan-tx-bar').style.width = Math.min(100, (data.wanTx / wMax) * 100) + '%';
  updateSideHighlight();
}

export function updateSideHighlight() {
  document.querySelectorAll('.device-card').forEach(el => el.classList.toggle('selected', el.dataset.mac === selectedMac));
}
