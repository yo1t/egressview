// Bounded in-memory hot cache for durable connection history.
'use strict';

const DEFAULT_HOT_MAX_ENTRIES = 100_000;

function parseHotMaxEntries(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HOT_MAX_ENTRIES;
}

function createHistoryCache(initialLimit = DEFAULT_HOT_MAX_ENTRIES) {
  const entries = new Map();
  let maxEntries = parseHotMaxEntries(initialLimit);

  function enforceLimit() {
    if (entries.size <= maxEntries) return 0;
    const reserve = maxEntries >= 1_000 ? Math.max(100, Math.floor(maxEntries * 0.01)) : 0;
    const targetSize = Math.max(1, maxEntries - reserve);
    const evictCount = entries.size - targetSize;
    const oldest = [...entries.entries()]
      .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0))
      .slice(0, evictCount);
    for (const [key] of oldest) entries.delete(key);
    return oldest.length;
  }

  return {
    map: entries,
    clear() { entries.clear(); },
    get limit() { return maxEntries; },
    setLimit(value) {
      maxEntries = parseHotMaxEntries(value);
      return { hotMaxEntries: maxEntries, evicted: enforceLimit() };
    },
    set(key, entry) {
      entries.set(key, entry);
      return enforceLimit();
    },
    replace(values, keyFor) {
      entries.clear();
      for (const value of values) entries.set(keyFor(value), value);
      return enforceLimit();
    },
    prune(cutoff) {
      let expired = 0;
      for (const [key, value] of entries) {
        if (value.lastSeen < cutoff) {
          entries.delete(key);
          expired++;
        }
      }
      return { expired, evicted: enforceLimit() };
    },
  };
}

module.exports = { createHistoryCache, parseHotMaxEntries, DEFAULT_HOT_MAX_ENTRIES };
