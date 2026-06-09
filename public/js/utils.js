// ─── Utilities ────────────────────────────────────────────────────────────────

const _BASE = window.BASE_URL || '';

// HTML escape (XSS mitigation: ASUS/Yamaha/DNS/RDAP-derived strings are untrusted)
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmtBytes(bps) {
  if (!bps || isNaN(bps)) return '0 B/s';
  const u = ['B/s','KB/s','MB/s','GB/s'];
  let i = 0;
  while (bps >= 1024 && i < u.length - 1) { bps /= 1024; i++; }
  return `${bps.toFixed(bps < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 5);
}
function nodeColor(type) {
  if (type === '0') return '#ef4444';   // Wired: red
  if (type === '1') return '#10b981';   // 2.4GHz: green
  if (type === '2') return '#8b5cf6';   // 5GHz: purple
  if (type === '3') return '#eab308';   // 6GHz: yellow
  return '#6b7280';
}
function nodeClass(type) {
  if (type === '0') return 'wired';
  if (type === '1') return 'wifi-2g';
  if (type === '2') return 'wifi-5g';
  if (type === '3') return 'wifi-6g';
  return 'wired';
}
function typeLabel(type) {
  if (type === '0') return t('type.wired');
  if (type === '1') return t('type.wifi24');
  if (type === '2') return t('type.wifi5');
  if (type === '3') return t('type.wifi6');
  return t('type.unknown');
}
function isWiredType(type) { return type === '0'; }
