// Names for destinations on the timeline, remembered between renders.
//
// The chart counts flows by destination and then has to say what each one is.
// The names live in `connections`, one row per flow -- five and a half of them
// per destination on average -- so naming the 15,712 destinations of a
// fourteen-day view means 15,712 index seeks and about 85,000 row fetches out
// of a 3 GB file. Measured on the production Hub: 486-506 ms, every time the
// cached summary expired.
//
// That was the largest remaining stall: 32 of the 43 stall stacks sampled over
// six hours led with this lookup (P3-156).
//
// A covering index on (dst, org, dstHost) was measured too, on a copy of the
// real table: 490 ms -> 170 ms. Not taken. It is still 170 ms, and it would be
// rewritten on every poll, because the upsert assigns `org` and `dstHost` in
// its SET list whether or not they changed -- a write on the hot path to make
// a cached read faster.
//
// Remembering the answers costs nothing on the write path and skips almost all
// of the work: new destinations appear at about 3 per minute (11 in the
// busiest hour measured), so a render five minutes after the last one has
// tens of names to look up rather than tens of thousands.
'use strict';

const LOOKUP_CHUNK = 900;

// How long a name is trusted. Names do change -- RDAP can return a different
// org, a PTR can be replaced -- so nothing is kept forever.
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

// Spread so that entries learned together do not expire together. Without it,
// the first render after the window closes pays the whole 490 ms again, which
// is the stall this exists to remove. With it, a render refreshes the fraction
// that has aged out: about 220 of 15,712 at five-minute intervals, some 8 ms.
const JITTER = 0.5;

const DEFAULT_MAX_ENTRIES = 200_000;

function createDestinationLabels({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now,
  random = Math.random,
} = {}) {
  const entries = new Map();
  let hits = 0;
  let misses = 0;

  function evict() {
    // Read the excess before deleting anything: `entries.size` moves as the
    // loop runs, and a loop that re-reads it stops a third of the way.
    const excess = entries.size - maxEntries;
    if (excess <= 0) return;
    const ordered = [...entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < excess; i += 1) entries.delete(ordered[i][0]);
  }

  function remember(dst, label, at) {
    entries.set(dst, { label, expiresAt: at + ttlMs * (JITTER + random()) });
  }

  /**
   * Names every destination given, asking the database only about the ones
   * that are not known or whose name has aged out.
   *
   * A destination with no name yet is answered with its own address and *not*
   * remembered: it is a destination enrichment has not reached, and the next
   * render should ask again rather than show an address for six hours.
   */
  function resolve(db, destinations) {
    const at = now();
    const labels = new Map();
    const missing = [];
    for (const dst of destinations) {
      const entry = entries.get(dst);
      if (entry && entry.expiresAt > at) {
        labels.set(dst, entry.label);
        hits += 1;
      } else {
        missing.push(dst);
        misses += 1;
      }
    }
    for (let i = 0; i < missing.length; i += LOOKUP_CHUNK) {
      const part = missing.slice(i, i + LOOKUP_CHUNK);
      const rows = db.prepare(
        `SELECT dst, MAX(NULLIF(org, '')) AS org, MAX(NULLIF(dstHost, '')) AS dstHost
         FROM connections WHERE dst IN (${part.map(() => '?').join(',')}) GROUP BY dst`
      ).all(...part);
      const named = new Map();
      for (const row of rows) named.set(row.dst, row.org || row.dstHost || null);
      for (const dst of part) {
        const label = named.get(dst) || null;
        labels.set(dst, label || dst);
        if (label) remember(dst, label, at);
      }
    }
    evict();
    return labels;
  }

  return {
    resolve,
    clear() { entries.clear(); hits = 0; misses = 0; },
    get size() { return entries.size; },
    stats() { return { size: entries.size, hits, misses }; },
  };
}

module.exports = { createDestinationLabels, LOOKUP_CHUNK, DEFAULT_TTL_MS };
