'use strict';

// Indexes that only make a read faster, built after startup on the
// maintenance thread rather than through a schema migration (P3-190).
//
// A migration on this Hub begins with a verified copy of the whole database
// (5.1 GB on production in 2026-10), so adding two indexes that way would keep
// the Hub from collecting for minutes on every upgrade. These change no data
// and no query's answer; a Hub without them answers the same, only slower, so
// they can be built whenever the thread that builds them is free.
//
// What they are for: the new-nodes list asks when each source and each
// destination was first seen, across the whole connection table. With only
// idx_src / idx_dst, SQLite walks the index and reads every one of the
// 627,000 rows for its firstSeen: 1.7-2.1 s measured on production. With
// firstSeen in the index, the same grouping never leaves it.
const OPTIONAL_HISTORY_INDEXES = [
  ['idx_connections_src_firstseen', 'CREATE INDEX IF NOT EXISTS idx_connections_src_firstseen ON connections(src, firstSeen)'],
  ['idx_connections_dst_firstseen', 'CREATE INDEX IF NOT EXISTS idx_connections_dst_firstseen ON connections(dst, firstSeen)'],
];

/**
 * Build whichever of the indexes are missing. Returns what it built and how
 * long each took, so the log says what the one-off cost was.
 */
function ensureHistoryIndexes(db) {
  if (!db) return { built: [], present: [] };
  const hasConnections = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connections'"
  ).get();
  if (!hasConnections) return { built: [], present: [] };
  const existing = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'connections'"
  ).all().map(row => row.name));
  const built = [];
  const present = [];
  for (const [name, sql] of OPTIONAL_HISTORY_INDEXES) {
    if (existing.has(name)) { present.push(name); continue; }
    const startedAt = process.hrtime.bigint();
    db.exec(sql);
    built.push({ name, ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10 });
  }
  return { built, present };
}

module.exports = { ensureHistoryIndexes, OPTIONAL_HISTORY_INDEXES };
