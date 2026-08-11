'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { AGENT_PERMISSIONS } = require('./permissions');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '.egressview.db');
const ENROLLMENT_PREFIX = 'egve_';
const AGENT_TOKEN_PREFIX = 'egva_';
const ENROLLMENT_PATTERN = /^egve_[0-9a-f]{48}$/;
const AGENT_TOKEN_PATTERN = /^egva_[0-9a-f]{64}$/;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_ENROLLMENTS = 20;
const TOUCH_THROTTLE_MS = 60 * 1000;

let db = null;
let lastDbPath = DEFAULT_DB_PATH;
let hashKey = null;

function setPepper(value) {
  if (typeof value !== 'string' || value.length < 64) {
    throw new Error('Agent credential pepper must contain at least 64 characters');
  }
  hashKey = crypto.createHash('sha256').update(value).digest();
}

function secretHash(value) {
  if (!hashKey) throw new Error('Agent credential store has no hash key');
  return crypto.createHmac('sha256', hashKey).update(String(value)).digest('hex');
}

function auditRef(value) {
  return secretHash(`audit:${value}`).slice(0, 16);
}

function initDb(dbPath) {
  if (!hashKey) throw new Error('Agent credential store must be keyed before DB initialization');
  lastDbPath = dbPath || DEFAULT_DB_PATH;
  db = new Database(lastDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
}

function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

function reopen(dbPath) {
  closeDb();
  initDb(dbPath || lastDbPath);
}

function requireDb() {
  if (!db) throw new Error('Agent credential store is not initialized');
  return db;
}

function publicAgent(row) {
  return {
    agentId: row.agentId,
    platform: row.platform,
    hostName: row.hostName,
    osVersion: row.osVersion,
    agentVersion: row.agentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

function createEnrollment({ createdBy } = {}, options = {}) {
  const database = requireDb();
  const now = Number(options.now) || Date.now();
  const active = database.prepare(
    'SELECT COUNT(*) AS n FROM agent_enrollment_tokens WHERE usedAt IS NULL AND expiresAt > ?'
  ).get(now).n;
  if (active >= MAX_ACTIVE_ENROLLMENTS) {
    throw new Error(`At most ${MAX_ACTIVE_ENROLLMENTS} active enrollment codes are allowed`);
  }

  const code = `${ENROLLMENT_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
  const tokenId = crypto.randomUUID();
  const expiresAt = now + ENROLLMENT_TTL_MS;
  database.prepare(`
    INSERT INTO agent_enrollment_tokens
      (tokenId, tokenHash, createdAt, expiresAt, usedAt, createdByPrincipalHash)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(tokenId, secretHash(code), now, expiresAt, createdBy ? secretHash(`principal:${createdBy}`) : null);
  return { code, tokenId, expiresAt };
}

function enroll({ code, metadata }, options = {}) {
  if (!ENROLLMENT_PATTERN.test(String(code || ''))) return null;
  const database = requireDb();
  const now = Number(options.now) || Date.now();
  const operation = database.transaction(() => {
    const enrollment = database.prepare(`
      SELECT tokenId FROM agent_enrollment_tokens
      WHERE tokenHash = ? AND usedAt IS NULL AND expiresAt > ?
    `).get(secretHash(code), now);
    if (!enrollment) return null;

    const claimed = database.prepare(`
      UPDATE agent_enrollment_tokens SET usedAt = ?
      WHERE tokenId = ? AND usedAt IS NULL AND expiresAt > ?
    `).run(now, enrollment.tokenId, now);
    if (claimed.changes !== 1) return null;

    const agentId = crypto.randomUUID();
    const token = `${AGENT_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    database.prepare(`
      INSERT INTO agents
        (agentId, platform, hostName, osVersion, agentVersion, tokenHash,
         createdAt, updatedAt, lastSeenAt, revokedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      agentId,
      metadata.platform,
      metadata.hostName,
      metadata.osVersion,
      metadata.agentVersion,
      secretHash(token),
      now,
      now
    );
    return { token, agent: publicAgent(database.prepare('SELECT * FROM agents WHERE agentId = ?').get(agentId)) };
  });
  return operation();
}

function verifyAgentToken(token, options = {}) {
  if (!db || !AGENT_TOKEN_PATTERN.test(String(token || ''))) return null;
  const now = Number(options.now) || Date.now();
  const row = db.prepare('SELECT * FROM agents WHERE tokenHash = ?').get(secretHash(token));
  if (!row || row.revokedAt !== null) return null;
  let lastSeenAt = row.lastSeenAt;
  if (!row.lastSeenAt || now - row.lastSeenAt >= TOUCH_THROTTLE_MS) {
    db.prepare('UPDATE agents SET lastSeenAt = ?, updatedAt = ? WHERE agentId = ?')
      .run(now, now, row.agentId);
    lastSeenAt = now;
  }
  return Object.freeze({
    ...publicAgent({ ...row, lastSeenAt }),
    permissions: Object.freeze([AGENT_PERMISSIONS.INGEST]),
  });
}

function rotateAgentToken(agentId, currentToken, options = {}) {
  if (!AGENT_TOKEN_PATTERN.test(String(currentToken || ''))) return null;
  const database = requireDb();
  const now = Number(options.now) || Date.now();
  const token = `${AGENT_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
  const result = database.prepare(`
    UPDATE agents SET tokenHash = ?, updatedAt = ?
    WHERE agentId = ? AND tokenHash = ? AND revokedAt IS NULL
  `).run(secretHash(token), now, String(agentId), secretHash(currentToken));
  return result.changes === 1 ? { token } : null;
}

function revokeAgent(agentId, options = {}) {
  if (!db) return false;
  const now = Number(options.now) || Date.now();
  return db.prepare(`
    UPDATE agents SET revokedAt = ?, updatedAt = ?
    WHERE agentId = ? AND revokedAt IS NULL
  `).run(now, now, String(agentId)).changes === 1;
}

function listAgents() {
  if (!db) return [];
  return db.prepare('SELECT * FROM agents ORDER BY createdAt DESC').all().map(publicAgent);
}

function pruneEnrollmentTokens(options = {}) {
  if (!db) return 0;
  const now = Number(options.now) || Date.now();
  return db.prepare('DELETE FROM agent_enrollment_tokens WHERE expiresAt < ?').run(now - 24 * 60 * 60 * 1000).changes;
}

function _initForTest(dbPath = ':memory:', pepper = 'a'.repeat(64)) {
  closeDb();
  setPepper(pepper);
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_enrollment_tokens (
      tokenId TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER,
      createdByPrincipalHash TEXT
    );
    CREATE TABLE agents (
      agentId TEXT PRIMARY KEY, platform TEXT NOT NULL, hostName TEXT NOT NULL,
      osVersion TEXT NOT NULL, agentVersion TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      lastSeenAt INTEGER, revokedAt INTEGER
    );
  `);
}

module.exports = {
  AGENT_TOKEN_PREFIX,
  ENROLLMENT_PREFIX,
  ENROLLMENT_TTL_MS,
  MAX_ACTIVE_ENROLLMENTS,
  auditRef,
  closeDb,
  createEnrollment,
  enroll,
  initDb,
  listAgents,
  pruneEnrollmentTokens,
  reopen,
  revokeAgent,
  rotateAgentToken,
  setPepper,
  verifyAgentToken,
  _initForTest,
};
