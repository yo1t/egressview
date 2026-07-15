// ─── Threat Detail Popup ──────────────────────────────────────────────────────
import { t, currentLang } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch, lookupNote } from './auth-socket.js?v=__ASSET_VERSION__';

function threatTextElement(tagName, text, { className = '', id = '' } = {}) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (id) element.id = id;
  element.textContent = text == null ? '' : String(text);
  return element;
}

function appendThreatSection(parent, title, rows) {
  parent.appendChild(threatTextElement('div', title, { className: 'section-title' }));
  const table = document.createElement('table');
  rows.forEach(({ label, value, className = '' }) => {
    const row = document.createElement('tr');
    row.appendChild(threatTextElement('th', label));
    row.appendChild(threatTextElement('td', value, { className }));
    table.appendChild(row);
  });
  parent.appendChild(table);
}

function showThreatDetail(tr) {
  const raw = tr.dataset.threat;
  if (!raw) return;
  let d;
  try { d = JSON.parse(raw); } catch { return; }
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString(currentLang === 'ja' ? 'ja-JP' : 'en-US', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
  const flag = (d.country && d.country.length === 2)
    ? String.fromCodePoint(0x1F1E6 + d.country.charCodeAt(0) - 65, 0x1F1E6 + d.country.charCodeAt(1) - 65) + ' '
    : '';
  const existingNote = lookupNote(d.src, d.srcMac) || '';
  const isLowConfidence = d.threat.confidence === 'low';

  const body = document.getElementById('threat-detail-body');
  const detail = document.createDocumentFragment();
  detail.appendChild(threatTextElement('div', t('threat.detail.title'), { className: 'section-title' }));

  const confidence = document.createElement('div');
  confidence.className = 'threat-confidence-wrap';
  confidence.appendChild(threatTextElement(
    'span',
    t(isLowConfidence ? 'log.badge.warn' : 'log.badge.danger'),
    { className: `${isLowConfidence ? 'log-badge-warn' : 'log-badge-danger'} threat-confidence-badge` }
  ));
  detail.appendChild(confidence);
  detail.appendChild(threatTextElement(
    'div',
    t(isLowConfidence ? 'threat.guidance.low' : 'threat.guidance.high'),
    { className: 'threat-guidance' }
  ));

  const feedRows = [
    { label: t('threat.label.feed'), value: d.threat.source },
    {
      label: t('threat.label.tag'),
      value: isLowConfidence ? t('threat.tag.low').replace('{domain}', d.threat.matchValue) : d.threat.tag,
    },
    {
      label: t('threat.label.confidence'),
      value: `${isLowConfidence ? '⚠️' : '🚨'} ${t(isLowConfidence ? 'threat.confidence.low' : 'threat.confidence.high')}`,
    },
    { label: t('threat.label.matchType'), value: d.threat.matchType },
    { label: t('threat.label.matchValue'), value: d.threat.matchValue },
  ];
  if (d.threat.url) {
    feedRows.push({ label: t('threat.label.url'), value: d.threat.url, className: 'threat-url-value' });
  }
  appendThreatSection(detail, `📋 ${t('threat.section.feed')}`, feedRows);

  appendThreatSection(detail, `📡 ${t('threat.section.conn')}`, [
    { label: t('threat.label.srcIp'), value: d.src },
    { label: t('threat.label.srcName'), value: d.srcLabel || d.src },
    { label: t('threat.label.srcMac'), value: d.srcMac || '—' },
    { label: t('threat.label.srcVendor'), value: d.srcVendor || '—' },
    { label: t('threat.label.dstIp'), value: d.dst },
    { label: t('threat.label.dstHost'), value: d.dstHost || d.dst },
    { label: t('threat.label.dstPort'), value: `${d.dport} / ${d.proto || ''}` },
    { label: 'TTL', value: d.ttl || '—' },
  ]);

  appendThreatSection(detail, `🌍 ${t('threat.section.geo')}`, [
    { label: t('threat.label.country'), value: `${flag}${d.country || '—'}` },
    { label: t('threat.label.city'), value: d.city || '—' },
    { label: t('threat.label.org'), value: d.org || '—' },
  ]);

  appendThreatSection(detail, `⏱ ${t('threat.section.time')}`, [
    { label: t('threat.label.firstSeen'), value: fmtTime(d.firstSeen) },
    { label: t('threat.label.lastSeen'), value: fmtTime(d.lastSeen) },
  ]);

  detail.appendChild(threatTextElement('div', `📝 ${t('threat.section.note')}`, { className: 'section-title' }));
  const noteWrap = document.createElement('div');
  noteWrap.className = 'threat-note-wrap';
  const note = document.createElement('textarea');
  note.id = 'threat-detail-note';
  note.className = 'threat-detail-note';
  note.placeholder = t('note.placeholder');
  note.value = existingNote;
  noteWrap.appendChild(note);
  detail.appendChild(noteWrap);

  const actions = document.createElement('div');
  actions.className = 'threat-detail-actions';
  const investigateButton = threatTextElement('button', t('note.investigate'), {
    className: 'connect-btn threat-detail-action',
    id: 'threat-detail-investigate-btn',
  });
  const saveButton = threatTextElement('button', t('note.save'), {
    className: 'connect-btn threat-detail-action',
    id: 'threat-detail-save-btn',
  });
  actions.append(investigateButton, saveButton);
  detail.appendChild(actions);
  detail.appendChild(threatTextElement('div', '', {
    className: 'threat-detail-status',
    id: 'threat-detail-status',
  }));

  body.replaceChildren(detail);
  document.getElementById('threat-detail-investigate-btn').addEventListener('click', () => threatDetailInvestigate(d.src));
  document.getElementById('threat-detail-save-btn').addEventListener('click', () => threatDetailSaveNote(d.src, d.srcMac || ''));
  document.getElementById('threat-detail-overlay').classList.remove('hidden');
}

async function threatDetailInvestigate(ip) {
  const statusEl = document.getElementById('threat-detail-status');
  statusEl.textContent = t('note.investigating');
  try {
    const r = await apiFetch(_BASE+'/api/notes/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip }),
    });
    const data = await r.json();
    const ta = document.getElementById('threat-detail-note');
    const sep = ta.value ? '\n---\n' : '';
    ta.value = ta.value + sep + (data.draft || '(no info)');
    statusEl.textContent = t('note.investigate.done');
  } catch (e) {
    statusEl.textContent = t('note.investigate.fail') + ': ' + e.message;
  }
}

async function threatDetailSaveNote(ip, mac) {
  const ta = document.getElementById('threat-detail-note');
  const statusEl = document.getElementById('threat-detail-status');
  try {
    await apiFetch(_BASE+'/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, mac: mac || undefined, note: ta.value }),
    });
    statusEl.textContent = t('settings.status.saved');
  } catch (e) {
    statusEl.textContent = t('settings.status.saveFailed') + ': ' + e.message;
  }
}

{
  const overlay = document.getElementById('threat-detail-overlay');
  overlay?.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  document.getElementById('threat-detail-close')?.addEventListener('click', () => overlay?.classList.add('hidden'));
}

export { showThreatDetail };
