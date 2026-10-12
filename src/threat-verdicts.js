'use strict';

// Threat verdicts for the AI facts and context, worked out once per
// destination and a slice at a time (P3-190).
//
// Measured on the production Hub 2026-10-12, a day's AI notification: 7,512
// destinations in the current period, matched once to count them
// (aiFacts.tallyThreats) and again to rank them (aiContext.rankThreats), each
// pass about 75 ms on the thread that answers every request. The minute it ran
// in had a 489 ms loop delay.

const DEFAULT_SLICE_ROWS = 500;

/**
 * The same matcher, remembering each (address, name) it has been asked about.
 * One per request: the feeds change hourly, and a verdict kept longer than the
 * work it was made for would outlive the feed that made it.
 */
function memoThreatIntel(threatIntel) {
  if (!threatIntel?.matchThreatIntel) return threatIntel;
  const verdicts = new Map();
  return {
    matchThreatIntel(ip, host) {
      const key = `${ip}\u0000${host}`;
      if (verdicts.has(key)) return verdicts.get(key);
      const verdict = threatIntel.matchThreatIntel(ip, host);
      verdicts.set(key, verdict);
      return verdict;
    },
  };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

/**
 * Call `visit` for each row, `sliceRows` at a time, letting the event loop go
 * between slices. `measure` wraps each slice so the profiler still sees the
 * work under one name.
 */
async function forEachInSlices(rows, visit, {
  sliceRows = DEFAULT_SLICE_ROWS, measure = fn => fn(), yieldToLoop = nextTurn,
} = {}) {
  for (let start = 0; start < rows.length; start += sliceRows) {
    const end = Math.min(rows.length, start + sliceRows);
    measure(() => {
      for (let index = start; index < end; index += 1) visit(rows[index]);
    });
    if (end < rows.length) await yieldToLoop();
  }
}

module.exports = { memoThreatIntel, forEachInSlices, DEFAULT_SLICE_ROWS };
