/**
 * Numbers, dates and identifiers as the AI panels show them.
 *
 * Split out of `ai-insights.js` (P2-97): every panel formats, so leaving these
 * in one of them made that one the place you had to open to change any of it.
 */

import { currentLang } from './i18n.js?v=__ASSET_VERSION__';

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost). EgressView
// is often reached over plain HTTP on a LAN IP, so fall back to getRandomValues
// (available everywhere) and finally Math.random, always emitting a valid v4 UUID.
function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatRange(from, to) {
  return `(${formatStamp(from)} - ${formatStamp(to)})`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatUsd(value) {
  const amount = Number(value) || 0;
  const fractionDigits = amount > 0 && amount < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(currentLang === 'en' ? 'en-US' : 'ja-JP', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: currentLang === 'en' ? 'narrowSymbol' : 'code',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

export { randomUuid, pad2, formatStamp, formatRange, formatNumber, formatUsd };
