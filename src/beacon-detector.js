// Beacon detection: identify C2 heartbeat / periodic connection patterns
//
// Strategy: group connection_events by (src, dst, dport, proto), compute
// inter-arrival gaps, and flag groups whose median gap is in a plausible
// beacon range and whose coefficient-of-variation is below a threshold.
//
// Works with two event sources:
//   'inspect' — Yamaha [INSPECT] syslog, fires on TCP session close (precise)
//   'poll'    — Yamaha NAT table poll, fires when a session appears after
//               being absent in the previous poll (±60 s precision)
'use strict';

// Skip LAN-to-LAN traffic; beacons call *out* to the internet.
const PRIVATE_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.)/;

const DEFAULTS = {
  minObs:           4,            // minimum observations per group
  maxCov:           0.5,          // max coefficient of variation (0 = perfectly regular)
  minIntervalMs:    60_000,       // 1 minute  — faster is just normal traffic
  maxIntervalMs:    4 * 3600_000, // 4 hours   — slower is too sparse to flag
  whitelistDomains: [],           // dstHost suffixes to skip (known-benign vendor telemetry)
};

/**
 * True if `host` equals one of the whitelist domains or is a subdomain of one.
 * Matching is case-insensitive; null/empty hosts never match.
 */
function isWhitelistedHost(host, whitelistDomains) {
  if (!host || !whitelistDomains || !whitelistDomains.length) return false;
  const h = String(host).toLowerCase();
  return whitelistDomains.some(d => h === d || h.endsWith('.' + d));
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Median of a pre-sorted numeric array. */
function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Coefficient of variation (stddev / mean).  Returns 0 for single-element arrays. */
function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Analyse a flat list of connection events and return beacon candidates.
 *
 * @param {Array<{src:string, dst:string, dstHost?:string, dport:number,
 *                proto:string, seenAt:number}>} events
 * @param {object} [opts]   Override any DEFAULTS key.
 * @returns {Array<BeaconCandidate>}  Sorted by intervalCov ASC (most regular first).
 */
function detectBeacons(events, opts = {}) {
  const { minObs, maxCov, minIntervalMs, maxIntervalMs, whitelistDomains } = { ...DEFAULTS, ...opts };
  const wl = (whitelistDomains || []).map(d => String(d).toLowerCase());

  // Group events by connection key
  const groups = new Map();
  for (const e of events) {
    if (PRIVATE_RE.test(e.dst)) continue;
    if (isWhitelistedHost(e.dstHost, wl)) continue;  // known-benign vendor telemetry
    const key = `${e.src}|${e.dst}|${e.dport}|${e.proto}`;
    if (!groups.has(key)) groups.set(key, { meta: e, times: [] });
    groups.get(key).times.push(e.seenAt);
  }

  const candidates = [];

  for (const { meta, times } of groups.values()) {
    if (times.length < minObs) continue;

    times.sort((a, b) => a - b);

    // Deduplicate timestamps that are identical (e.g. two events in same poll)
    const unique = [...new Set(times)];
    if (unique.length < minObs) continue;

    const gaps = [];
    for (let i = 1; i < unique.length; i++) gaps.push(unique[i] - unique[i - 1]);

    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const med = median(sortedGaps);

    if (med < minIntervalMs || med > maxIntervalMs) continue;

    const cv = coefficientOfVariation(gaps);
    if (cv > maxCov) continue;

    // Span check: observations must cover a meaningful time window
    // (guards against a burst of connections that happen to be evenly spaced)
    const span = unique[unique.length - 1] - unique[0];
    if (span < med * (minObs - 1) * 0.5) continue;

    candidates.push({
      src:         meta.src,
      dst:         meta.dst,
      dstHost:     meta.dstHost || null,
      dport:       meta.dport,
      proto:       meta.proto,
      intervalMs:  Math.round(med),
      intervalCov: Math.round(cv * 1000) / 1000,
      obsCount:    unique.length,
      firstSeen:   unique[0],
      lastSeen:    unique[unique.length - 1],
    });
  }

  return candidates.sort((a, b) => a.intervalCov - b.intervalCov);
}

module.exports = { detectBeacons, isWhitelistedHost, DEFAULTS, _median: median, _cov: coefficientOfVariation };
