// Beacon storage: connection_events table (raw observations) +
//                 beacons table (detected candidates)
'use strict';

const Database = require('better-sqlite3');
const logger   = require('./logger');

const DB_PATH = process.env.WIDEMAP_DB || '.widemap.db';
const EVENT_RETENTION_MS = 7 * 24 * 3600_000; // 7 days

let db = null;

// ── init ──────────────────────────────────────────────────────────────────────

function initDb(dbPath) {
  db = new Database(dbPath || DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      src     TEXT    NOT NULL,
      dst     TEXT    NOT NULL,
      dstHost TEXT,
      dport   INTEGER,
      proto   TEXT,
      seenAt  INTEGER NOT NULL,
      source  TEXT    NOT NULL DEFAULT 'poll'
    );
    CREATE INDEX IF NOT EXISTS idx_ce_key    ON connection_events(src, dst, dport, proto);
    CREATE INDEX IF NOT EXISTS idx_ce_seenAt ON connection_events(seenAt);

    CREATE TABLE IF NOT EXISTS beacons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      src         TEXT,
      dst         TEXT,
      dstHost     TEXT,
      dport       INTEGER,
      proto       TEXT,
      intervalMs  INTEGER,
      intervalCov REAL,
      obsCount    INTEGER,
      firstSeen   INTEGER,
      lastSeen    INTEGER,
      status      TEXT    NOT NULL DEFAULT 'candidate',
      detectedAt  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_beacons_key ON beacons(src, dst, dport, proto);
  `);
}

// ── connection_events ─────────────────────────────────────────────────────────

/**
 * Record a single observed connection.
 * @param {{src, dst, dstHost?, dport, proto, seenAt, source?}} e
 */
function appendEvent(e) {
  if (!db) return;
  db.prepare(`
    INSERT INTO connection_events (src, dst, dstHost, dport, proto, seenAt, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(e.src, e.dst, e.dstHost || null, e.dport, e.proto, e.seenAt, e.source || 'poll');
}

/**
 * Return all events newer than `since` (epoch ms).
 * Defaults to 7-day window.
 */
function getEvents(since) {
  if (!db) return [];
  const cutoff = since ?? (Date.now() - EVENT_RETENTION_MS);
  return db.prepare(
    'SELECT src, dst, dstHost, dport, proto, seenAt, source FROM connection_events WHERE seenAt >= ? ORDER BY seenAt'
  ).all(cutoff);
}

/** Delete events older than `before` (epoch ms, default: 7 days ago). */
function pruneEvents(before) {
  if (!db) return 0;
  const cutoff = before ?? (Date.now() - EVENT_RETENTION_MS);
  const info = db.prepare('DELETE FROM connection_events WHERE seenAt < ?').run(cutoff);
  return info.changes;
}

// ── beacons ───────────────────────────────────────────────────────────────────

/**
 * Insert or update a beacon candidate.
 * Matches on (src, dst, dport, proto) with status='candidate'.
 */
function upsertBeacon(c) {
  if (!db) return;
  const existing = db.prepare(`
    SELECT id FROM beacons
    WHERE src=? AND dst=? AND dport=? AND proto=? AND status='candidate'
  `).get(c.src, c.dst, c.dport, c.proto);

  if (existing) {
    db.prepare(`
      UPDATE beacons
      SET intervalMs=?, intervalCov=?, obsCount=?, lastSeen=?, dstHost=?, detectedAt=?
      WHERE id=?
    `).run(c.intervalMs, c.intervalCov, c.obsCount, c.lastSeen,
           c.dstHost || null, Date.now(), existing.id);
  } else {
    db.prepare(`
      INSERT INTO beacons
        (src, dst, dstHost, dport, proto, intervalMs, intervalCov, obsCount, firstSeen, lastSeen, detectedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c.src, c.dst, c.dstHost || null, c.dport, c.proto,
           c.intervalMs, c.intervalCov, c.obsCount, c.firstSeen, c.lastSeen, Date.now());
  }
}

/** Return all beacons, most regular (lowest CoV) first. */
function getBeacons() {
  if (!db) return [];
  return db.prepare('SELECT * FROM beacons ORDER BY intervalCov ASC, detectedAt DESC').all();
}

/**
 * Dismiss a beacon by id.
 * @returns {boolean}  true if a row was updated
 */
function dismissBeacon(id) {
  if (!db) return false;
  const info = db.prepare("UPDATE beacons SET status='dismissed' WHERE id=?").run(id);
  return info.changes > 0;
}

// ── reopen (called after backup restore) ─────────────────────────────────────

/**
 * Close the current SQLite connection and reopen it on the same path.
 * Used after backup.restoreFromGeneration / restoreFromFile so the module
 * always holds a live handle to the current on-disk database file.
 *
 * @param {string} [dbPath]  Override DB path (defaults to the same path used
 *                           by the last initDb call, or the env / default).
 */
function reopen(dbPath) {
  if (db) { try { db.close(); } catch {} db = null; }
  initDb(dbPath);
}

// ── test helpers ──────────────────────────────────────────────────────────────

function _resetForTest(dbPath) {
  if (db) { try { db.close(); } catch {} db = null; }
  initDb(dbPath || ':memory:');
}

function _closeForTest() {
  if (db) { try { db.close(); } catch {} db = null; }
}

module.exports = {
  initDb,
  reopen,
  appendEvent,
  getEvents,
  pruneEvents,
  upsertBeacon,
  getBeacons,
  dismissBeacon,
  _resetForTest,
  _closeForTest,
};
