// Rate limiting and concurrency control for the remote MCP endpoint
// (P2-60 PR 4).
//
// Three independent buckets, all of which must allow a request:
//   - global      protects the host from any single burst
//   - per-subject stops one compromised user consuming the whole budget
//   - per-client  stops one misbehaving client doing the same
//
// A separate concurrency cap bounds in-flight work, because slow tool calls
// can exhaust the process long before a request-per-minute limit trips.
//
// This is the Node-side half of the limit. The reverse proxy keeps its own,
// so a bug or restart here cannot leave the endpoint unbounded.
'use strict';

// Deliberately tight. There is no measured usage to size these from yet, and
// loosening after a false positive is cheap and safe; discovering a limit was
// too loose only happens after abuse. An agent bursting a dozen calls during
// one investigation fits comfortably; sustained multi-per-second traffic does
// not, and is either a flood or a runaway loop.
const DEFAULTS = Object.freeze({
  globalPerMinute: 60,
  perSubjectPerMinute: 30,
  perClientPerMinute: 30,
  maxConcurrent: 4,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});

/** Fixed-window counter. Simple, and its reset behaviour is easy to reason about. */
function createWindowCounter(windowMs) {
  const windows = new Map();

  function hit(key, limit, now) {
    const slot = Math.floor(now / windowMs);
    const entry = windows.get(key);
    if (!entry || entry.slot !== slot) {
      windows.set(key, { slot, count: 1 });
      return { allowed: true, remaining: Math.max(limit - 1, 0), resetMs: (slot + 1) * windowMs - now };
    }
    entry.count += 1;
    const allowed = entry.count <= limit;
    return {
      allowed,
      remaining: Math.max(limit - entry.count, 0),
      resetMs: (slot + 1) * windowMs - now,
    };
  }

  function sweep(now, maxTrackedKeys) {
    const slot = Math.floor(now / windowMs);
    for (const [key, entry] of windows) {
      if (entry.slot < slot) windows.delete(key);
    }
    // Bound memory even under a flood of distinct keys: an attacker must not
    // be able to grow this map without limit.
    if (windows.size > maxTrackedKeys) windows.clear();
  }

  return { hit, sweep, size: () => windows.size };
}

function createMcpRateLimiter(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const counter = createWindowCounter(config.windowMs);
  let inFlight = 0;

  /**
   * Decide whether a request may proceed.
   * @returns {{allowed: boolean, reason?: string, retryAfterSeconds?: number}}
   */
  function check({ subject, clientId } = {}) {
    const at = now();
    counter.sweep(at, config.maxTrackedKeys);

    if (inFlight >= config.maxConcurrent) {
      return { allowed: false, reason: 'concurrency_limit', retryAfterSeconds: 1 };
    }

    const checks = [
      ['global_rate_limit', 'global', config.globalPerMinute],
      // An unauthenticated request has no subject yet; the global and client
      // buckets still apply to it.
      ...(subject ? [['subject_rate_limit', `sub:${subject}`, config.perSubjectPerMinute]] : []),
      ...(clientId ? [['client_rate_limit', `cli:${clientId}`, config.perClientPerMinute]] : []),
    ];

    for (const [reason, key, limit] of checks) {
      const result = counter.hit(key, limit, at);
      if (!result.allowed) {
        return {
          allowed: false,
          reason,
          retryAfterSeconds: Math.max(Math.ceil(result.resetMs / 1000), 1),
        };
      }
    }
    return { allowed: true };
  }

  function acquire() {
    inFlight += 1;
    let released = false;
    return function release() {
      if (released) return; // a double release would corrupt the count
      released = true;
      inFlight = Math.max(inFlight - 1, 0);
    };
  }

  return Object.freeze({
    config: Object.freeze({ ...config }),
    check,
    acquire,
    stats: () => ({ inFlight, trackedKeys: counter.size() }),
  });
}

/**
 * Read limits from the environment so an operator can tighten them without a
 * code change. Invalid values fall back to the default rather than disabling
 * the limit.
 */
function rateLimitOptionsFromEnv(env = process.env) {
  const positiveInt = (value, fallback) => {
    // Require the whole string to be a positive integer. Number.parseInt would
    // turn "1.5" into 1, silently applying a limit far tighter than intended.
    if (!/^\d+$/.test(String(value ?? '').trim())) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    globalPerMinute: positiveInt(env.MCP_RATE_LIMIT_GLOBAL, DEFAULTS.globalPerMinute),
    perSubjectPerMinute: positiveInt(env.MCP_RATE_LIMIT_SUBJECT, DEFAULTS.perSubjectPerMinute),
    perClientPerMinute: positiveInt(env.MCP_RATE_LIMIT_CLIENT, DEFAULTS.perClientPerMinute),
    maxConcurrent: positiveInt(env.MCP_MAX_CONCURRENT, DEFAULTS.maxConcurrent),
  };
}

module.exports = { DEFAULTS, createMcpRateLimiter, rateLimitOptionsFromEnv };
