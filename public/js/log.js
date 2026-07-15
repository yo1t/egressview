// ─── Connection Log View ──────────────────────────────────────────────────────
import { t, tVars, currentLang } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, guessApp } from './utils.js?v=__ASSET_VERSION__';
import { getTimeRange, setFetching, setServerTimeOffset } from './connections-panel.js?v=__ASSET_VERSION__';
import { logMode } from './view-tabs.js?v=__ASSET_VERSION__';
import { selectedMac, selectedIp, updateSideHighlight, clearSelection } from './graph.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { showThreatDetail } from './threat-popup.js?v=__ASSET_VERSION__';

const logSortState = { col: 'lastSeen', dir: 'desc' };
const logFilters = {}; // col → { mode, value }
let logThreatFilter = null; // null | 'safe' | 'warn' | 'danger'

// ── Infinite-scroll state ─────────────────────────────────────────────────────
let logPage = 0;
const LOG_PAGE_SIZE = 200;
let logTotal = 0;
let logAllData = [];         // rows accumulated across all pages loaded so far
let logFetchGeneration = 0;
let logFetchingPage = false; // lock: prevents duplicate scroll-triggered fetches
let logScrollObserver = null;

// ── Threat count state (server-side aggregate) ────────────────────────────────
let logThreatCounts = null; // null = loading; { safe, warn, danger } when ready

// Columns handled server-side (DB columns). Everything else is client-side only.
const LOG_SERVER_SORT_COLS   = new Set(['lastSeen', 'src', 'dst', 'dport', 'proto', 'country', 'org']);
const LOG_SERVER_FILTER_COLS = new Set(['src', 'dst', 'dport', 'proto', 'country', 'org']);
// Mapping: log column name → URL param names for value and mode
const LOG_FILTER_PARAM = { src: 'fSrc', dst: 'fDst', dport: 'fDport', proto: 'fProto', country: 'fCountry', org: 'fOrg' };
const LOG_FILTER_MODE_PARAM = { src: 'fSrcMode', dst: 'fDstMode', dport: 'fDportMode', proto: 'fProtoMode', country: 'fCountryMode', org: 'fOrgMode' };

function createTextElement(tagName, text, { className = '', id = '', title = '' } = {}) {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (id) el.id = id;
  if (title) el.title = title;
  el.textContent = text == null ? '' : String(text);
  return el;
}

function appendLogCell(row, text, options = {}) {
  const cell = createTextElement('td', text, options);
  row.appendChild(cell);
  return cell;
}

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

// Returns true when active filters/sort cannot be applied server-side
// (app, threatTag, regex mode).
// selectedMac is passed as fSrcMac to the server, so it no longer forces
// a full client-side fetch.
function hasClientSideOnlyFilter() {
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
  if (logFetchingPage) return;
  logFetchingPage = true;
  const gen = logFetchGeneration;
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

  // Threat filter — handled server-side; removes the need to send all rows to the client
  if (logThreatFilter) params.set('fThreat', logThreatFilter);

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
    if (gen !== logFetchGeneration) return;

    const incoming = data.connections || [];
    const isAppend = logPage > 0 && !logFetchAllMode;
    if (!isAppend) {
      logAllData = incoming;
    } else {
      logAllData = logAllData.concat(incoming);
    }
    logTotal = typeof data.total === 'number' ? data.total : logAllData.length;
    if (data.serverTime) setServerTimeOffset(data.serverTime - Date.now());

    renderLogView(isAppend ? incoming : null);
    if (!logFetchAllMode) setupScrollObserver();
  } catch (e) {
    console.error('[log] fetch failed:', e);
  } finally {
    setFetching(-1);
    logFetchingPage = false;
  }
}

// ── Infinite-scroll observer ──────────────────────────────────────────────────
function setupScrollObserver() {
  if (logScrollObserver) { logScrollObserver.disconnect(); logScrollObserver = null; }
  // Remove old sentinel
  document.getElementById('log-scroll-sentinel')?.remove();
  if (logAllData.length >= logTotal) {
    updateScrollStatus();
    return;
  }
  if (typeof IntersectionObserver === 'undefined') return;

  // Insert sentinel row at end of tbody
  const tbody = document.getElementById('log-tbody');
  if (!tbody) return;
  const sentinel = document.createElement('tr');
  sentinel.id = 'log-scroll-sentinel';
  const sentinelCell = document.createElement('td');
  sentinelCell.colSpan = 9;
  sentinelCell.className = 'log-scroll-sentinel-cell';
  sentinel.appendChild(sentinelCell);
  tbody.appendChild(sentinel);

  logScrollObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) {
      logPage++;
      fetchLogPage();
    }
  }, { rootMargin: '200px' });
  logScrollObserver.observe(sentinel);
  updateScrollStatus();
}

function updateScrollStatus() {
  const el = document.getElementById('log-pagination');
  if (!el) return;
  if (logFetchAllMode || logAllData.length >= logTotal) {
    el.classList.remove('is-visible');
    return;
  }
  el.classList.add('is-visible');
  el.replaceChildren(createTextElement(
    'span',
    `${logAllData.length} / ${logTotal} ${t('log.sessions')}`,
    { className: 'log-status-text' }
  ));
}

// ── Server-side threat counts ─────────────────────────────────────────────────
async function fetchThreatCounts() {
  const gen = logFetchGeneration; // captured — discard if a newer query started
  const { from, to } = getTimeRange();
  const params = new URLSearchParams();

  // Apply the same time range and filter params as fetchLogPage (no sort/pagination)
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

  if (selectedMac) {
    params.set('fSrcMac', selectedMac);
  } else if (selectedIp) {
    params.set('fSrc',     selectedIp);
    params.set('fSrcMode', 'exact');
  }
  for (const [col, filter] of Object.entries(logFilters)) {
    if (col === 'src' && (selectedMac || selectedIp)) continue;
    if (LOG_SERVER_FILTER_COLS.has(col) && filter?.value && filter.mode !== 'regex') {
      params.set(LOG_FILTER_PARAM[col],      filter.value);
      params.set(LOG_FILTER_MODE_PARAM[col], filter.mode || 'contains');
    }
  }

  try {
    const res = await apiFetch(`${_BASE}/api/connections/threat-counts?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    if (gen !== logFetchGeneration) return; // stale
    logThreatCounts = { safe: data.safe || 0, warn: data.warn || 0, danger: data.danger || 0 };
    renderThreatBadges();
  } catch (e) {
    console.error('[log] threat counts fetch failed:', e);
  }
}

function renderThreatBadges() {
  const threatCountEl = document.getElementById('log-threat-count');
  if (!threatCountEl) return;
  if (!logThreatCounts) {
    threatCountEl.replaceChildren(createTextElement('span', '...', { className: 'log-status-text' }));
    return;
  }
  const { safe, warn, danger } = logThreatCounts;
  const badges = [
    { kind: 'safe', count: safe, className: 'log-badge-safe' },
    { kind: 'warn', count: warn, className: 'log-badge-warn' },
    { kind: 'danger', count: danger, className: 'log-badge-danger' },
  ].map(({ kind, count, className }) => {
    const badge = createTextElement(
      'span',
      `${t(`log.badge.${kind}`)}: ${count}`,
      { className: `${className} log-badge-clickable`, id: `log-filter-${kind}` }
    );
    if (logThreatFilter === kind) badge.classList.add('log-filter-active');
    badge.addEventListener('click', () => {
      logThreatFilter = logThreatFilter === kind ? null : kind;
      resetAndFetch();
    });
    return badge;
  });
  threatCountEl.replaceChildren(...badges);
}

function createThreatCell(connection, isLowConfidence) {
  const cell = document.createElement('td');
  if (!connection.threat) {
    cell.appendChild(createTextElement('span', t('log.badge.safe'), { className: 'log-badge-safe' }));
    return cell;
  }

  const threat = connection.threat;
  const badgeClass = isLowConfidence ? 'log-badge-warn' : 'log-badge-danger';
  const badgeKey = isLowConfidence ? 'warn' : 'danger';
  cell.appendChild(createTextElement('span', t(`log.badge.${badgeKey}`), { className: badgeClass }));

  const title = isLowConfidence
    ? threat.tag + (threat.url ? `\nURL: ${threat.url}` : '')
    : `${threat.tag} [${threat.matchType}: ${threat.matchValue}]${threat.url ? `\nURL: ${threat.url}` : ''}`;
  cell.appendChild(createTextElement('span', threat.tag, {
    className: `log-threat-tag${isLowConfidence ? ' log-threat-low' : ''}`,
    title,
  }));
  return cell;
}

function createLogRow(connection) {
  const isThreat = !!connection.threat;
  const isLowConfidence = isThreat && connection.threat.confidence === 'low';
  const srcShortDns = connection.srcDnsName ? connection.srcDnsName.split('.')[0] : null;
  const srcShortMdns = connection.srcMdnsName ? connection.srcMdnsName.replace(/\.local$/, '') : null;
  const srcLabel = srcShortMdns || srcShortDns || connection.src;
  const dstLabel = connection.dstHost && connection.dstHost !== connection.dst
    ? connection.dstHost
    : connection.dst;
  const flag = (connection.country && connection.country.length === 2)
    ? String.fromCodePoint(
      0x1F1E6 + connection.country.charCodeAt(0) - 65,
      0x1F1E6 + connection.country.charCodeAt(1) - 65
    )
    : '';
  const timeText = connection.lastSeen
    ? new Date(connection.lastSeen).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    : '';

  const row = document.createElement('tr');
  if (isThreat) {
    row.classList.add(isLowConfidence ? 'warn-row' : 'threat-row', 'threat-clickable');
    row.dataset.threat = JSON.stringify({
      src: connection.src,
      srcLabel,
      dst: connection.dst,
      dstLabel,
      dport: connection.dport,
      proto: connection.proto,
      country: connection.country || '',
      org: connection.org || '',
      city: connection.city || '',
      dstHost: connection.dstHost || '',
      srcMac: connection.srcMac || '',
      srcVendor: connection.srcVendor || '',
      firstSeen: connection.firstSeen || 0,
      lastSeen: connection.lastSeen || 0,
      ttl: connection.ttl || 0,
      threat: connection.threat,
    });
    row.dataset.lset = '1';
    row.addEventListener('click', () => showThreatDetail(row));
  }

  appendLogCell(row, srcLabel, { title: connection.src });
  appendLogCell(row, dstLabel, { title: connection.dst });
  row.appendChild(createThreatCell(connection, isLowConfidence));
  appendLogCell(row, connection.dport);
  appendLogCell(row, guessApp(connection.dport, connection.proto, connection.dstHost || connection.dst), {
    className: 'log-app-cell',
  });
  appendLogCell(row, connection.proto);
  appendLogCell(row, `${flag} ${connection.country || ''}`);
  appendLogCell(row, connection.org || '', { className: 'log-org-cell', title: connection.org || '' });
  appendLogCell(row, timeText);
  return row;
}

// ── Render (client-side-only filters applied on top of server data) ───────────
// appendRows: array of new rows to append (null = full re-render)
function renderLogView(appendRows) {
  if (!logMode) return;
  const tbody     = document.getElementById('log-tbody');
  const countEl   = document.getElementById('log-count');

  // Device filter badge + safety guard (only update in full-render mode)
  if (appendRows === null) {
    const deviceFilterEl = document.getElementById('log-device-filter');
    if (selectedIp || selectedMac) {
      if (deviceFilterEl) {
        deviceFilterEl.classList.add('is-visible');
        const label = selectedIp || selectedMac;
        const clearFilter = createTextElement(
          'span',
          tVars('log.deviceFilter.only', { value: label }),
          {
            className: 'log-device-filter-chip',
            id: 'log-device-filter-clear',
            title: t('log.deviceFilter.clear'),
          }
        );
        clearFilter.addEventListener('click', () => {
          clearSelection();
          updateSideHighlight();
          resetAndFetch();
        });
        deviceFilterEl.replaceChildren(clearFilter);
      }
    } else {
      if (deviceFilterEl) deviceFilterEl.classList.remove('is-visible');
    }
  }

  // Build the list of rows to render
  let conns;
  if (appendRows !== null) {
    // Append mode: server-side filters are active, no client-side filtering needed.
    // Safety guard: ensure no stale rows slip through.
    conns = appendRows.filter(c =>
      !selectedMac && !selectedIp ? true :
      (selectedMac && c.srcMac === selectedMac) ||
      (!selectedMac && selectedIp && c.src === selectedIp)
    );
  } else {
    conns = logAllData.slice();

    // Client-side safety guard for device filter
    if (selectedMac || selectedIp) {
      conns = conns.filter(c =>
        (selectedMac && c.srcMac === selectedMac) ||
        (!selectedMac && selectedIp && c.src === selectedIp)
      );
    }

    // Client-side-only column filters (app, threatTag, regex mode)
    for (const [col, filter] of Object.entries(logFilters)) {
      if (!filter) continue;
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
  }

  if (appendRows === null) {
    if (logThreatFilter === 'danger') {
      conns = conns.filter(c => c.threat && c.threat.confidence !== 'low');
    } else if (logThreatFilter === 'warn') {
      conns = conns.filter(c => c.threat && c.threat.confidence === 'low');
    } else if (logThreatFilter === 'safe') {
      conns = conns.filter(c => !c.threat);
    }
  }

  // Count display
  if (logFetchAllMode) {
    countEl.textContent = `${conns.length} / ${logAllData.length} ${t('log.sessions')}`;
  } else {
    countEl.textContent = `${logTotal} ${t('log.sessions')}`;
  }

  // Threat badges are rendered separately by renderThreatBadges() (called from
  // fetchThreatCounts). On the first full render, show loading state until the
  // server-side count arrives.
  if (appendRows === null) renderThreatBadges();

  // Sort icon state (full render only)
  if (appendRows === null) {
    document.querySelectorAll('#log-table th').forEach(th => {
      const icon = th.querySelector('.log-sort-icon');
      if (!icon) return;
      icon.className = 'log-sort-icon' + (th.dataset.col === logSortState.col ? ` ${logSortState.dir}` : '');
    });
  }

  const rows = document.createDocumentFragment();
  conns.forEach(connection => rows.appendChild(createLogRow(connection)));

  if (appendRows !== null) {
    // Append: remove old sentinel (if any), add new rows, observer will re-add sentinel
    document.getElementById('log-scroll-sentinel')?.remove();
    tbody.appendChild(rows);
  } else {
    tbody.replaceChildren(rows);
  }
}

// ── Public entry point: reset to page 0 and re-fetch ─────────────────────────
function resetAndFetch() {
  if (!logMode) return;
  if (logScrollObserver) { logScrollObserver.disconnect(); logScrollObserver = null; }
  document.getElementById('log-scroll-sentinel')?.remove();
  logPage = 0;
  logAllData = [];
  logThreatCounts = null;
  logFetchGeneration++;
  logFetchingPage = false; // cancel any in-flight scroll fetch
  fetchLogPage();          // rows (paginated / full-fetch)
  fetchThreatCounts();     // threat aggregate (runs in parallel)
}

function updateLogView() {
  resetAndFetch();
}

function initLog() {
  if (initLog._done) return;
  initLog._done = true;

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
    resetAndFetch();
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
      textMode.classList.add('is-hidden');
      textInput.classList.add('is-hidden');
      dateRange.classList.add('is-visible');
      const existing = logFilters[col];
      document.getElementById('log-search-from').value = existing?.from || '';
      document.getElementById('log-search-to').value   = existing?.to   || '';
    } else {
      textMode.classList.remove('is-hidden');
      textInput.classList.remove('is-hidden');
      dateRange.classList.remove('is-visible');
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
  resetAndFetch();
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
  resetAndFetch();
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
}

initLog();

export { updateLogView, initLog, resetAndFetch };
