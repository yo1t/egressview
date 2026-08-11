// ─── Notification Log View ────────────────────────────────────────────────────
import { t, tVars, currentLang } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { selectedMac, selectedIp, updateSideHighlight, clearSelection } from './graph.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { appendDisplayScope } from './display-scope.js?v=__ASSET_VERSION__';
import { nlMode } from './view-tabs.js?v=__ASSET_VERSION__';

var nlAllRows = [];
var nlSortState = { col: 'detectedAt', dir: 'desc' };
var nlFilters = {}; // col → { mode, value }
var nlActiveFilterCol = null;

function nlTextElement(tagName, text, { className = '', id = '' } = {}) {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (id) el.id = id;
  el.textContent = text == null ? '' : String(text);
  return el;
}

function nlAppendCell(row, text, className = '') {
  const cell = nlTextElement('td', text, { className });
  row.appendChild(cell);
  return cell;
}

function nlMessageRow(message, className) {
  const row = document.createElement('tr');
  const cell = nlAppendCell(row, message, className);
  cell.colSpan = 7;
  return row;
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function nlCellValue(row, col) {
  switch (col) {
    case 'type':       return row.type || '';
    case 'detectedAt': return String(row.detectedAt || 0);
    case 'src': {
      const name = row.srcMdnsName || row.srcDnsName || row.src || '';
      return name.replace(/\.local$/, '');
    }
    case 'dst':       return row.dstHost && row.dstHost !== row.dst ? row.dstHost : (row.dst || '');
    case 'threatTag': return row.threatTag || '';
    case 'org':       return row.org || '';
    case 'slackSent': return row.slackSent ? '1' : '0';
    default: return '';
  }
}

function nlMatchFilter(value, filter) {
  if (!filter || !filter.value) return true;
  const v = value.toLowerCase();
  const f = filter.value.toLowerCase();
  switch (filter.mode) {
    case 'contains':   return v.includes(f);
    case 'startsWith': return v.startsWith(f);
    case 'endsWith':   return v.endsWith(f);
    case 'regex':
      try { return new RegExp(filter.value, 'i').test(value); } catch { return true; }
    default: return true;
  }
}

function nlFilteredRows() {
  let rows = nlAllRows;
  // Node selection filter (mirrors log.js device filter logic)
  if (selectedMac || selectedIp) {
    rows = rows.filter(r =>
      (selectedMac && r.srcMac === selectedMac) ||
      (selectedIp  && r.src   === selectedIp)
    );
  }
  for (const [col, filter] of Object.entries(nlFilters)) {
    if (!filter || !filter.value) continue;
    rows = rows.filter(r => nlMatchFilter(nlCellValue(r, col), filter));
  }
  const { col, dir } = nlSortState;
  rows = [...rows].sort((a, b) => {
    const av = nlCellValue(a, col);
    const bv = nlCellValue(b, col);
    const cmp = col === 'detectedAt' || col === 'slackSent'
      ? Number(av) - Number(bv)
      : av.localeCompare(bv, undefined, { sensitivity: 'base' });
    return dir === 'asc' ? cmp : -cmp;
  });
  return rows;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function nlRender() {
  if (!nlMode) return;
  const tbody  = document.getElementById('notif-log-tbody');
  const countEl = document.getElementById('notif-log-count');
  if (!tbody) return;

  // Node filter badge
  const filterBadge = document.getElementById('notif-log-device-filter');
  if (filterBadge) {
    if (selectedMac || selectedIp) {
      const label = selectedIp || selectedMac;
      filterBadge.classList.add('is-visible');
      const clearFilter = nlTextElement('span', tVars('log.deviceFilter.only', { value: label }), {
        className: 'log-device-filter-chip',
        id: 'nl-device-filter-clear',
      });
      clearFilter.title = t('log.deviceFilter.clear');
      clearFilter.addEventListener('click', () => {
        clearSelection();
        updateSideHighlight();
        nlRender();
      });
      filterBadge.replaceChildren(clearFilter);
    } else {
      filterBadge.classList.remove('is-visible');
    }
  }

  const rows = nlFilteredRows();
  countEl.textContent = tVars('notif-log.count', { n: rows.length });

  if (rows.length === 0) {
    tbody.replaceChildren(nlMessageRow(t('notif-log.empty'), 'notif-log-empty-cell'));
    nlUpdateSortIcons();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'notif-log-clickable-row';
    tr.addEventListener('click', () => nlShowDetail(row));

    const typeCell = document.createElement('td');
    typeCell.appendChild(nlTextElement(
      'span',
      row.type === 'threat' ? t('notif-log.type.threat') : t('notif-log.type.new_device'),
      { className: row.type === 'threat' ? 'notif-log-type-threat' : 'notif-log-type-device' }
    ));
    tr.appendChild(typeCell);

    const timeStr = row.detectedAt
      ? new Date(row.detectedAt).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US')
      : '—';

    const srcName = (row.srcMdnsName || row.srcDnsName || row.src || '—').replace(/\.local$/, '');

    const dstHost = row.dstHost && row.dstHost !== row.dst ? row.dstHost : (row.dst || '—');

    nlAppendCell(tr, timeStr, 'notif-log-time-cell');
    const srcCell = nlAppendCell(tr, srcName);
    if (row.srcVendor) {
      srcCell.appendChild(document.createElement('br'));
      srcCell.appendChild(nlTextElement('span', row.srcVendor, { className: 'notif-log-subtext' }));
    }
    const dstCell = nlAppendCell(tr, dstHost);
    if (row.dport) {
      dstCell.appendChild(document.createElement('br'));
      dstCell.appendChild(nlTextElement('span', `${row.dport}/${row.proto || ''}`, { className: 'notif-log-subtext' }));
    }
    const threatText = row.threatTag || row.threatSource || '—';
    nlAppendCell(tr, threatText, row.threatTag ? 'notif-log-threat-text' : 'notif-log-subtle-text');
    nlAppendCell(tr, row.org || '—', 'notif-log-org-cell');
    nlAppendCell(
      tr,
      row.slackSent ? t('notif-log.slack.sent') : t('notif-log.slack.none'),
      row.slackSent ? 'notif-log-slack-sent' : 'notif-log-slack-cell'
    );
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
  nlUpdateSortIcons();
}

function nlUpdateSortIcons() {
  const table = document.getElementById('notif-log-table');
  if (!table) return;
  table.querySelectorAll('th[data-col]').forEach(th => {
    const icon = th.querySelector('.log-sort-icon');
    if (!icon) return;
    if (th.dataset.col === nlSortState.col) {
      icon.textContent = nlSortState.dir === 'asc' ? '↑' : '↓';
      icon.classList.add('active');
    } else {
      icon.textContent = '⇅';
      icon.classList.remove('active');
    }
  });
  // highlight active filter icons
  table.querySelectorAll('.log-search-icon[data-table="notif"]').forEach(ic => {
    const col = ic.dataset.col;
    ic.classList.toggle('active', Boolean(nlFilters[col]?.value));
  });
}

// ─── Detail popup ─────────────────────────────────────────────────────────────

function nlShowDetail(row) {
  const overlay = document.getElementById('notif-log-detail-overlay');
  const body    = document.getElementById('notif-log-detail-body');
  if (!overlay || !body) return;

  const timeStr = row.detectedAt
    ? new Date(row.detectedAt).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US')
    : '—';
  const srcName = (row.srcMdnsName || row.srcDnsName || row.src || '—').replace(/\.local$/, '');
  const dstHost = row.dstHost && row.dstHost !== row.dst ? row.dstHost : (row.dst || '—');

  function appendDetailRow(table, label, value) {
    if (!value) return;
    const detailRow = document.createElement('tr');
    detailRow.appendChild(nlTextElement('th', label));
    detailRow.appendChild(nlTextElement('td', value));
    table.appendChild(detailRow);
  }
  function appendDetailSection(table, title) {
    const sectionRow = document.createElement('tr');
    const sectionCell = nlTextElement('td', title, { className: 'section-title' });
    sectionCell.colSpan = 2;
    sectionRow.appendChild(sectionCell);
    table.appendChild(sectionRow);
  }

  const table = document.createElement('table');
  appendDetailRow(table, t('notif-log.detail.type'), row.type === 'threat' ? t('notif-log.type.threat') : t('notif-log.type.new_device'));
  appendDetailRow(table, t('notif-log.detail.time'), timeStr);
  appendDetailRow(table, t('notif-log.detail.slack'), row.slackSent ? t('notif-log.slack.sent') : t('notif-log.slack.none'));
  appendDetailSection(table, t('notif-log.detail.sec.src'));
  appendDetailRow(table, 'IP', row.src);
  appendDetailRow(table, t('notif-log.detail.srcName'), srcName !== row.src ? srcName : '');
  appendDetailRow(table, t('notif-log.detail.srcVendor'), row.srcVendor);
  appendDetailRow(table, 'MAC', row.srcMac);
  if (row.dst) {
    appendDetailSection(table, t('notif-log.detail.sec.dst'));
    appendDetailRow(table, 'IP', row.dst);
    appendDetailRow(table, t('notif-log.detail.dstHost'), dstHost !== row.dst ? dstHost : '');
    appendDetailRow(table, t('notif-log.detail.port'), row.dport ? `${row.dport} / ${row.proto || ''}` : '');
    appendDetailRow(table, t('notif-log.detail.country'), row.country);
    appendDetailRow(table, t('notif-log.detail.city'), row.city);
    appendDetailRow(table, t('notif-log.detail.org'), row.org);
  }
  if (row.threatTag || row.threatSource) {
    appendDetailSection(table, t('notif-log.detail.sec.threat'));
    appendDetailRow(table, t('notif-log.detail.threatSource'), row.threatSource);
    appendDetailRow(table, t('notif-log.detail.threatTag'), row.threatTag);
  }
  body.replaceChildren(table);

  overlay.classList.remove('hidden');
}

function nlCloseDetail() {
  document.getElementById('notif-log-detail-overlay')?.classList.add('hidden');
}

function nlInitDetailPopup() {
  const overlay = document.getElementById('notif-log-detail-overlay');
  const closeBtn = document.getElementById('notif-log-detail-close');
  if (!overlay) return;

  closeBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    nlCloseDetail();
  });

  overlay.addEventListener('click', e => {
    if (e.target === overlay) nlCloseDetail();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') nlCloseDetail();
  });
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

function nlInitSort() {
  const table = document.getElementById('notif-log-table');
  if (!table) return;
  table.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', e => {
      if (e.target.classList.contains('log-search-icon')) return;
      const col = th.dataset.col;
      if (nlSortState.col === col) {
        nlSortState.dir = nlSortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        nlSortState.col = col;
        nlSortState.dir = col === 'detectedAt' ? 'desc' : 'asc';
      }
      nlRender();
    });
  });
}

// ─── Filter popup ─────────────────────────────────────────────────────────────

function nlInitFilterPopup() {
  const table   = document.getElementById('notif-log-table');
  const popup   = document.getElementById('notif-log-search-popup');
  const modeEl  = document.getElementById('notif-log-search-mode');
  const inputEl = document.getElementById('notif-log-search-input');
  if (!table || !popup) return;

  table.querySelectorAll('.log-search-icon[data-table="notif"]').forEach(icon => {
    icon.addEventListener('click', e => {
      e.stopPropagation();
      const col = icon.dataset.col;
      nlActiveFilterCol = col;
      const existing = nlFilters[col];
      modeEl.value  = existing?.mode  || 'contains';
      inputEl.value = existing?.value || '';
      // position near icon
      const rect = icon.getBoundingClientRect();
      popup.style.top  = (rect.bottom + 4 + window.scrollY) + 'px';
      popup.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
      popup.classList.remove('hidden');
      inputEl.focus();
    });
  });

  function applyFilter() {
    if (!nlActiveFilterCol) return;
    const val = inputEl.value.trim();
    if (val) {
      nlFilters[nlActiveFilterCol] = { mode: modeEl.value, value: val };
    } else {
      delete nlFilters[nlActiveFilterCol];
    }
    nlRender();
    popup.classList.add('hidden');
  }

  document.getElementById('notif-log-search-apply').addEventListener('click', applyFilter);
  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') applyFilter(); });

  document.getElementById('notif-log-search-clear').addEventListener('click', () => {
    if (nlActiveFilterCol) delete nlFilters[nlActiveFilterCol];
    inputEl.value = '';
    nlRender();
    popup.classList.add('hidden');
  });

  document.getElementById('notif-log-search-close').addEventListener('click', () => {
    popup.classList.add('hidden');
  });

  document.addEventListener('click', e => {
    if (!popup.classList.contains('hidden') &&
        !popup.contains(e.target) &&
        !e.target.classList.contains('log-search-icon')) {
      popup.classList.add('hidden');
    }
  });
}

// ─── Load from API ────────────────────────────────────────────────────────────

function nlSetLoading(loading) {
  const el = document.getElementById('data-fetching-notif');
  if (el) el.classList.toggle('is-visible', loading);
}

async function loadNotifLog() {
  if (!nlMode) return;
  nlSetLoading(true);
  try {
    const params = appendDisplayScope(new URLSearchParams());
    const res = await apiFetch(`${_BASE}/api/notification-log${params.size ? `?${params}` : ''}`);
    if (!res.ok) {
      const msg = res.status === 502 || res.status === 503
        ? t('err.serverUnavailable')
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    const data = await res.json();
    nlAllRows = data.logs || [];
    nlRender();
  } catch (err) {
    const tbody = document.getElementById('notif-log-tbody');
    if (tbody) tbody.replaceChildren(nlMessageRow(String(err), 'notif-log-error-cell'));
  } finally {
    nlSetLoading(false);
  }
}

// ─── Init (called once on page load) ─────────────────────────────────────────

function initNotifLog() {
  if (initNotifLog._done) return;
  initNotifLog._done = true;
  nlInitSort();
  nlInitFilterPopup();
  nlInitDetailPopup();
  document.getElementById('notif-log-refresh-btn')
    ?.addEventListener('click', loadNotifLog);
}

initNotifLog();

export { loadNotifLog, initNotifLog, nlRender };
