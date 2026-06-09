// ─── Device Inventory View ───────────────────────────────────────────────────
var devicesData = [];
var devicesSortState = { col: 'lastSeen', dir: 'desc' };
var dvFilters = {};          // col → { mode, value }
var dvSearchTargetCol = null;
var dvSelectedIp = null;     // IP filter from sidebar click
var dvDetailDevice = null;   // currently open device
var mergeCandidatesCache = [];  // pending merge candidates from API
// P1-8: status filter — active/recent/stale/archived
var dvStatusFilter = new Set(['active', 'recent']);

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
    filterBadgeEl.style.display = 'inline';
    filterBadgeEl.innerHTML = `<span style="background:var(--accent);color:#fff;border-radius:4px;padding:1px 7px;font-size:11px;cursor:pointer" id="dv-filter-clear">${esc(dvSelectedIp)} のみ ✕</span>`;
    document.getElementById('dv-filter-clear').onclick = () => { dvSelectedIp = null; renderDevicesTable(); };
  } else {
    filterBadgeEl.style.display = 'none';
  }

  // Show "clear filters" button if any column filter is active
  const hasColFilter = Object.values(dvFilters).some(f => f && f.value);
  clearFiltersBtn.style.display = (hasColFilter || dvSelectedIp) ? '' : 'none';

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
  tbody.innerHTML = rows.map(d => {
    const name = deviceName(d);
    const ipv6 = deviceIpv6(d);
    const sources = (d.sources || '').split(',').filter(Boolean).join(' · ');
    const noteText = lookupNote(d.ip, d.mac);
    const isOpen = dvDetailDevice && dvDetailDevice.ip === d.ip;
    const statusCls = d.status === 'stale' ? 'row-stale' : d.status === 'archived' ? 'row-archived' : '';
    return `<tr class="${isOpen ? 'selected' : ''} ${statusCls}" style="cursor:pointer" data-ip="${esc(d.ip)}">
      <td style="font-family:monospace">${esc(d.ip)}</td>
      <td style="font-family:monospace;color:var(--muted)">${d.mac ? esc(d.mac) : '<span style="opacity:.4">—</span>'}</td>
      <td>${d.vendor ? esc(d.vendor) : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${name !== '—' ? esc(name) : '<span style="color:var(--muted)">—</span>'}</td>
      <td style="font-family:monospace;font-size:10px;color:var(--muted)">${ipv6 !== '—' ? esc(ipv6) : '—'}</td>
      <td style="color:var(--muted);font-size:10px">${esc(sources) || '—'}</td>
      <td style="color:var(--muted);font-size:10px">${fmtTs(d.firstSeen)}</td>
      <td style="color:var(--muted);font-size:10px">${fmtTs(d.lastSeen)}</td>
    </tr>`;
  }).join('');

  // Row click → detail panel
  tbody.querySelectorAll('tr[data-ip]').forEach(tr => {
    tr.addEventListener('click', () => {
      const d = devicesData.find(x => x.ip === tr.dataset.ip);
      if (d) openDvDetail(d);
    });
  });

  const countEl = document.getElementById('devices-count');
  if (countEl) {
    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const extra = rows.length < devicesData.filter(d => dvStatusFilter.has(d.status || 'stale')).length
      ? '（フィルター中）' : '';
    countEl.textContent = rows.length + ' 台' + extra + ' / 合計 ' + total + ' 台';
  }
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
  const noteText = d.note != null ? d.note : lookupNote(d.ip, d.mac);

  // Build merge candidates section for this device
  const myCandidates = d.deviceId
    ? mergeCandidatesCache.filter(c => c.deviceIdA === d.deviceId || c.deviceIdB === d.deviceId)
    : [];
  let mergeSectionHtml = '';
  if (myCandidates.length > 0) {
    const cards = myCandidates.map(c => {
      const isA      = c.deviceIdA === d.deviceId;
      const otherId  = isA ? c.deviceIdB : c.deviceIdA;
      const otherIp  = isA ? c.ipB       : c.ipA;
      const otherMac = isA ? c.macB      : c.macA;
      const otherName= isA ? (c.mdnsNameB || c.dnsNameB) : (c.mdnsNameA || c.dnsNameA);
      const scoreStr = (c.score * 100).toFixed(0) + '%';
      const reasons  = Array.isArray(c.reasons) ? c.reasons.join(', ') : (c.reasons || '');
      const label    = [otherIp, otherMac, otherName].filter(Boolean).join(' / ');
      return `
        <div class="dv-merge-card" data-candidate-id="${esc(String(c.id))}" data-other-id="${esc(otherId || '')}">
          <div class="dv-merge-card-info">${esc(label || otherId || '—')}</div>
          <div class="dv-merge-card-score">類似度: ${scoreStr}${reasons ? '　' + esc(reasons) : ''}</div>
          <div class="dv-merge-card-btns">
            <button class="btn-merge" data-action="merge">🔀 この端末に統合</button>
            <button class="btn-reject" data-action="reject">✕ 却下</button>
          </div>
        </div>`;
    }).join('');
    mergeSectionHtml = `
      <div class="dv-merge-section">
        <div class="dv-merge-title">🔀 名寄せ候補</div>
        ${cards}
      </div>`;
  }

  // P1-8: archive button label
  const archiveBtn = document.getElementById('dv-detail-archive');
  if (archiveBtn) {
    if (d.status === 'archived') {
      archiveBtn.textContent = '📤 復元';
      archiveBtn.title = 'アーカイブを解除して通常一覧に戻す';
    } else {
      archiveBtn.textContent = '📦 アーカイブ';
      archiveBtn.title = '端末を一覧から非表示にする（データは保持）';
    }
  }

  // P1-8: status badge
  const statusLabels = { active: '🟢 Active', recent: '🔵 Recent', stale: '🟡 Stale', archived: '⬜ Archived' };
  const statusCls    = { active: 's-active', recent: 's-recent', stale: 's-stale', archived: 's-archived' };
  const statusStr    = d.status || 'stale';

  document.getElementById('dv-detail-body').innerHTML = `
    <div class="dv-detail-row"><span class="dv-detail-label">状態</span><span class="dv-detail-value ${statusCls[statusStr]}">${statusLabels[statusStr] || statusStr}</span></div>
    ${d.vendor ? `<div class="dv-detail-row"><span class="dv-detail-label">ベンダー</span><span class="dv-detail-value">${esc(d.vendor)}</span></div>` : ''}
    ${name !== '—' ? `<div class="dv-detail-row"><span class="dv-detail-label">名前</span><span class="dv-detail-value">${esc(name)}</span></div>` : ''}
    ${d.dnsName  ? `<div class="dv-detail-row"><span class="dv-detail-label">DNS</span><span class="dv-detail-value" style="font-size:10px">${esc(d.dnsName)}</span></div>` : ''}
    ${d.mdnsName ? `<div class="dv-detail-row"><span class="dv-detail-label">mDNS</span><span class="dv-detail-value">${esc(d.mdnsName)}</span></div>` : ''}
    ${d.netbiosName ? `<div class="dv-detail-row"><span class="dv-detail-label">NetBIOS</span><span class="dv-detail-value">${esc(d.netbiosName)}</span></div>` : ''}
    ${ipv6List.length ? `<div class="dv-detail-row"><span class="dv-detail-label">IPv6</span><span class="dv-detail-value" style="font-family:monospace;font-size:10px">${ipv6List.map(esc).join('<br>')}</span></div>` : ''}
    <div class="dv-detail-row"><span class="dv-detail-label">ソース</span><span class="dv-detail-value">${esc(sources) || '—'}</span></div>
    <div class="dv-detail-row"><span class="dv-detail-label">初回確認</span><span class="dv-detail-value">${fmtTs(d.firstSeen)}</span></div>
    <div class="dv-detail-row"><span class="dv-detail-label">最終確認</span><span class="dv-detail-value">${fmtTs(d.lastSeen)}</span></div>
    ${mergeSectionHtml}
    <div style="margin-top:4px;font-size:11px;color:var(--muted);margin-bottom:2px">メモ</div>
    <textarea class="dv-detail-note-ta" id="dv-detail-note-ta" placeholder="${esc(t('note.placeholder'))}">${esc(noteText)}</textarea>
    <div id="dv-investigate-result" style="font-size:10px;color:var(--muted);margin-top:4px;white-space:pre-wrap;"></div>
  `;
  // Re-render table to highlight selected row
  renderDevicesTable();
}

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
  try {
    await apiFetch(_BASE+'/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, mac, note }),
    });
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
    const btn = document.getElementById('dv-detail-save');
    const orig = btn.textContent;
    btn.textContent = '✓ 保存済';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    alert(t('err.serverGeneric') + e.message);
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
    alert('エラー: ' + err.message);
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
    alert('エラー: ' + err.message);
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
  th.style.cursor = 'pointer';
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
      (t('log.filter.title') || 'フィルター') + ': ' + (t('devices.col.' + dvSearchTargetCol) || dvSearchTargetCol);
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

// ── Load data ─────────────────────────────────────────────────────────────────
async function loadDevicesView() {
  try {
    // Always fetch with includeArchived=1 so status filter works client-side without re-fetching
    const [, res] = await Promise.all([
      loadMergeCandidates(),
      apiFetch(_BASE+'/api/devices?includeArchived=1'),
    ]);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    devicesData = data.devices || [];
    // Refresh detail if open (re-renders with updated candidates)
    if (dvDetailDevice) {
      const fresh = devicesData.find(d => d.ip === dvDetailDevice.ip);
      if (fresh) openDvDetail(fresh);
    }
    renderDevicesTable();
  } catch (e) {
    console.error('[devices] load failed:', e);
    document.getElementById('devices-count').textContent = '読み込み失敗: ' + e.message;
  }
}

document.getElementById('devices-search').addEventListener('input', renderDevicesTable);
document.getElementById('devices-refresh-btn').addEventListener('click', loadDevicesView);
