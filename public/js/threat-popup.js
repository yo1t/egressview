// ─── Threat Detail Popup ──────────────────────────────────────────────────────
import { t } from './i18n.js';
import { _BASE, esc } from './utils.js';
import { apiFetch, lookupNote } from './auth-socket.js';
import { currentLang } from './i18n.js';

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

  const body = document.getElementById('threat-detail-body');
  body.innerHTML = `
    <div class="section-title">${t('threat.detail.title')}</div>
    <div style="margin:8px 0;">
      ${d.threat.confidence === 'low'
        ? '<span class="log-badge-warn" style="font-size:11px;padding:3px 8px;">' + esc(t('log.badge.warn')) + '</span>'
        : '<span class="log-badge-danger" style="font-size:11px;padding:3px 8px;">' + esc(t('log.badge.danger')) + '</span>'}
    </div>
    <div style="font-size:11px;line-height:1.6;color:var(--text);white-space:pre-wrap;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:12px;">${esc(d.threat.confidence === 'low' ? t('threat.guidance.low') : t('threat.guidance.high'))}</div>
    <div class="section-title">📋 ${t('threat.section.feed')}</div>
    <table>
      <tr><th>${t('threat.label.feed')}</th><td>${esc(d.threat.source)}</td></tr>
      <tr><th>${t('threat.label.tag')}</th><td>${esc(d.threat.confidence === 'low' ? t('threat.tag.low').replace('{domain}', d.threat.matchValue) : d.threat.tag)}</td></tr>
      <tr><th>${t('threat.label.confidence')}</th><td>${d.threat.confidence === 'low' ? '⚠️ ' + t('threat.confidence.low') : '🚨 ' + t('threat.confidence.high')}</td></tr>
      <tr><th>${t('threat.label.matchType')}</th><td>${esc(d.threat.matchType)}</td></tr>
      <tr><th>${t('threat.label.matchValue')}</th><td>${esc(d.threat.matchValue)}</td></tr>
      ${d.threat.url ? `<tr><th>${t('threat.label.url')}</th><td style="word-break:break-all;font-size:10px;">${esc(d.threat.url)}</td></tr>` : ''}
    </table>
    <div class="section-title">📡 ${t('threat.section.conn')}</div>
    <table>
      <tr><th>${t('threat.label.srcIp')}</th><td>${esc(d.src)}</td></tr>
      <tr><th>${t('threat.label.srcName')}</th><td>${esc(d.srcLabel || d.src)}</td></tr>
      <tr><th>${t('threat.label.srcMac')}</th><td>${esc(d.srcMac || '—')}</td></tr>
      <tr><th>${t('threat.label.srcVendor')}</th><td>${esc(d.srcVendor || '—')}</td></tr>
      <tr><th>${t('threat.label.dstIp')}</th><td>${esc(d.dst)}</td></tr>
      <tr><th>${t('threat.label.dstHost')}</th><td>${esc(d.dstHost || d.dst)}</td></tr>
      <tr><th>${t('threat.label.dstPort')}</th><td>${d.dport} / ${esc(d.proto)}</td></tr>
      <tr><th>TTL</th><td>${d.ttl || '—'}</td></tr>
    </table>
    <div class="section-title">🌍 ${t('threat.section.geo')}</div>
    <table>
      <tr><th>${t('threat.label.country')}</th><td>${flag}${esc(d.country || '—')}</td></tr>
      <tr><th>${t('threat.label.city')}</th><td>${esc(d.city || '—')}</td></tr>
      <tr><th>${t('threat.label.org')}</th><td>${esc(d.org || '—')}</td></tr>
    </table>
    <div class="section-title">⏱ ${t('threat.section.time')}</div>
    <table>
      <tr><th>${t('threat.label.firstSeen')}</th><td>${fmtTime(d.firstSeen)}</td></tr>
      <tr><th>${t('threat.label.lastSeen')}</th><td>${fmtTime(d.lastSeen)}</td></tr>
    </table>
    <div class="section-title">📝 ${t('threat.section.note')}</div>
    <div style="margin-bottom:8px;">
      <textarea id="threat-detail-note" style="width:100%;min-height:60px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:inherit;font-size:11px;padding:8px;resize:vertical;" placeholder="${esc(t('note.placeholder'))}">${esc(existingNote)}</textarea>
    </div>
    <div style="display:flex;gap:6px;">
      <button id="threat-detail-investigate-btn" class="connect-btn" style="flex:1;font-size:11px;padding:5px 10px;">${t('note.investigate')}</button>
      <button id="threat-detail-save-btn" class="connect-btn" style="flex:1;font-size:11px;padding:5px 10px;">${t('note.save')}</button>
    </div>
    <div id="threat-detail-status" style="font-size:10px;color:var(--muted);margin-top:6px;"></div>
  `;
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
