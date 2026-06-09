// ─── Connection Log View ──────────────────────────────────────────────────────
const logSortState = { col: 'lastSeen', dir: 'desc' };
const logFilters = {}; // col → { mode, value }
let logThreatFilter = null; // null | 'safe' | 'danger'

function getLogCellValue(c, col) {
  switch (col) {
    case 'threatTag': return c.threat ? c.threat.tag : '';
    case 'src': {
      const dns = c.srcDnsName ? c.srcDnsName.split('.')[0] : null;
      const mdns = c.srcMdnsName ? c.srcMdnsName.replace(/\.local$/, '') : null;
      return mdns || dns || c.src;
    }
    case 'dst': return c.dstHost && c.dstHost !== c.dst ? c.dstHost : c.dst;
    case 'dport': return String(c.dport);
    case 'proto': return c.proto;
    case 'country': return c.country || '';
    case 'org': return c.org || '';
    case 'lastSeen': return String(c.lastSeen || 0);
    default: return '';
  }
}

function logMatchFilter(value, filter) {
  if (!filter) return true;
  // Date range mode
  if (filter.mode === 'dateRange') {
    const ts = parseInt(value) || 0;
    if (filter.from) { const fromTs = new Date(filter.from).getTime(); if (ts < fromTs) return false; }
    if (filter.to)   { const toTs = new Date(filter.to).getTime(); if (ts > toTs) return false; }
    return true;
  }
  if (!filter.value) return true;
  const v = value.toLowerCase();
  const f = filter.value.toLowerCase();
  switch (filter.mode) {
    case 'contains': return v.includes(f);
    case 'startsWith': return v.startsWith(f);
    case 'endsWith': return v.endsWith(f);
    case 'regex':
      try { return new RegExp(filter.value, 'i').test(value); }
      catch { return true; }
    default: return true;
  }
}

function updateLogView() {
  if (!logMode) return;
  const tbody = document.getElementById('log-tbody');
  const countEl = document.getElementById('log-count');
  const threatCountEl = document.getElementById('log-threat-count');

  let conns = getFilteredConnections();

  // Apply device filter (when a device is selected in the sidebar)
  const deviceFilterEl = document.getElementById('log-device-filter');
  if (selectedIp) {
    conns = conns.filter(c => c.src === selectedIp || (selectedMac && c.srcMac === selectedMac));
    if (deviceFilterEl) {
      deviceFilterEl.style.display = 'inline';
      deviceFilterEl.innerHTML = `<span style="background:var(--accent);color:#fff;border-radius:4px;padding:1px 7px;font-size:11px;cursor:pointer" title="${esc(t('log.deviceFilter.clear') || 'クリア')}" id="log-device-filter-clear">${esc(selectedIp)} のみ ✕</span>`;
      const clearBtn = document.getElementById('log-device-filter-clear');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        selectedMac = null;
        selectedIp = null;
        updateSideHighlight();
        updateLogView();
      });
    }
  } else {
    if (deviceFilterEl) deviceFilterEl.style.display = 'none';
  }

  // Apply column filters
  for (const [col, filter] of Object.entries(logFilters)) {
    if (!filter || !filter.value) continue;
    conns = conns.filter(c => logMatchFilter(getLogCellValue(c, col), filter));
  }

  // Apply threat badge filter
  // Count threats BEFORE applying badge filter (always show full counts)
  const allConnsForCount = conns; // after column filters but before badge filter
  const threatCount = allConnsForCount.filter(c => c.threat && c.threat.confidence !== 'low').length;
  const warnCount = allConnsForCount.filter(c => c.threat && c.threat.confidence === 'low').length;
  const safeCount = allConnsForCount.length - threatCount - warnCount;

  // Apply threat badge filter
  if (logThreatFilter === 'danger') {
    conns = conns.filter(c => c.threat && c.threat.confidence !== 'low');
  } else if (logThreatFilter === 'warn') {
    conns = conns.filter(c => c.threat && c.threat.confidence === 'low');
  } else if (logThreatFilter === 'safe') {
    conns = conns.filter(c => !c.threat);
  }

  // Sort
  const { col, dir } = logSortState;
  conns.sort((a, b) => {
    let av = getLogCellValue(a, col);
    let bv = getLogCellValue(b, col);
    // Numeric sort for port and time
    if (col === 'dport' || col === 'lastSeen' || col === 'threat') {
      av = parseFloat(av) || 0; bv = parseFloat(bv) || 0;
      return dir === 'asc' ? av - bv : bv - av;
    }
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  countEl.textContent = `${allConnsForCount.length} ${t('log.sessions')}`;
  threatCountEl.style.display = 'inline';
  const safeActive = logThreatFilter === 'safe' ? ' log-filter-active' : '';
  const warnActive = logThreatFilter === 'warn' ? ' log-filter-active' : '';
  const dangerActive = logThreatFilter === 'danger' ? ' log-filter-active' : '';
  threatCountEl.innerHTML = `<span class="log-badge-safe log-badge-clickable${safeActive}" id="log-filter-safe">${t('log.badge.safe')}: ${safeCount}</span> <span class="log-badge-warn log-badge-clickable${warnActive}" id="log-filter-warn">${t('log.badge.warn')}: ${warnCount}</span> <span class="log-badge-danger log-badge-clickable${dangerActive}" id="log-filter-danger">${t('log.badge.danger')}: ${threatCount}</span>`;
  document.getElementById('log-filter-safe').addEventListener('click', () => {
    logThreatFilter = logThreatFilter === 'safe' ? null : 'safe';
    updateLogView();
  });
  document.getElementById('log-filter-warn').addEventListener('click', () => {
    logThreatFilter = logThreatFilter === 'warn' ? null : 'warn';
    updateLogView();
  });
  document.getElementById('log-filter-danger').addEventListener('click', () => {
    logThreatFilter = logThreatFilter === 'danger' ? null : 'danger';
    updateLogView();
  });

  // Update sort icon state
  document.querySelectorAll('#log-table th').forEach(th => {
    const icon = th.querySelector('.log-sort-icon');
    if (!icon) return;
    const c = th.dataset.col;
    icon.className = 'log-sort-icon' + (c === col ? ` ${dir}` : '');
  });

  // Render max 500 rows
  const rows = conns.slice(0, 500);
  tbody.innerHTML = rows.map(c => {
    const isThreat = !!c.threat;
    const isLowConf = isThreat && c.threat.confidence === 'low';
    let threatTagCell;
    if (isThreat && isLowConf) {
      threatTagCell = `<td><span class="log-badge-warn">${esc(t('log.badge.warn'))}</span> <span class="log-threat-tag log-threat-low" title="${esc(c.threat.tag + (c.threat.url ? '\nURL: ' + c.threat.url : ''))}">${esc(c.threat.tag)}</span></td>`;
    } else if (isThreat) {
      threatTagCell = `<td><span class="log-badge-danger">${esc(t('log.badge.danger'))}</span> <span class="log-threat-tag" title="${esc(c.threat.tag + ' [' + c.threat.matchType + ': ' + c.threat.matchValue + ']' + (c.threat.url ? '\nURL: ' + c.threat.url : ''))}">${esc(c.threat.tag)}</span></td>`;
    } else {
      threatTagCell = `<td><span class="log-badge-safe">${esc(t('log.badge.safe'))}</span></td>`;
    }
    const srcShortDns = c.srcDnsName ? c.srcDnsName.split('.')[0] : null;
    const srcShortMdns = c.srcMdnsName ? c.srcMdnsName.replace(/\.local$/, '') : null;
    const srcLabel = srcShortMdns || srcShortDns || c.src;
    const dstLabel = c.dstHost && c.dstHost !== c.dst ? c.dstHost : c.dst;
    const flag = (c.country && c.country.length === 2)
      ? String.fromCodePoint(0x1F1E0 + c.country.charCodeAt(0) - 65, 0x1F1E0 + c.country.charCodeAt(1) - 65)
      : '';
    const timeStr = c.lastSeen ? new Date(c.lastSeen).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    return `<tr class="${isThreat ? (isLowConf ? 'warn-row threat-clickable' : 'threat-row threat-clickable') : ''}" ${isThreat ? `onclick="showThreatDetail(this)" data-threat='${esc(JSON.stringify({src:c.src,srcLabel,dst:c.dst,dstLabel,dport:c.dport,proto:c.proto,country:c.country||'',org:c.org||'',city:c.city||'',dstHost:c.dstHost||'',srcMac:c.srcMac||'',srcVendor:c.srcVendor||'',firstSeen:c.firstSeen||0,lastSeen:c.lastSeen||0,ttl:c.ttl||0,threat:c.threat}))}'` : ''}>
      <td title="${esc(c.src)}">${esc(srcLabel)}</td>
      <td title="${esc(c.dst)}">${esc(dstLabel)}</td>
      ${threatTagCell}
      <td>${c.dport}</td>
      <td>${esc(c.proto)}</td>
      <td>${flag} ${esc(c.country || '')}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${esc(c.org || '')}">${esc(c.org || '')}</td>
      <td>${timeStr}</td>
    </tr>`;
  }).join('');
}

// Sort: click on column header
document.querySelectorAll('#log-table th[data-col]').forEach(th => {
  th.addEventListener('click', (e) => {
    if (e.target.classList.contains('log-search-icon')) return; // don't sort when clicking search
    const col = th.dataset.col;
    if (logSortState.col === col) {
      logSortState.dir = logSortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      logSortState.col = col;
      logSortState.dir = 'desc';
    }
    updateLogView();
  });
});

// Search popup logic
let logSearchTargetCol = null;
const logSearchPopup = document.getElementById('log-search-popup');
const logSearchInput = document.getElementById('log-search-input');
const logSearchMode  = document.getElementById('log-search-mode');

document.querySelectorAll('.log-search-icon').forEach(icon => {
  icon.addEventListener('click', (e) => {
    e.stopPropagation();
    const col = icon.dataset.col;
    logSearchTargetCol = col;
    document.getElementById('log-search-popup-title').textContent = `${t('log.filter.title')}: ${t('log.col.' + col)}`;

    const isDateCol = (col === 'lastSeen');
    const textMode = document.getElementById('log-search-mode');
    const textInput = document.getElementById('log-search-input');
    const dateRange = document.getElementById('log-search-date-range');

    if (isDateCol) {
      textMode.style.display = 'none';
      textInput.style.display = 'none';
      dateRange.style.display = 'flex';
      // Restore existing date filter
      const existing = logFilters[col];
      document.getElementById('log-search-from').value = existing?.from || '';
      document.getElementById('log-search-to').value = existing?.to || '';
    } else {
      textMode.style.display = '';
      textInput.style.display = '';
      dateRange.style.display = 'none';
      // Restore existing filter
      const existing = logFilters[col];
      logSearchMode.value = existing?.mode || 'contains';
      logSearchInput.value = existing?.value || '';
    }

    // Position popup near the icon
    const rect = icon.getBoundingClientRect();
    logSearchPopup.style.top = (rect.bottom + 4) + 'px';
    logSearchPopup.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
    logSearchPopup.classList.remove('hidden');
    if (!isDateCol) logSearchInput.focus();
  });
});

document.getElementById('log-search-apply').addEventListener('click', () => {
  if (!logSearchTargetCol) return;

  if (logSearchTargetCol === 'lastSeen') {
    const from = document.getElementById('log-search-from').value;
    const to = document.getElementById('log-search-to').value;
    if (from || to) {
      logFilters[logSearchTargetCol] = { mode: 'dateRange', from, to };
      document.querySelector(`.log-search-icon[data-col="${logSearchTargetCol}"]`)?.classList.add('active');
    } else {
      delete logFilters[logSearchTargetCol];
      document.querySelector(`.log-search-icon[data-col="${logSearchTargetCol}"]`)?.classList.remove('active');
    }
  } else {
    const val = logSearchInput.value.trim();
    if (val) {
      logFilters[logSearchTargetCol] = { mode: logSearchMode.value, value: val };
      document.querySelector(`.log-search-icon[data-col="${logSearchTargetCol}"]`)?.classList.add('active');
    } else {
      delete logFilters[logSearchTargetCol];
      document.querySelector(`.log-search-icon[data-col="${logSearchTargetCol}"]`)?.classList.remove('active');
    }
  }
  logSearchPopup.classList.add('hidden');
  updateLogView();
});

document.getElementById('log-search-clear').addEventListener('click', () => {
  if (!logSearchTargetCol) return;
  delete logFilters[logSearchTargetCol];
  document.querySelector(`.log-search-icon[data-col="${logSearchTargetCol}"]`)?.classList.remove('active');
  logSearchInput.value = '';
  document.getElementById('log-search-from').value = '';
  document.getElementById('log-search-to').value = '';
  logSearchPopup.classList.add('hidden');
  updateLogView();
});

document.getElementById('log-search-close').addEventListener('click', () => {
  logSearchPopup.classList.add('hidden');
});

// Close popup on outside click
document.addEventListener('click', (e) => {
  if (!logSearchPopup.contains(e.target) && !e.target.classList.contains('log-search-icon')) {
    logSearchPopup.classList.add('hidden');
  }
});

// Enter key in search input
logSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('log-search-apply').click();
  if (e.key === 'Escape') logSearchPopup.classList.add('hidden');
});
