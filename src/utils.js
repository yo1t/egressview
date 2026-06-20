// Shared utility functions
'use strict';

// ── SSRF protection: allow only private IP ranges ─────────────────────
function isAllowedRouterIp(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a > 255 || b > 255 || parseInt(m[3], 10) > 255 || parseInt(m[4], 10) > 255) return false;
  // Explicitly reject 169.254.0.0/16 (link-local, AWS metadata, etc.)
  if (a === 169 && b === 254) return false;
  // Reject 127.0.0.0/8 (loopback) to prevent attacks on this server
  if (a === 127) return false;
  // Allow only 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ── HTML escape (used for template replacement) ──
function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ── Query param parsers ────────────────────────────────────────────────

/**
 * Parse a Unix epoch millisecond timestamp from a query param string.
 * Returns the integer value, or null if the value is absent or not a
 * finite integer (guards against parseInt('abc') → NaN being silently
 * passed into SQLite queries).
 *
 * @param {string|undefined|null} val  - raw value from req.query
 * @returns {number|null}
 */
function parseTimestamp(val) {
  if (val == null || val === '') return null;
  // Reject anything that isn't a plain integer string (no trailing garbage,
  // no decimal point).  parseInt('123abc') would silently return 123, which
  // could let malformed query params slip through.
  if (!/^\d+$/.test(String(val))) return null;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Parse a positive integer from a request body value.
 * Accepts numbers and numeric strings.
 * Returns the integer value, or null if the value is absent, not a
 * number, not finite, or not ≥ 1.
 *
 * @param {*} val
 * @returns {number|null}
 */
function parsePositiveInt(val) {
  if (val == null) return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) return null;
  return n;
}

module.exports = { isAllowedRouterIp, htmlEscape, parseTimestamp, parsePositiveInt };
