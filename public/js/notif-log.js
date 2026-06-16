// ─── Notification Log View ────────────────────────────────────────────────────
var nlMode = false;
var nlAllRows = [];
var nlSortState = { col: 'detectedAt', dir: 'desc' };
var nlFilters = {}; // col → { mode, value }
var nlActiveFilterCol = null;

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

  const rows = nlFilteredRows();
  countEl.textContent = tVars('notif-log.count', { n: rows.length });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;">${esc(t('notif-log.empty'))}</td></tr>`;
    nlUpdateSortIcons();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => nlShowDetail(row));

    const typeLabel = row.type === 'threat'
      ? `<span style="color:var(--red);font-weight:bold;">${esc(t('notif-log.type.threat'))}</span>`
      : `<span style="color:var(--green);">${esc(t('notif-log.type.new_device'))}</span>`;

    const timeStr = row.detectedAt
      ? new Date(row.detectedAt).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US')
      : '—';

    const srcName = (row.srcMdnsName || row.srcDnsName || row.src || '—').replace(/\.local$/, '');
    const srcVendor = row.srcVendor ? `<br><span style="color:var(--muted);font-size:10px;">${esc(row.srcVendor)}</span>` : '';

    const dstHost = row.dstHost && row.dstHost !== row.dst ? row.dstHost : (row.dst || '—');
    const portStr = row.dport ? `<br><span style="color:var(--muted);font-size:10px;">${esc(String(row.dport))}/${esc(row.proto || '')}</span>` : '';

    const threatCell = row.threatTag
      ? `<span style="color:var(--red);font-size:11px;">${esc(row.threatTag)}</span>`
      : (row.threatSource ? `<span style="color:var(--muted);font-size:11px;">${esc(row.threatSource)}</span>` : '—');

    const slackCell = row.slackSent
      ? `<span style="color:var(--green);">${esc(t('notif-log.slack.sent'))}</span>`
      : t('notif-log.slack.none');

    tr.innerHTML = `
      <td>${typeLabel}</td>
      <td style="white-space:nowrap;font-size:11px;">${esc(timeStr)}</td>
      <td>${esc(srcName)}${srcVendor}</td>
      <td>${esc(dstHost)}${portStr}</td>
      <td>${threatCell}</td>
      <td style="font-size:11px;color:var(--muted);">${esc(row.org || '—')}</td>
      <td style="text-align:center;">${slackCell}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.innerHTML = '';
  tbody.appendChild(frag);
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
      icon.style.color = 'var(--accent)';
    } else {
      icon.textContent = '⇅';
      icon.style.color = '';
    }
  });
  // highlight active filter icons
  table.querySelectorAll('.log-search-icon[data-table="notif"]').forEach(ic => {
    const col = ic.dataset.col;
    ic.style.color = (nlFilters[col] && nlFilters[col].value) ? 'var(--accent)' : '';
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

  function r(label, value) {
    if (!value) return '';
    return `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
  }
  function sec(title) {
    return `<tr><td colspan="2" class="section-title">${esc(title)}</td></tr>`;
  }

  body.innerHTML = `<table>
    ${r(t('notif-log.detail.type'),  row.type === 'threat' ? t('notif-log.type.threat') : t('notif-log.type.new_device'))}
    ${r(t('notif-log.detail.time'),  timeStr)}
    ${r(t('notif-log.detail.slack'), row.slackSent ? t('notif-log.slack.sent') : t('notif-log.slack.none'))}
    ${sec(t('notif-log.detail.sec.src'))}
    ${r('IP',                          row.src)}
    ${r(t('notif-log.detail.srcName'), srcName !== row.src ? srcName : '')}
    ${r(t('notif-log.detail.srcVendor'), row.srcVendor)}
    ${r('MAC',                         row.srcMac)}
    ${row.dst ? `
    ${sec(t('notif-log.detail.sec.dst'))}
    ${r('IP',                          row.dst)}
    ${r(t('notif-log.detail.dstHost'), dstHost !== row.dst ? dstHost : '')}
    ${r(t('notif-log.detail.port'),    row.dport ? `${row.dport} / ${row.proto || ''}` : '')}
    ${r(t('notif-log.detail.country'), row.country)}
    ${r(t('notif-log.detail.city'),    row.city)}
    ${r(t('notif-log.detail.org'),     row.org)}
    ` : ''}
    ${row.threatTag || row.threatSource ? `
    ${sec(t('notif-log.detail.sec.threat'))}
    ${r(t('notif-log.detail.threatSource'), row.threatSource)}
    ${r(t('notif-log.detail.threatTag'),    row.threatTag)}
    ` : ''}
  </table>`;

  overlay.classList.remove('hidden');
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

function nlInitSort() {
  const table = document.getElementById('notif-log-table');
  if (!table) return;
  table.querySelectorAll('th[data-col]').forEach(th => {
    th.style.cursor = 'pointer';
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
    icon.style.cursor = 'pointer';
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

async function loadNotifLog() {
  if (!nlMode) return;
  try {
    const token = localStorage.getItem('widemap_admin_token') || '';
    const res = await fetch(`${BASE_URL}/api/notification-log`, {
      headers: { 'X-Admin-Token': token },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    nlAllRows = data.logs || [];
    nlRender();
  } catch (err) {
    const tbody = document.getElementById('notif-log-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--red);padding:24px;">${esc(String(err))}</td></tr>`;
  }
}

// ─── Init (called once on page load) ─────────────────────────────────────────

function initNotifLog() {
  nlInitSort();
  nlInitFilterPopup();
  document.getElementById('notif-log-refresh-btn')
    ?.addEventListener('click', loadNotifLog);
}

initNotifLog();
