// Scoped API identities (P2-61 Phase 2).
//
// Replaces the single, permanent, all-powerful `X-Admin-Token` with
// individually issuable credentials that carry an explicit permission set, an
// expiry, and an independent revocation switch.
//
// Storage rules:
//   - only the SHA-256 hash of a token is stored; the plaintext is returned
//     exactly once, at creation, and is never recoverable afterwards
//   - the plaintext never reaches the database, logs, the audit trail, or any
//     later API response
//
// Verification is fail-closed: an unknown, revoked, expired, or malformed
// record grants nothing. Permissions are validated against the Phase 1
// registry, so a record naming a permission this build does not know is
// refused outright rather than silently reduced.
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const { ALL_PERMISSIONS, assertKnownPermissions } = require('./permissions');

const DB_PATH = path.join(__dirname, '..', '.egressview.db');

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'egv_';
const TOKEN_PATTERN = /^egv_[0-9a-f]{64}$/;
const MAX_ACTIVE_IDENTITIES = 25;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000; // one year
const MIN_TTL_MS = 60 * 1000;
const MAX_LABEL_LENGTH = 100;
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

let db = null;
let _lastDbPath = DB_PATH;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isApiIdentityToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function initDb(dbPath) {
  _lastDbPath = dbPath || DB_PATH;
  db = new Database(_lastDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // Schema is owned by db-migrate (v10); creating it here would let a fresh
  // process race the migration owner.
}

function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

function reopen(dbPath) {
  closeDb();
  initDb(dbPath || _lastDbPath);
}

function serializePermissions(permissions) {
  return JSON.stringify([...new Set(permissions)].sort());
}

/**
 * Parse a stored permission list. Returns null when the record cannot be
 * trusted, so the caller denies instead of guessing.
 */
function parsePermissions(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) return null;
  try {
    assertKnownPermissions(parsed);
  } catch {
    return null; // record references a permission this build does not define
  }
  return Object.freeze([...parsed]);
}

function normalizeLabel(label) {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) throw new Error('API identity label is required');
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new Error(`API identity label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return trimmed;
}

function normalizeTtl(expiresInMs) {
  if (expiresInMs === undefined || expiresInMs === null) {
    throw new Error('API identity requires an expiry');
  }
  const ttl = Number(expiresInMs);
  if (!Number.isFinite(ttl) || !Number.isInteger(ttl)) {
    throw new Error('API identity expiry must be an integer number of milliseconds');
  }
  if (ttl < MIN_TTL_MS) throw new Error('API identity expiry is too short');
  if (ttl > MAX_TTL_MS) throw new Error('API identity expiry exceeds the maximum of one year');
  return ttl;
}

function normalizePermissionInput(permissions) {
  const list = Array.isArray(permissions) ? permissions : [];
  if (!list.length) throw new Error('API identity requires at least one permission');
  assertKnownPermissions(list); // throws on unknown permissions
  return [...new Set(list)];
}

function publicRow(row) {
  const permissions = parsePermissions(row.permissions);
  return {
    id: row.id,
    label: row.label,
    // A record whose permissions cannot be trusted is surfaced as granting
    // nothing, matching what verification will do with it.
    permissions: permissions ? [...permissions] : [],
    permissionsValid: permissions !== null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

function countActive(now) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM api_identities WHERE revokedAt IS NULL AND expiresAt > ?'
  ).get(now).n;
}

/**
 * Create an identity and return the plaintext token exactly once.
 * @returns {{ token: string, identity: object }}
 */
function createIdentity({ label, permissions, expiresInMs }, options = {}) {
  if (!db) throw new Error('API identity store is not initialized');
  const now = Number(options.now) || Date.now();
  const cleanLabel = normalizeLabel(label);
  const cleanPermissions = normalizePermissionInput(permissions);
  const ttl = normalizeTtl(expiresInMs);

  if (countActive(now) >= MAX_ACTIVE_IDENTITIES) {
    throw new Error(`At most ${MAX_ACTIVE_IDENTITIES} active API identities are allowed`);
  }

  const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('hex')}`;
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO api_identities
      (id, label, tokenHash, permissions, createdAt, expiresAt, lastUsedAt, revokedAt)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(id, cleanLabel, sha256(token), serializePermissions(cleanPermissions), now, now + ttl);

  const identity = publicRow(db.prepare('SELECT * FROM api_identities WHERE id = ?').get(id));
  return { token, identity };
}

function listIdentities() {
  if (!db) return [];
  return db.prepare('SELECT * FROM api_identities ORDER BY createdAt DESC').all().map(publicRow);
}

/** Revoke one identity without touching any other credential. */
function revokeIdentity(id, options = {}) {
  if (!db) return false;
  const now = Number(options.now) || Date.now();
  const result = db.prepare(
    'UPDATE api_identities SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL'
  ).run(now, String(id));
  return result.changes > 0;
}

/**
 * Resolve a presented token. Returns null for anything that is not a live,
 * unexpired, unrevoked record with a permission list this build understands.
 */
function verifyToken(token, options = {}) {
  if (!db || !isApiIdentityToken(token)) return null;
  const now = Number(options.now) || Date.now();
  const row = db.prepare('SELECT * FROM api_identities WHERE tokenHash = ?').get(sha256(token));
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (!Number.isFinite(row.expiresAt) || row.expiresAt <= now) return null;

  const permissions = parsePermissions(row.permissions);
  if (!permissions || permissions.length === 0) return null;

  if (!row.lastUsedAt || now - row.lastUsedAt > TOUCH_THROTTLE_MS) {
    try {
      db.prepare('UPDATE api_identities SET lastUsedAt = ? WHERE id = ?').run(now, row.id);
    } catch {
      // Usage tracking is best-effort and must never fail an authorized call.
    }
  }

  return Object.freeze({
    id: row.id,
    label: row.label,
    permissions,
    expiresAt: row.expiresAt,
  });
}

/** Remove records that expired long enough ago to be uninteresting. */
function pruneExpired(options = {}) {
  if (!db) return 0;
  const now = Number(options.now) || Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  return db.prepare('DELETE FROM api_identities WHERE expiresAt < ?').run(cutoff).changes;
}

/**
 * Test seam: write a raw permissions value so the fail-closed parsing path can
 * be exercised with records this build would refuse to issue.
 */
function _writeRawPermissionsForTest(id, rawPermissions) {
  if (!db) return false;
  return db.prepare('UPDATE api_identities SET permissions = ? WHERE id = ?')
    .run(String(rawPermissions), String(id)).changes > 0;
}

function _initForTest(dbPath) {
  closeDb();
  initDb(dbPath || ':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_identities (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      tokenHash   TEXT NOT NULL UNIQUE,
      permissions TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      expiresAt   INTEGER NOT NULL,
      lastUsedAt  INTEGER,
      revokedAt   INTEGER
    );
  `);
}

module.exports = {
  ALL_PERMISSIONS,
  MAX_ACTIVE_IDENTITIES,
  MAX_TTL_MS,
  MIN_TTL_MS,
  TOKEN_PREFIX,
  isApiIdentityToken,
  initDb,
  closeDb,
  reopen,
  createIdentity,
  listIdentities,
  revokeIdentity,
  verifyToken,
  pruneExpired,
  _initForTest,
  _writeRawPermissionsForTest,
};
