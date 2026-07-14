// Graph tooltip and side panel rendering (P2-25 stage 2, extracted from graph.js).
// Owns the panel-only state (filter tab selection, devices-data reference) and
// all DOM updates for #tooltip, #filter-tabs, #device-list, and the WAN bars.
// Graph-owned state (selection, mesh colors, rate scale) is read through the
// accessors graph.js exports; the circular imports are function-body-only.
import { t } from './i18n.js?v=__ASSET_VERSION__';
import { esc, fmtBytes, nodeClass, typeLabel } from './utils.js?v=__ASSET_VERSION__';
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

export function showTooltip(e, d) {
  if (d.type === 'client' && d.client) {
    const c = d.client;
    const proto = c.ipv6Addrs?.length ? '<span class="proto-badge proto-v6-grey">IPv6</span>' : '';
    tooltip.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">${esc(c.name || c.ip)}</div>
      ${proto}
      <div>${esc(c.ip)}</div>
      ${c.mac ? `<div style="font-size:10px;color:#9ca3af">${esc(c.mac)}</div>` : ''}
      ${c.vendor ? `<div style="font-size:10px;color:#9ca3af">${esc(c.vendor)}</div>` : ''}
      ${c.dnsName ? `<div style="font-size:10px">DNS: ${esc(c.dnsName)}</div>` : ''}
      ${c.mdnsName ? `<div style="font-size:10px">mDNS: ${esc(c.mdnsName)}</div>` : ''}
      ${c.summarySessions ? `<div style="margin-top:4px;color:#ddd6fe">summary: ${Number(c.summarySessions).toLocaleString()} sessions</div>` : ''}
      <div>↓ ${fmtBytes(c.rxRate)} ↑ ${fmtBytes(c.txRate)}</div>
      ${c.rssi != null ? `<div>RSSI: ${c.rssi} dBm</div>` : ''}`;
  } else if (d.type === 'org') {
    tooltip.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">${esc(d.label)}</div>
      <div>${d.flag || ''} ${d.country ? esc(d.country) : ''}</div>
      <div>${Number(d.totalSessions || 0).toLocaleString()} sessions</div>
      ${d.summary ? `<div style="color:#ddd6fe">summary destination</div>` : ''}`;
  } else {
    tooltip.innerHTML = `<div>${esc(d.label || d.id)}</div>`;
  }
  tooltip.style.display = 'block';
  moveTooltip(e);
}

export function moveTooltip(e) {
  const r = document.getElementById('graph-container').getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top - 10;
  if (x + 220 > r.width) x = e.clientX - r.left - 230;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}

export function hideTooltip() { tooltip.style.display = 'none'; }

// ─── Side Panel ───────────────────────────────────────────────────────────────

export function updateFilterTabs(meshNodes, mainMac, clients) {
  const tabs = document.getElementById('filter-tabs');
  const counts = { all: clients.length };
  meshNodes.forEach(n => {
    counts[n.mac] = clients.filter(c => c.amesh_papMac === n.mac || (!c.amesh_papMac && n.mac === mainMac)).length;
  });

  // Rebuild tabs
  tabs.innerHTML = '';
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
    el.style.display = (tabMatch && searchMatch) ? '' : 'none';
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
      card = document.createElement('div');
      card.className = `device-card ${nodeClass(c.type)}`;
      card.dataset.mac = c.mac;
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:4px">
          <div class="device-title" style="flex:1"></div>
          <span class="device-note-edit" title="${esc(t('note.edit.tip'))}">📝</span>
        </div>
        <div class="device-name empty"></div>
        <div class="device-meta empty"></div>
        <div class="device-resolved empty"></div>
        <div class="device-note empty"></div>
        <div class="device-traffic">
          <span class="traffic-pill rx">↓ <span class="rx-val"></span></span>
          <span class="traffic-pill tx">↑ <span class="tx-val"></span></span>
        </div>
        <div style="margin-top:6px">
          <div class="traffic-bar"><div class="traffic-bar-fill rx" style="width:0%"></div></div>
          <div class="traffic-bar" style="margin-top:3px"><div class="traffic-bar-fill tx" style="width:0%"></div></div>
        </div>`;
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
            if (tb) tb.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)"><span class="spinner-xs"></span> ${t('data.loading') || '読み込み中'}</td></tr>`;
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
    const metaParts = [c.vendor, typeLabel(c.type)].filter(Boolean);
    let badgeHtml = '<span class="proto-badge proto-v4">IPv4</span>';
    if (c.ipv6Addrs && c.ipv6Addrs.length > 0) {
      badgeHtml += '<span class="proto-badge proto-v6-grey">IPv6</span>';
    }
    const nodeBadgeText = esc(papNode?.model?.replace(/RT-BE/,'') || 'Main');
    badgeHtml += `<span class="node-badge" style="background:${nodeColor}22;color:${nodeColor};border:1px solid ${nodeColor}44">${nodeBadgeText}</span>`;
    if (c.deviceFirstSeen && Date.now() - c.deviceFirstSeen < 24 * 60 * 60 * 1000) {
      badgeHtml += `<span class="new-badge">${t('device.new')}</span>`;
    }
    const metaText = metaParts.length ? ' ' + metaParts.map(esc).join(' · ') : '';
    metaEl.innerHTML = badgeHtml + metaText;
    metaEl.className = 'device-meta';
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
