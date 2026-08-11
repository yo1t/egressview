// ─── Device Inventory View ───────────────────────────────────────────────────
import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch, notesMap, lookupNote, refreshAllNotes } from './auth-socket.js?v=__ASSET_VERSION__';
import { appendDisplayScope } from './display-scope.js?v=__ASSET_VERSION__';

var devicesData = [];
var devicesSortState = { col: 'lastSeen', dir: 'desc' };
var dvFilters = {};          // col → { mode, value }
var dvSearchTargetCol = null;
var dvSelectedIp = null;     // IP filter from sidebar click
var dvDetailDevice = null;   // currently open device
var mergeCandidatesCache = [];  // pending merge candidates from API
// P1-8: status filter — active/recent/stale/archived
var dvStatusFilter = new Set(['active', 'recent']);

function dvTextElement(tagName, text, { className = '', id = '' } = {}) {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (id) el.id = id;
  el.textContent = text == null ? '' : String(text);
  return el;
}

function dvAppendCell(row, value, { className = '', placeholder = false } = {}) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  if (placeholder) {
    cell.appendChild(dvTextElement('span', '—', { className: 'dv-placeholder' }));
  } else {
    cell.textContent = value == null ? '' : String(value);
  }
  row.appendChild(cell);
  return cell;
}

function createDeviceTableRow(device) {
  const name = deviceName(device);
  const ipv6 = deviceIpv6(device);
  const sources = (device.sources || '').split(',').filter(Boolean).join(' · ');
  const isOpen = dvDetailDevice && dvDetailDevice.ip === device.ip;
  const row = document.createElement('tr');
  row.classList.add('dv-table-row');
  if (isOpen) row.classList.add('selected');
  if (device.status === 'stale') row.classList.add('row-stale');
  if (device.status === 'archived') row.classList.add('row-archived');
  row.dataset.ip = device.ip || '';
  row.addEventListener('click', () => openDvDetail(device));

  dvAppendCell(row, device.ip, { className: 'dv-cell-mono' });
  dvAppendCell(row, device.mac, { className: 'dv-cell-mono dv-cell-muted', placeholder: !device.mac });
  dvAppendCell(row, device.vendor, { placeholder: !device.vendor });
  dvAppendCell(row, name, { placeholder: name === '—' });
  dvAppendCell(row, ipv6, { className: 'dv-cell-mono-small', placeholder: ipv6 === '—' });
  dvAppendCell(row, sources, { className: 'dv-cell-small-muted', placeholder: !sources });
  dvAppendCell(row, fmtTs(device.firstSeen), { className: 'dv-cell-small-muted' });
  dvAppendCell(row, fmtTs(device.lastSeen), { className: 'dv-cell-small-muted' });
  return row;
}

function deviceName(d) {
  return d.mdnsName || d.dnsName || d.netbiosName || '—';
}
function deviceIpv6(d) {
  if (!d.ipv6Addrs || !d.ipv6Addrs.length) return '—';
  return d.ipv6Addrs.slice(0, 2).join(', ');
}
function getDeviceSortValue(d, col) {
  switch (col) {
    case 'ip':        return d.ip || '';
    case 'mac':       return d.mac || '';
    case 'vendor':    return (d.vendor || '').toLowerCase();
    case 'name':      return deviceName(d).toLowerCase();
    case 'firstSeen': return d.firstSeen || 0;
    case 'lastSeen':  return d.lastSeen  || 0;
    default:          return '';
  }
}
function getDvCellValue(d, col) {
  switch (col) {
    case 'ip':     return d.ip || '';
    case 'mac':    return d.mac || '';
    case 'vendor': return d.vendor || '';
    case 'name':   return deviceName(d) === '—' ? '' : deviceName(d);
    default:       return '';
  }
}
function dvMatchFilter(value, filter) {
  if (!filter || !filter.value) return true;
  const v = value.toLowerCase();
  const q = filter.value.toLowerCase();
  switch (filter.mode) {
    case 'startsWith': return v.startsWith(q);
    case 'endsWith':   return v.endsWith(q);
    case 'regex':
      try { return new RegExp(filter.value, 'i').test(value); } catch { return true; }
    default:           return v.includes(q);
  }
}

function renderDevicesTable() {
  const search = (document.getElementById('devices-search').value || '').toLowerCase();
  const filterBadgeEl = document.getElementById('dv-device-filter');
  const clearFiltersBtn = document.getElementById('dv-clear-filters-btn');

  // Sidebar device filter
  if (dvSelectedIp) {
    filterBadgeEl.classList.add('is-visible');
    const clearFilter = dvTextElement('span', tVars('devices.filter.only', { value: dvSelectedIp }), {
      className: 'log-device-filter-chip',
      id: 'dv-filter-clear',
    });
    clearFilter.addEventListener('click', () => { dvSelectedIp = null; renderDevicesTable(); });
    filterBadgeEl.replaceChildren(clearFilter);
  } else {
    filterBadgeEl.classList.remove('is-visible');
  }

  // Show "clear filters" button if any column filter is active
  const hasColFilter = Object.values(dvFilters).some(f => f && f.value);
  clearFiltersBtn.classList.toggle('is-visible', Boolean(hasColFilter || dvSelectedIp));

  // P1-8: update status counts and filter buttons
  const statusCounts = { active: 0, recent: 0, stale: 0, archived: 0 };
  for (const d of devicesData) statusCounts[d.status || 'stale']++;
  ['active','recent','stale','archived'].forEach(s => {
    const el = document.getElementById('cnt-' + s);
    if (el) el.textContent = '(' + (statusCounts[s] || 0) + ')';
  });
  document.querySelectorAll('.dv-status-btn').forEach(btn => {
    btn.classList.toggle('sel', dvStatusFilter.has(btn.dataset.status));
  });

  let rows = devicesData.filter(d => {
    // P1-8: status filter
    if (!dvStatusFilter.has(d.status || 'stale')) return false;
    // Sidebar IP filter
    if (dvSelectedIp && d.ip !== dvSelectedIp) return false;
    // Global text search
    if (search) {
      const hit = (d.ip || '').includes(search) ||
        (d.mac || '').toLowerCase().includes(search) ||
        (d.vendor || '').toLowerCase().includes(search) ||
        deviceName(d).toLowerCase().includes(search);
      if (!hit) return false;
    }
    // Column filters
    for (const [col, filter] of Object.entries(dvFilters)) {
      if (!filter || !filter.value) continue;
      if (!dvMatchFilter(getDvCellValue(d, col), filter)) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    const av = getDeviceSortValue(a, devicesSortState.col);
    const bv = getDeviceSortValue(b, devicesSortState.col);
    const cmp = typeof av === 'number' ? av - bv : (av + '').localeCompare(bv + '');
    return devicesSortState.dir === 'asc' ? cmp : -cmp;
  });

  // Update sort icons
  document.querySelectorAll('#devices-table th[data-col]').forEach(th => {
    const icon = th.querySelector('.log-sort-icon');
    if (!icon) return;
    const c = th.dataset.col;
    icon.className = 'log-sort-icon' + (c === devicesSortState.col ? ` ${devicesSortState.dir}` : '');
  });
  // Update filter icons
  document.querySelectorAll('.dv-search-icon').forEach(icon => {
    const c = icon.dataset.col;
    icon.classList.toggle('active', !!(dvFilters[c] && dvFilters[c].value));
  });

  const tbody = document.getElementById('devices-tbody');
  const tableRows = document.createDocumentFragment();
  rows.forEach(device => tableRows.appendChild(createDeviceTableRow(device)));
  tbody.replaceChildren(tableRows);

  const countEl = document.getElementById('devices-count');
  if (countEl) {
    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const extra = rows.length < devicesData.filter(d => dvStatusFilter.has(d.status || 'stale')).length
      ? t('devices.count.filtered') : '';
    countEl.textContent = tVars('devices.count', { visible: rows.length, filtered: extra, total });
  }
}

function createDvDetailRow(label, value, valueClass = '') {
  const row = document.createElement('div');
  row.className = 'dv-detail-row';
  row.appendChild(dvTextElement('span', label, { className: 'dv-detail-label' }));
  row.appendChild(dvTextElement('span', value, {
    className: `dv-detail-value${valueClass ? ` ${valueClass}` : ''}`,
  }));
  return row;
}

function createMergeSection(candidates, device) {
  if (!candidates.length) return null;
  const section = document.createElement('div');
  section.className = 'dv-merge-section';
  section.appendChild(dvTextElement('div', t('devices.merge.title'), { className: 'dv-merge-title' }));

  candidates.forEach(candidate => {
    const isA = candidate.deviceIdA === device.deviceId;
    const otherId = isA ? candidate.deviceIdB : candidate.deviceIdA;
    const otherIp = isA ? candidate.ipB : candidate.ipA;
    const otherMac = isA ? candidate.macB : candidate.macA;
    const otherName = isA
      ? (candidate.mdnsNameB || candidate.dnsNameB)
      : (candidate.mdnsNameA || candidate.dnsNameA);
    const scoreText = `${(candidate.score * 100).toFixed(0)}%`;
    const reasons = Array.isArray(candidate.reasons) ? candidate.reasons.join(', ') : (candidate.reasons || '');
    const label = [otherIp, otherMac, otherName].filter(Boolean).join(' / ') || otherId || '—';

    const card = document.createElement('div');
    card.className = 'dv-merge-card';
    card.dataset.candidateId = String(candidate.id);
    card.dataset.otherId = otherId || '';
    card.appendChild(dvTextElement('div', label, { className: 'dv-merge-card-info' }));
    card.appendChild(dvTextElement(
      'div',
      `${tVars('devices.merge.score', { score: scoreText })}${reasons ? ` ${reasons}` : ''}`,
      { className: 'dv-merge-card-score' }
    ));
    const buttons = document.createElement('div');
    buttons.className = 'dv-merge-card-btns';
    const mergeButton = dvTextElement('button', t('devices.merge.into'), { className: 'btn-merge' });
    mergeButton.dataset.action = 'merge';
    const rejectButton = dvTextElement('button', t('devices.merge.reject'), { className: 'btn-reject' });
    rejectButton.dataset.action = 'reject';
    buttons.append(mergeButton, rejectButton);
    card.appendChild(buttons);
    section.appendChild(card);
  });
  return section;
}

// ── Merge candidates ─────────────────────────────────────────────────────────
async function loadMergeCandidates() {
  try {
    const res = await apiFetch(_BASE+'/api/devices/merge-candidates?status=pending');
    if (!res.ok) return;
    const data = await res.json();
    mergeCandidatesCache = data.candidates || [];
  } catch (e) { /* ignore */ }
}

// ── Device detail panel ───────────────────────────────────────────────────────
function openDvDetail(d) {
  dvDetailDevice = d;
  document.getElementById('dv-detail-panel').classList.remove('hidden');
  document.getElementById('dv-detail-title').textContent = d.ip + (d.mac ? ' / ' + d.mac : '');

  const name = deviceName(d);
  const ipv6List = (d.ipv6Addrs || []).filter(Boolean);
  const sources = (d.sources || '').split(',').filter(Boolean).join(', ');
  const noteText = d.note != null ? d.note : lookupNote(d.ip, d.mac, d.deviceId);

  const myCandidates = d.deviceId
    ? mergeCandidatesCache.filter(c => c.deviceIdA === d.deviceId || c.deviceIdB === d.deviceId)
    : [];

  // P1-8: archive button label
  const archiveBtn = document.getElementById('dv-detail-archive');
  if (archiveBtn) {
    if (d.status === 'archived') {
      archiveBtn.textContent = t('devices.unarchive');
      archiveBtn.title = t('devices.unarchive.title');
    } else {
      archiveBtn.textContent = t('devices.archive');
      archiveBtn.title = t('devices.archive.title');
    }
  }

  // P1-8: status badge
  const statusLabels = {
    active: t('devices.status.active'),
    recent: t('devices.status.recent'),
    stale: t('devices.status.stale'),
    archived: t('devices.status.archived'),
  };
  const statusCls    = { active: 's-active', recent: 's-recent', stale: 's-stale', archived: 's-archived' };
  const statusStr    = d.status || 'stale';

  const detail = document.createDocumentFragment();
  detail.appendChild(createDvDetailRow(t('devices.detail.status'), statusLabels[statusStr] || statusStr, statusCls[statusStr]));
  if (d.vendor) detail.appendChild(createDvDetailRow(t('devices.detail.vendor'), d.vendor));
  if (name !== '—') detail.appendChild(createDvDetailRow(t('devices.detail.name'), name));
  if (d.dnsName) detail.appendChild(createDvDetailRow('DNS', d.dnsName, 'dv-detail-small'));
  if (d.mdnsName) detail.appendChild(createDvDetailRow('mDNS', d.mdnsName));
  if (d.netbiosName) detail.appendChild(createDvDetailRow('NetBIOS', d.netbiosName));
  if (ipv6List.length) {
    const ipv6Row = document.createElement('div');
    ipv6Row.className = 'dv-detail-row';
    ipv6Row.appendChild(dvTextElement('span', 'IPv6', { className: 'dv-detail-label' }));
    const ipv6Values = document.createElement('span');
    ipv6Values.className = 'dv-detail-value dv-detail-ipv6';
    ipv6List.forEach(address => ipv6Values.appendChild(dvTextElement('span', address, { className: 'dv-detail-ipv6-line' })));
    ipv6Row.appendChild(ipv6Values);
    detail.appendChild(ipv6Row);
  }
  detail.appendChild(createDvDetailRow(t('devices.detail.sources'), sources || '—'));
  detail.appendChild(createDvDetailRow(t('devices.detail.firstSeen'), fmtTs(d.firstSeen)));
  detail.appendChild(createDvDetailRow(t('devices.detail.lastSeen'), fmtTs(d.lastSeen)));
  const mergeSection = createMergeSection(myCandidates, d);
  if (mergeSection) detail.appendChild(mergeSection);
  detail.appendChild(dvTextElement('div', t('devices.detail.note'), { className: 'dv-detail-note-label' }));
  const noteInput = document.createElement('textarea');
  noteInput.className = 'dv-detail-note-ta';
  noteInput.id = 'dv-detail-note-ta';
  noteInput.placeholder = t('note.placeholder');
  noteInput.value = noteText || '';
  detail.appendChild(noteInput);
  const investigateResult = dvTextElement('div', '', { className: 'dv-investigate-result' });
  investigateResult.id = 'dv-investigate-result';
  detail.appendChild(investigateResult);
  document.getElementById('dv-detail-body').replaceChildren(detail);
  // Re-render table to highlight selected row
  renderDevicesTable();
}

function initDevices() {
  if (initDevices._done) return;
  initDevices._done = true;

document.getElementById('dv-detail-close').addEventListener('click', () => {
  dvDetailDevice = null;
  document.getElementById('dv-detail-panel').classList.add('hidden');
  renderDevicesTable();
});

document.getElementById('dv-detail-save').addEventListener('click', async () => {
  if (!dvDetailDevice) return;
  const note = document.getElementById('dv-detail-note-ta').value;
  const ip = dvDetailDevice.ip, mac = dvDetailDevice.mac || '';
  const deviceId = dvDetailDevice.deviceId || null;
  const btn = document.getElementById('dv-detail-save');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('settings.btn.saving');
  try {
    const res = await apiFetch(_BASE+'/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, mac, deviceId, note }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    // Remove stale IP/MAC-keyed entries from local cache
    for (const k of Object.keys(notesMap)) {
      const [kip, kmac] = k.split('|');
      if ((ip && kip === ip) || (mac && (kmac === mac || kip === mac))) delete notesMap[k];
    }
    // Store under deviceId key when available (mirrors server behaviour)
    const key = deviceId || ((ip && mac) ? `${ip}|${mac}` : ip || mac);
    if (note.trim()) notesMap[key] = note.trim();
    else delete notesMap[key];
    // Update devicesData in-place so re-opening the detail shows the latest note
    const dev = devicesData.find(d => d.ip === ip);
    if (dev) dev.note = note.trim() || null;
    refreshAllNotes();
    btn.textContent = t('devices.saved');
    renderDevicesTable();
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    alert(t('err.serverGeneric') + e.message);
    btn.textContent = orig;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('dv-detail-investigate').addEventListener('click', async () => {
  if (!dvDetailDevice) return;
  const ip = dvDetailDevice.ip;
  const btn = document.getElementById('dv-detail-investigate');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = t('note.investigating');
  const resultEl = document.getElementById('dv-investigate-result');
  if (resultEl) resultEl.textContent = '';
  try {
    const r = await apiFetch(_BASE+'/api/notes/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip }),
    });
    const data = await r.json();
    const ta = document.getElementById('dv-detail-note-ta');
    if (ta) {
      const sep = ta.value.trim() ? '\n---\n' : '';
      ta.value = ta.value.trim() + sep + (data.draft || '(no info)');
    }
  } catch (e) {
    const resultEl2 = document.getElementById('dv-investigate-result');
    if (resultEl2) resultEl2.textContent = t('note.investigate.fail') + ': ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
});

// ── Merge / reject action buttons (event delegation on detail body) ────────────
document.getElementById('dv-detail-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !dvDetailDevice) return;
  const card = btn.closest('.dv-merge-card');
  if (!card) return;
  const action      = btn.dataset.action;
  const candidateId = Number(card.dataset.candidateId);
  const otherId     = card.dataset.otherId;
  btn.disabled = true;
  try {
    if (action === 'merge') {
      const res = await apiFetch(_BASE+'/api/devices/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepId: dvDetailDevice.deviceId, dropId: otherId }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || res.statusText); }
    } else if (action === 'reject') {
      const res = await apiFetch(_BASE+'/api/devices/reject', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: candidateId }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || res.statusText); }
    }
    await loadDevicesView();   // refreshes candidates + devices + re-opens detail
  } catch (err) {
    alert(t('err.serverGeneric') + err.message);
    btn.disabled = false;
  }
});

// ── P1-8: archive / unarchive button ─────────────────────────────────────────
document.getElementById('dv-detail-archive').addEventListener('click', async () => {
  if (!dvDetailDevice) return;
  const btn = document.getElementById('dv-detail-archive');
  const isArchived = dvDetailDevice.status === 'archived';
  const endpoint = isArchived ? 'unarchive' : 'archive';
  btn.disabled = true;
  try {
    const res = await apiFetch(`${_BASE}/api/devices/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: dvDetailDevice.deviceId }),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || res.statusText); }
    // After archive: close panel (device may leave current filter).
    // After unarchive: reload to show it in active/recent/stale.
    if (!isArchived) {
      dvDetailDevice = null;
      document.getElementById('dv-detail-panel').classList.add('hidden');
    }
    await loadDevicesView();
  } catch (err) {
    alert(t('err.serverGeneric') + err.message);
    btn.disabled = false;
  }
});

// ── P1-8: status filter buttons ───────────────────────────────────────────────
document.getElementById('dv-status-bar').addEventListener('click', e => {
  const btn = e.target.closest('.dv-status-btn');
  if (!btn) return;
  const s = btn.dataset.status;
  if (!s) return;
  // 'archived' tab: toggle + also need to (re-)fetch with includeArchived when turning on
  if (dvStatusFilter.has(s)) {
    // Don't allow deselecting all
    if (dvStatusFilter.size > 1) dvStatusFilter.delete(s);
  } else {
    dvStatusFilter.add(s);
  }
  renderDevicesTable();
});

// ── Column sort ───────────────────────────────────────────────────────────────
document.querySelectorAll('#devices-table th[data-col]').forEach(th => {
  th.addEventListener('click', e => {
    if (e.target.classList.contains('dv-search-icon')) return;
    const col = th.dataset.col;
    const sortable = ['ip','mac','vendor','name','firstSeen','lastSeen'];
    if (!sortable.includes(col)) return;
    if (devicesSortState.col === col) {
      devicesSortState.dir = devicesSortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      devicesSortState.col = col;
      devicesSortState.dir = (col === 'lastSeen' || col === 'firstSeen') ? 'desc' : 'asc';
    }
    renderDevicesTable();
  });
});

// ── Column filter popup ───────────────────────────────────────────────────────
const dvSearchPopup = document.getElementById('dv-search-popup');
const dvSearchInput = document.getElementById('dv-search-input');
const dvSearchMode  = document.getElementById('dv-search-mode');

document.querySelectorAll('.dv-search-icon').forEach(icon => {
  icon.addEventListener('click', e => {
    e.stopPropagation();
    dvSearchTargetCol = icon.dataset.col;
    document.getElementById('dv-search-popup-title').textContent =
      t('log.filter.title') + ': ' + (t('devices.col.' + dvSearchTargetCol) || dvSearchTargetCol);
    const existing = dvFilters[dvSearchTargetCol];
    dvSearchInput.value  = existing?.value || '';
    dvSearchMode.value   = existing?.mode  || 'contains';
    // Position near icon
    const rect = icon.getBoundingClientRect();
    const wrap = document.getElementById('devices-table').closest('.log-table-wrap');
    const wr = wrap.getBoundingClientRect();
    dvSearchPopup.style.top  = (rect.bottom - wr.top + 4) + 'px';
    dvSearchPopup.style.left = Math.min(rect.left - wr.left, wr.width - 240) + 'px';
    dvSearchPopup.classList.remove('hidden');
    dvSearchInput.focus();
  });
});

document.getElementById('dv-search-apply').addEventListener('click', () => {
  if (!dvSearchTargetCol) return;
  dvFilters[dvSearchTargetCol] = { mode: dvSearchMode.value, value: dvSearchInput.value };
  dvSearchPopup.classList.add('hidden');
  renderDevicesTable();
});
document.getElementById('dv-search-clear').addEventListener('click', () => {
  if (dvSearchTargetCol) delete dvFilters[dvSearchTargetCol];
  dvSearchInput.value = '';
  dvSearchPopup.classList.add('hidden');
  renderDevicesTable();
});
document.getElementById('dv-search-close').addEventListener('click', () => {
  dvSearchPopup.classList.add('hidden');
});
dvSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('dv-search-apply').click();
  if (e.key === 'Escape') dvSearchPopup.classList.add('hidden');
});
document.addEventListener('click', e => {
  if (!dvSearchPopup.contains(e.target) && !e.target.classList.contains('dv-search-icon')) {
    dvSearchPopup.classList.add('hidden');
  }
});

document.getElementById('dv-clear-filters-btn').addEventListener('click', () => {
  Object.keys(dvFilters).forEach(k => delete dvFilters[k]);
  dvSelectedIp = null;
  renderDevicesTable();
});

document.getElementById('devices-search').addEventListener('input', renderDevicesTable);
document.getElementById('devices-refresh-btn').addEventListener('click', loadDevicesView);
}

initDevices();

let _onDevicesLoaded = null;
export function setOnDevicesLoaded(fn) { _onDevicesLoaded = fn; }

// ── Load data ─────────────────────────────────────────────────────────────────
async function loadDevicesView() {
  try {
    // Always fetch with includeArchived=1 so status filter works client-side without re-fetching
    const [, res] = await Promise.all([
      loadMergeCandidates(),
      apiFetch(`${_BASE}/api/devices?${appendDisplayScope(new URLSearchParams({ includeArchived: '1' }))}`),
    ]);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    devicesData = data.devices || [];
    if (_onDevicesLoaded) _onDevicesLoaded(devicesData);
    // Refresh detail if open (re-renders with updated candidates)
    if (dvDetailDevice) {
      const fresh = devicesData.find(d => d.ip === dvDetailDevice.ip);
      if (fresh) openDvDetail(fresh);
    }
    renderDevicesTable();
  } catch (e) {
    console.error('[devices] load failed:', e);
    document.getElementById('devices-count').textContent = tVars('devices.loadFailed', { error: e.message });
  }
}

export function refreshDetailPanelNote(newDevicesData) {
  if (!dvDetailDevice) return;
  const fresh = (newDevicesData || devicesData).find(d => d.ip === dvDetailDevice.ip);
  if (!fresh) return;
  dvDetailDevice = fresh;
  const ta = document.getElementById('dv-detail-note-ta');
  if (ta) ta.value = lookupNote(fresh.ip, fresh.mac, fresh.deviceId);
}

export { loadDevicesView, renderDevicesTable, initDevices, devicesData };
export function setDevicesData(v) { devicesData = v; }
export function getDevicesData() { return devicesData; }
export function setDvSelectedIp(v) { dvSelectedIp = v; }
