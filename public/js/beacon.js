// ─── Beacon detection UI ──────────────────────────────────────────────────────
import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { allConnections } from './connections-panel.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

var beaconData    = [];   // current candidates from API
var beaconListOpen = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBeaconInterval(ms) {
  if (ms < 60_000)    return tVars('beacon.interval.sec', { count: Math.round(ms / 1000) });
  if (ms < 3600_000)  return tVars('beacon.interval.min', { count: Math.round(ms / 60_000) });
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return m > 0
    ? tVars('beacon.interval.hourMin', { hours: h, minutes: m })
    : tVars('beacon.interval.hour', { count: h });
}

function beaconSrcLabel(srcIp) {
  // Try to resolve a friendly name from allConnections
  if (typeof allConnections !== 'undefined') {
    const hit = allConnections.find(c => c.src === srcIp);
    if (hit) {
      const mdns = hit.srcMdnsName ? hit.srcMdnsName.replace(/\.local$/, '') : null;
      const dns  = hit.srcDnsName  ? hit.srcDnsName.split('.')[0]            : null;
      const name = mdns || dns || null;
      if (name) return `${name} (${srcIp})`;
    }
  }
  return srcIp;
}

function beaconCovClass(cov) {
  if (cov < 0.1) return 'beacon-cov-low';
  if (cov < 0.3) return 'beacon-cov-mid';
  return 'beacon-cov-high';
}

function beaconTextElement(tagName, text, { className = '', title = '' } = {}) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (title) element.title = title;
  element.textContent = text == null ? '' : String(text);
  return element;
}

function appendBeaconCell(row, content, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  if (typeof content === 'string' || typeof content === 'number') cell.textContent = String(content);
  else if (content) cell.appendChild(content);
  row.appendChild(cell);
  return cell;
}

function createBeaconRow(beacon) {
  const row = document.createElement('tr');
  appendBeaconCell(row, beaconSrcLabel(beacon.src));

  const destination = document.createElement('span');
  destination.appendChild(document.createTextNode(
    (beacon.dstHost && beacon.dstHost !== beacon.dst ? beacon.dstHost : beacon.dst) ?? ''
  ));
  if (beacon.dstHost && beacon.dstHost !== beacon.dst) {
    destination.appendChild(document.createElement('br'));
    destination.appendChild(beaconTextElement('span', beacon.dst, { className: 'beacon-destination-ip' }));
  }
  appendBeaconCell(row, destination);
  appendBeaconCell(row, fmtBeaconInterval(beacon.intervalMs), 'beacon-nowrap');
  appendBeaconCell(row, beaconTextElement('span', `${Math.round(beacon.intervalCov * 100)}%`, {
    className: beaconCovClass(beacon.intervalCov),
  }));
  appendBeaconCell(row, beacon.obsCount, 'beacon-muted');

  const timeCell = appendBeaconCell(row, fmtTs(beacon.firstSeen), 'beacon-time-cell');
  timeCell.appendChild(document.createElement('br'));
  timeCell.appendChild(document.createTextNode(fmtTs(beacon.lastSeen)));

  const dismissButton = beaconTextElement('button', t('beacon.dismiss'), { className: 'beacon-dismiss-btn' });
  dismissButton.dataset.id = String(beacon.id);
  dismissButton.addEventListener('click', () => dismissBeacon(Number(dismissButton.dataset.id)));
  appendBeaconCell(row, dismissButton);
  return row;
}

// ── API ───────────────────────────────────────────────────────────────────────

async function loadBeacons() {
  try {
    const res  = await apiFetch(`${_BASE}/api/beacons`);
    const data = await res.json();
    beaconData = (data.beacons || []).filter(b => b.status !== 'dismissed');
  } catch (e) {
    beaconData = [];
  }
  renderBeaconBanner();
}

async function dismissBeacon(id) {
  try {
    await apiFetch(`${_BASE}/api/beacons/${id}/dismiss`, { method: 'POST' });
    beaconData = beaconData.filter(b => b.id !== id);
    renderBeaconBanner();
  } catch (e) {
    // ignore
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderBeaconBanner() {
  const banner  = document.getElementById('beacon-banner');
  const label   = document.getElementById('beacon-banner-label');
  const chevron = document.getElementById('beacon-banner-chevron');
  const list    = document.getElementById('beacon-list');
  if (!banner) return;

  if (beaconData.length === 0) {
    banner.classList.remove('is-visible');
    beaconListOpen = false;
    return;
  }

  banner.classList.add('is-visible');
  label.textContent = tVars('beacon.banner', { count: beaconData.length });
  chevron.classList.toggle('open', beaconListOpen);
  list.classList.toggle('is-visible', beaconListOpen);
  if (beaconListOpen) renderBeaconList(list);
}

function renderBeaconList(container) {
  const table = document.createElement('table');
  table.className = 'beacon-table';
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  [
    ['beacon.col.src', ''],
    ['beacon.col.dst', ''],
    ['beacon.col.interval', ''],
    ['beacon.col.regularity', t('beacon.col.regularityTitle')],
    ['beacon.col.obs', ''],
    ['beacon.col.firstLast', ''],
    ['', ''],
  ].forEach(([key, title]) => {
    headerRow.appendChild(beaconTextElement('th', key ? t(key) : '', { title }));
  });
  head.appendChild(headerRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  beaconData.forEach(beacon => body.appendChild(createBeaconRow(beacon)));
  table.appendChild(body);
  container.replaceChildren(table);
}

// ── Toggle ────────────────────────────────────────────────────────────────────

document.getElementById('beacon-banner-bar').addEventListener('click', () => {
  beaconListOpen = !beaconListOpen;
  renderBeaconBanner();
});

export { loadBeacons, renderBeaconBanner };
