// ─── Connection Log View ──────────────────────────────────────────────────────
const logSortState = { col: 'lastSeen', dir: 'desc' };
const logFilters = {}; // col → { mode, value }
let logThreatFilter = null; // null | 'safe' | 'warn' | 'danger'

// ── Pagination state ──────────────────────────────────────────────────────────
let logPage = 0;
const LOG_PAGE_SIZE = 200;
let logTotal = 0;
let logPageData = []; // current page's data from server
let logFetchGeneration = 0;

// Columns handled server-side (DB columns). Everything else is client-side only.
const LOG_SERVER_SORT_COLS   = new Set(['lastSeen', 'src', 'dst', 'dport', 'proto', 'country', 'org']);
const LOG_SERVER_FILTER_COLS = new Set(['src', 'dst', 'dport', 'proto', 'country', 'org']);
// Mapping: log column name → URL param names for value and mode
const LOG_FILTER_PARAM = { src: 'fSrc', dst: 'fDst', dport: 'fDport', proto: 'fProto', country: 'fCountry', org: 'fOrg' };
const LOG_FILTER_MODE_PARAM = { src: 'fSrcMode', dst: 'fDstMode', dport: 'fDportMode', proto: 'fProtoMode', country: 'fCountryMode', org: 'fOrgMode' };

function getLogCellValue(c, col) {
  switch (col) {
    case 'threatTag': return c.threat ? c.threat.tag : '';
    case 'src': {
      const dns  = c.srcDnsName  ? c.srcDnsName.split('.')[0]             : null;
      const mdns = c.srcMdnsName ? c.srcMdnsName.replace(/\.local$/, '') : null;
      return mdns || dns || c.src;
    }
    case 'dst':     return c.dstHost && c.dstHost !== c.dst ? c.dstHost : c.dst;
    case 'dport':   return String(c.dport);
    case 'app':     return guessApp(c.dport, c.proto, c.dstHost || c.dst);
    case 'proto':   return c.proto;
    case 'country': return c.country || '';
    case 'org':     return c.org || '';
    case 'lastSeen': return String(c.lastSeen || 0);
    default: return '';
  }
}

function logMatchFilter(value, filter) {
  if (!filter) return true;
  if (filter.mode === 'dateRange') {
    const ts = parseInt(value) || 0;
    if (filter.from) { const fromTs = new Date(filter.from).getTime(); if (ts < fromTs) return false; }
    if (filter.to)   { const toTs   = new Date(filter.to).getTime();   if (ts > toTs)   return false; }
    return true;
  }
  if (!filter.value) return true;
  const v = value.toLowerCase();
  const f = filter.value.toLowerCase();
  switch (filter.mode) {
    case 'contains':   return v.includes(f);
    case 'startsWith': return v.startsWith(f);
    case 'endsWith':   return v.endsWith(f);
    case 'regex':
      try { return new RegExp(filter.value, 'i').test(value); }
      catch { return true; }
    default: return true;
  }
}

// ── Pagination UI ─────────────────────────────────────────────────────────────
function renderPagination() {
  const el = document.getElementById('log-pagination');
  if (!el) return;
  // When fetching all rows for client-side filtering, pagination is meaningless
  if (logFetchAllMode) { el.style.display = 'none'; return; }
  const totalPages = Math.max(1, Math.ceil(logTotal / LOG_PAGE_SIZE));
  if (totalPages <= 1 && logTotal <= LOG_PAGE_SIZE) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const prevDisabled = logPage === 0            ? 'disabled' : '';
  const nextDisabled = logPage >= totalPages - 1 ? 'disabled' : '';
  el.innerHTML = `
    <button id="log-page-prev" ${prevDisabled} style="padding:2px 8px;font-size:11px;cursor:pointer">&laquo;</button>
    <span>${logPage + 1} / ${totalPages} ${t('log.page') || 'ページ'}</span>
    <button id="log-page-next" ${nextDisabled} style="padding:2px 8px;font-size:11px;cursor:pointer">&raquo;</button>
    <span style="color:var(--muted)">(${t('log.total') || '合計'} ${logTotal})</span>
  `;
  document.getElementById('log-page-prev')?.addEventListener('click', () => {
    if (logPage > 0) { logPage--; fetchLogPage(); }
  });
  document.getElementById('log-page-next')?.addEventListener('click', () => {
    if (logPage < totalPages - 1) { logPage++; fetchLogPage(); }
  });
}

// Returns true when active filters/sort cannot be applied server-side
// (app, threatTag, regex mode, threat-badge).
// selectedMac is now passed as fSrcMac to the server, so it no longer forces
// a full client-side fetch.
function hasClientSideOnlyFilter() {
  if (logThreatFilter !== null) return true;
  if (!LOG_SERVER_SORT_COLS.has(logSortState.col)) return true;
  for (const [col, filter] of Object.entries(logFilters)) {
    if (!filter) continue;
    if ((col === 'app' || col === 'threatTag') && filter.value) return true;
    if (filter.value && filter.mode === 'regex') return true;
  }
  return false;
}

let logFetchAllMode = false; // true while a client-side-only filter is active

// ── Server fetch ──────────────────────────────────────────────────────────────
async function fetchLogPage() {
  if (!logMode) return;
  const generation = ++logFetchGeneration;
  logFetchAllMode = hasClientSideOnlyFilter();
  const { from, to } = getTimeRange();
  const params = new URLSearchParams();
  // Paginate only when no client-side-only filters are active
  if (!logFetchAllMode) {
    params.set('limit',  LOG_PAGE_SIZE);
    params.set('offset', logPage * LOG_PAGE_SIZE);
  }

  // Time range — narrow further if lastSeen column has a dateRange filter
  let serverFrom = from;
  let serverTo   = to;
  const lastSeenFilter = logFilters['lastSeen'];
  if (lastSeenFilter?.mode === 'dateRange') {
    if (lastSeenFilter.from) {
      const f = new Date(lastSeenFilter.from).getTime();
      serverFrom = serverFrom != null ? Math.max(serverFrom, f) : f;
    }
    if (lastSeenFilter.to) {
      const tVal = new Date(lastSeenFilter.to).getTime();
      serverTo = serverTo != null ? Math.min(serverTo, tVal) : tVal;
    }
  }
  if (serverFrom != null) params.set('from', serverFrom);
  if (serverTo   != null) params.set('to',   serverTo);

  // Server-side sort (DB columns only)
  if (LOG_SERVER_SORT_COLS.has(logSortState.col)) {
    params.set('sort',    logSortState.col);
    params.set('sortDir', logSortState.dir);
  }

  // Device filter: MAC → server-side exact match on srcMac column (covers roaming/DHCP).
  // IP-only (no MAC known) → server-side exact match on src column.
  if (selectedMac) {
    params.set('fSrcMac', selectedMac);
  } else if (selectedIp) {
    params.set('fSrc',     selectedIp);
    params.set('fSrcMode', 'exact');
  }

  // Server-side column filters (DB columns, non-regex; src skipped when device filter active)
  for (const [col, filter] of Object.entries(logFilters)) {
    if (col === 'src' && (selectedMac || selectedIp)) continue;
    if (LOG_SERVER_FILTER_COLS.has(col) && filter?.value && filter.mode !== 'regex') {
      params.set(LOG_FILTER_PARAM[col],      filter.value);
      params.set(LOG_FILTER_MODE_PARAM[col], filter.mode || 'contains');
    }
  }

  setFetching(+1);
  try {
    const res = await apiFetch(`${_BASE}/api/connections?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    if (generation !== logFetchGeneration) return;
    logPageData = data.connections || [];
    logTotal = typeof data.total === 'number' ? data.total : logPageData.length;
    if (data.serverTime) serverTimeOffset = data.serverTime - Date.now();
    renderLogView();
  } catch (e) {
    console.error('[log] fetch failed:', e);
  } finally {
    setFetching(-1);
  }
}

// ── Render (client-side-only filters applied on top of server page) ───────────
function renderLogView() {
  if (!logMode) return;
  const tbody     = document.getElementById('log-tbody');
  const countEl   = document.getElementById('log-count');
  const threatCountEl = document.getElementById('log-threat-count');

  let conns = logPageData.slice();

  // Device filter badge + safety guard. Both IP and MAC filters are now applied
  // server-side; this just ensures no stale rows slip through on page transitions.
  const deviceFilterEl = document.getElementById('log-device-filter');
  if (selectedIp || selectedMac) {
    conns = conns.filter(c =>
      (selectedMac && c.srcMac === selectedMac) ||
      (!selectedMac && selectedIp && c.src === selectedIp)
    );
    if (deviceFilterEl) {
      deviceFilterEl.style.display = 'inline';
      const label = selectedIp || selectedMac;
      deviceFilterEl.innerHTML = `<span style="background:var(--accent);color:#fff;border-radius:4px;padding:1px 7px;font-size:11px;cursor:pointer" title="${esc(t('log.deviceFilter.clear'))}" id="log-device-filter-clear">${esc(tVars('log.deviceFilter.only', { value: label }))}</span>`;
      document.getElementById('log-device-filter-clear')?.addEventListener('click', () => {
        selectedMac = null; selectedIp = null;
        updateSideHighlight();
        logPage = 0; fetchLogPage();
      });
    }
  } else {
    if (deviceFilterEl) deviceFilterEl.style.display = 'none';
  }

  // Client-side-only column filters (app, threatTag, regex mode)
  for (const [col, filter] of Object.entries(logFilters)) {
    if (!filter) continue;
    // Handled server-side: DB column non-regex filters and lastSeen dateRange
    if (col === 'lastSeen' && filter.mode === 'dateRange') continue;
    if (LOG_SERVER_FILTER_COLS.has(col) && filter.value && filter.mode !== 'regex') continue;
    if (!filter.value && filter.mode !== 'dateRange') continue;
    conns = conns.filter(c => logMatchFilter(getLogCellValue(c, col), filter));
  }

  // Client-side-only sort (app, threatTag columns)
  if (!LOG_SERVER_SORT_COLS.has(logSortState.col)) {
    const { col, dir } = logSortState;
    conns.sort((a, b) => {
      const av = getLogCellValue(a, col);
      const bv = getLogCellValue(b, col);
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  // Threat counts (before badge filter)
  const threatCount = conns.filter(c => c.threat && c.threat.confidence !== 'low').length;
  const warnCount   = conns.filter(c => c.threat && c.threat.confidence === 'low').length;
  const safeCount   = conns.length - threatCount - warnCount;

  if (logThreatFilter === 'danger') {
    conns = conns.filter(c => c.threat && c.threat.confidence !== 'low');
  } else if (logThreatFilter === 'warn') {
    conns = conns.filter(c => c.threat && c.threat.confidence === 'low');
  } else if (logThreatFilter === 'safe') {
    conns = conns.filter(c => !c.threat);
  }

  // In all-rows mode show "filtered / fetched"; in paged mode show server total
  if (logFetchAllMode) {
    countEl.textContent = `${conns.length} / ${logPageData.length} ${t('log.sessions')}`;
  } else {
    countEl.textContent = `${logTotal} ${t('log.sessions')}`;
  }
  threatCountEl.style.display = 'inline';
  const safeActive   = logThreatFilter === 'safe'   ? ' log-filter-active' : '';
  const warnActive   = logThreatFilter === 'warn'   ? ' log-filter-active' : '';
  const dangerActive = logThreatFilter === 'danger' ? ' log-filter-active' : '';
  const pageSuffix = logFetchAllMode ? '' : `<span style="font-size:10px;color:var(--muted)"> (${t('log.page') || 'ページ'})</span>`;
  threatCountEl.innerHTML = `<span class="log-badge-safe log-badge-clickable${safeActive}" id="log-filter-safe">${t('log.badge.safe')}: ${safeCount}</span> <span class="log-badge-warn log-badge-clickable${warnActive}" id="log-filter-warn">${t('log.badge.warn')}: ${warnCount}</span> <span class="log-badge-danger log-badge-clickable${dangerActive}" id="log-filter-danger">${t('log.badge.danger')}: ${threatCount}</span>${pageSuffix}`;
  document.getElementById('log-filter-safe')?.addEventListener('click', () => {
    logThreatFilter = logThreatFilter === 'safe' ? null : 'safe'; logPage = 0; fetchLogPage();
  });
  document.getElementById('log-filter-warn')?.addEventListener('click', () => {
    logThreatFilter = logThreatFilter === 'warn' ? null : 'warn'; logPage = 0; fetchLogPage();
  });
  document.getElementById('log-filter-danger')?.addEventListener('click', () => {
    logThreatFilter = logThreatFilter === 'danger' ? null : 'danger'; logPage = 0; fetchLogPage();
  });

  // Sort icon state
  document.querySelectorAll('#log-table th').forEach(th => {
    const icon = th.querySelector('.log-sort-icon');
    if (!icon) return;
    icon.className = 'log-sort-icon' + (th.dataset.col === logSortState.col ? ` ${logSortState.dir}` : '');
  });

  tbody.innerHTML = conns.map(c => {
    const isThreat  = !!c.threat;
    const isLowConf = isThreat && c.threat.confidence === 'low';
    let threatTagCell;
    if (isThreat && isLowConf) {
      threatTagCell = `<td><span class="log-badge-warn">${esc(t('log.badge.warn'))}</span> <span class="log-threat-tag log-threat-low" title="${esc(c.threat.tag + (c.threat.url ? '\nURL: ' + c.threat.url : ''))}">${esc(c.threat.tag)}</span></td>`;
    } else if (isThreat) {
      threatTagCell = `<td><span class="log-badge-danger">${esc(t('log.badge.danger'))}</span> <span class="log-threat-tag" title="${esc(c.threat.tag + ' [' + c.threat.matchType + ': ' + c.threat.matchValue + ']' + (c.threat.url ? '\nURL: ' + c.threat.url : ''))}">${esc(c.threat.tag)}</span></td>`;
    } else {
      threatTagCell = `<td><span class="log-badge-safe">${esc(t('log.badge.safe'))}</span></td>`;
    }
    const srcShortDns  = c.srcDnsName  ? c.srcDnsName.split('.')[0]             : null;
    const srcShortMdns = c.srcMdnsName ? c.srcMdnsName.replace(/\.local$/, '') : null;
    const srcLabel = srcShortMdns || srcShortDns || c.src;
    const dstLabel = c.dstHost && c.dstHost !== c.dst ? c.dstHost : c.dst;
    const flag = (c.country && c.country.length === 2)
      ? String.fromCodePoint(0x1F1E0 + c.country.charCodeAt(0) - 65, 0x1F1E0 + c.country.charCodeAt(1) - 65)
      : '';
    const timeStr = c.lastSeen
      ? new Date(c.lastSeen).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';
    return `<tr class="${isThreat ? (isLowConf ? 'warn-row threat-clickable' : 'threat-row threat-clickable') : ''}" ${isThreat ? `onclick="showThreatDetail(this)" data-threat='${esc(JSON.stringify({src:c.src,srcLabel,dst:c.dst,dstLabel,dport:c.dport,proto:c.proto,country:c.country||'',org:c.org||'',city:c.city||'',dstHost:c.dstHost||'',srcMac:c.srcMac||'',srcVendor:c.srcVendor||'',firstSeen:c.firstSeen||0,lastSeen:c.lastSeen||0,ttl:c.ttl||0,threat:c.threat}))}'` : ''}>
      <td title="${esc(c.src)}">${esc(srcLabel)}</td>
      <td title="${esc(c.dst)}">${esc(dstLabel)}</td>
      ${threatTagCell}
      <td>${c.dport}</td>
      <td style="font-size:11px;color:var(--muted);">${esc(guessApp(c.dport, c.proto, c.dstHost || c.dst))}</td>
      <td>${esc(c.proto)}</td>
      <td>${flag} ${esc(c.country || '')}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${esc(c.org || '')}">${esc(c.org || '')}</td>
      <td>${timeStr}</td>
    </tr>`;
  }).join('');

  renderPagination();
}

// ── Public entry point: reset to page 0 and re-fetch from server ──────────────
function updateLogView() {
  if (!logMode) return;
  logPage = 0;
  fetchLogPage();
}

// ── Sort: click on column header ──────────────────────────────────────────────
document.querySelectorAll('#log-table th[data-col]').forEach(th => {
  th.addEventListener('click', (e) => {
    if (e.target.classList.contains('log-search-icon')) return;
    const col = th.dataset.col;
    if (logSortState.col === col) {
      logSortState.dir = logSortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      logSortState.col = col;
      logSortState.dir = 'desc';
    }
    // Always re-fetch: server-side cols change ORDER BY, client-only cols (app,
    // threatTag) need full-fetch mode so sorting covers the entire result set
    logPage = 0;
    fetchLogPage();
  });
});

// ── Search popup logic ────────────────────────────────────────────────────────
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
    const textMode  = document.getElementById('log-search-mode');
    const textInput = document.getElementById('log-search-input');
    const dateRange = document.getElementById('log-search-date-range');

    if (isDateCol) {
      textMode.style.display = 'none';
      textInput.style.display = 'none';
      dateRange.style.display = 'flex';
      const existing = logFilters[col];
      document.getElementById('log-search-from').value = existing?.from || '';
      document.getElementById('log-search-to').value   = existing?.to   || '';
    } else {
      textMode.style.display = '';
      textInput.style.display = '';
      dateRange.style.display = 'none';
      const existing = logFilters[col];
      logSearchMode.value  = existing?.mode  || 'contains';
      logSearchInput.value = existing?.value || '';
    }

    const rect = icon.getBoundingClientRect();
    logSearchPopup.style.top  = (rect.bottom + 4) + 'px';
    logSearchPopup.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
    logSearchPopup.classList.remove('hidden');
    if (!isDateCol) logSearchInput.focus();
  });
});

document.getElementById('log-search-apply').addEventListener('click', () => {
  if (!logSearchTargetCol) return;
  const col = logSearchTargetCol;

  if (col === 'lastSeen') {
    const from = document.getElementById('log-search-from').value;
    const to   = document.getElementById('log-search-to').value;
    if (from || to) {
      logFilters[col] = { mode: 'dateRange', from, to };
      document.querySelector(`.log-search-icon[data-col="${col}"]`)?.classList.add('active');
    } else {
      delete logFilters[col];
      document.querySelector(`.log-search-icon[data-col="${col}"]`)?.classList.remove('active');
    }
  } else {
    const val = logSearchInput.value.trim();
    if (val) {
      logFilters[col] = { mode: logSearchMode.value, value: val };
      document.querySelector(`.log-search-icon[data-col="${col}"]`)?.classList.add('active');
    } else {
      delete logFilters[col];
      document.querySelector(`.log-search-icon[data-col="${col}"]`)?.classList.remove('active');
    }
  }
  logSearchPopup.classList.add('hidden');

  // Always re-fetch: server-side filters change the query, client-side filters
  // may switch to full-fetch mode (logFetchAllMode) via hasClientSideOnlyFilter()
  logPage = 0;
  fetchLogPage();
});

document.getElementById('log-search-clear').addEventListener('click', () => {
  if (!logSearchTargetCol) return;
  const col = logSearchTargetCol;
  delete logFilters[col];
  document.querySelector(`.log-search-icon[data-col="${col}"]`)?.classList.remove('active');
  logSearchInput.value = '';
  document.getElementById('log-search-from').value = '';
  document.getElementById('log-search-to').value   = '';
  logSearchPopup.classList.add('hidden');
  logPage = 0; fetchLogPage();
});

document.getElementById('log-search-close').addEventListener('click', () => {
  logSearchPopup.classList.add('hidden');
});

document.addEventListener('click', (e) => {
  if (!logSearchPopup.contains(e.target) && !e.target.classList.contains('log-search-icon')) {
    logSearchPopup.classList.add('hidden');
  }
});

logSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('log-search-apply').click();
  if (e.key === 'Escape') logSearchPopup.classList.add('hidden');
});
