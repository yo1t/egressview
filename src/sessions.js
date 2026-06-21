// Per-device login sessions (P2-23).
// Issued on password login; stored hashed (sha256) in SQLite with a
// sliding 30-day expiry.  The raw token is shown to the client exactly once.
'use strict';

const crypto   = require('crypto');
const Database = require('better-sqlite3');

// Use the same env var as history.js so DEMO_MODE / EGRESSVIEW_DB_PATH override works for both
const DB_PATH = process.env.EGRESSVIEW_DB_PATH
  ? require('path').resolve(process.env.EGRESSVIEW_DB_PATH)
  : (process.env.EGRESSVIEW_DB || '.egressview.db');
const SESSION_TTL_MS    = 30 * 24 * 3600_000;  // 30 days, sliding
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;       // refresh lastSeenAt at most every 5 min

let db = null;
let _lastDbPath = DB_PATH;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ── init ──────────────────────────────────────────────────────────────────────

function initDb(dbPath) {
  _lastDbPath = dbPath || DB_PATH;
  db = new Database(_lastDbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tokenHash   TEXT    NOT NULL UNIQUE,
      deviceLabel TEXT,
      createdAt   INTEGER NOT NULL,
      lastSeenAt  INTEGER NOT NULL,
      expiresAt   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt);
  `);
}

function reopen(dbPath) {
  if (db) { try { db.close(); } catch {} db = null; }
  initDb(dbPath || _lastDbPath);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Create a session and return the RAW token (only time it is available).
 * @param {string} [deviceLabel]  e.g. "Safari on iPhone"
 * @returns {{ token: string, id: number, expiresAt: number }|null}
 */
function createSession(deviceLabel) {
  if (!db) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const now   = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const info = db.prepare(`
    INSERT INTO sessions (tokenHash, deviceLabel, createdAt, lastSeenAt, expiresAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(token), (deviceLabel || '').slice(0, 100) || null, now, now, expiresAt);
  return { token, id: info.lastInsertRowid, expiresAt };
}

/**
 * Verify a raw token. Returns the session row (id, deviceLabel, …) or null.
 * Valid sessions get a sliding-expiry refresh, throttled to one write
 * per TOUCH_THROTTLE_MS so per-request overhead stays negligible.
 */
function verifySession(token) {
  if (!db || !token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE tokenHash = ?').get(sha256(token));
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  if (now - row.lastSeenAt > TOUCH_THROTTLE_MS) {
    db.prepare('UPDATE sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?')
      .run(now, now + SESSION_TTL_MS, row.id);
  }
  return row;
}

/** List all sessions, newest activity first (no token hashes exposed). */
function listSessions() {
  if (!db) return [];
  return db.prepare(`
    SELECT id, deviceLabel, createdAt, lastSeenAt, expiresAt
    FROM sessions ORDER BY lastSeenAt DESC
  `).all();
}

/** @returns {boolean} true if a session was deleted */
function revokeSession(id) {
  if (!db) return false;
  return db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
}

/**
 * Revoke all sessions, optionally keeping one (the caller's own).
 * @returns {number} revoked count
 */
function revokeAll(exceptId) {
  if (!db) return 0;
  if (exceptId != null) {
    return db.prepare('DELETE FROM sessions WHERE id != ?').run(exceptId).changes;
  }
  return db.prepare('DELETE FROM sessions').run().changes;
}

/** Remove expired sessions. @returns {number} pruned count */
function pruneExpired() {
  if (!db) return 0;
  return db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(Date.now()).changes;
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
  createSession,
  verifySession,
  listSessions,
  revokeSession,
  revokeAll,
  pruneExpired,
  SESSION_TTL_MS,
  _resetForTest,
  _closeForTest,
};
