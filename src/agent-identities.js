'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { AGENT_PERMISSIONS } = require('./permissions');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '.egressview.db');
const AGENT_TOKEN_PREFIX = 'egva_';
const AGENT_TOKEN_PATTERN = /^egva_[0-9a-f]{64}$/;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_ENROLLMENTS = 20;
const MAX_PENDING_REQUESTS = 20;

// Six characters a person can read aloud and retype once. 0/O and 1/I are left
// out because a code that is transcribed wrongly costs the same as a code that
// was guessed wrongly, and both burn an attempt.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const ENROLLMENT_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

// 32^6 is about 1.07 billion. That is only safe because the code is not the
// last line of defence: guessing it produces a *request*, and a request still
// has to be approved by an administrator who did not initiate it. The attempt
// limit is what keeps the window closed in the meantime -- without it, ten
// minutes of guessing at a hundred tries a second is a real threat.
const MAX_CODE_ATTEMPTS = 5;

// The client proves it owns a pending request with this, so approval can hand
// back the agent token without a second round of identification.
const CLAIM_PATTERN = /^egvc_[0-9a-f]{64}$/;
const CLAIM_PREFIX = 'egvc_';
const TOUCH_THROTTLE_MS = 60 * 1000;

let db = null;
// Approved-but-not-yet-collected tokens. Deliberately in memory: a token the
// agent never picks up should not survive a restart.
const pendingTokens = new Map();
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

/** Rejection-sampled so every character is equally likely. */
function generateCode() {
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH * 2)) {
      if (byte >= 256 - (256 % CODE_ALPHABET.length)) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
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

  const code = generateCode();
  const tokenId = crypto.randomUUID();
  const expiresAt = now + ENROLLMENT_TTL_MS;
  database.prepare(`
    INSERT INTO agent_enrollment_tokens
      (tokenId, tokenHash, createdAt, expiresAt, usedAt, createdByPrincipalHash)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(tokenId, secretHash(code), now, expiresAt, createdBy ? secretHash(`principal:${createdBy}`) : null);
  return { code, tokenId, expiresAt };
}

/**
 * Turns a valid code into a *pending request*, not into an agent.
 *
 * Returns `{ requestId, claimSecret, expiresAt }` on success. The caller polls
 * with the claim secret until an administrator decides. A wrong code burns an
 * attempt against that code, and the fifth failure locks it: this is what makes
 * a six character code viable at all.
 *
 * The metadata is whatever the client said about itself. Nothing here verifies
 * it, which is precisely why a human has to look at it before it becomes an
 * agent.
 */
function requestEnrollment({ code, metadata, clientIpHash }, options = {}) {
  const database = requireDb();
  const now = Number(options.now) || Date.now();
  const normalized = normalizeCode(code);
  if (!ENROLLMENT_PATTERN.test(normalized)) return { ok: false, reason: 'invalid_code' };

  const operation = database.transaction(() => {
    const pending = database.prepare(
      "SELECT COUNT(*) AS n FROM agent_enrollment_requests WHERE status = 'pending' AND expiresAt > ?"
    ).get(now).n;
    if (pending >= MAX_PENDING_REQUESTS) return { ok: false, reason: 'too_many_pending' };

    const enrollment = database.prepare(`
      SELECT tokenId, attemptCount, lockedAt FROM agent_enrollment_tokens
      WHERE tokenHash = ? AND usedAt IS NULL AND expiresAt > ?
    `).get(secretHash(normalized), now);

    if (!enrollment) {
      // A wrong code cannot be attributed to a specific token, so it is only
      // stopped by the route's rate limit. Counting here would let an attacker
      // lock out somebody else's valid code by guessing around it.
      return { ok: false, reason: 'invalid_code' };
    }
    if (enrollment.lockedAt) return { ok: false, reason: 'locked' };

    const claimSecret = `${CLAIM_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    const requestId = crypto.randomUUID();
    database.prepare(`
      INSERT INTO agent_enrollment_requests
        (requestId, tokenId, platform, hostName, osVersion, agentVersion,
         claimSecretHash, clientIpHash, createdAt, expiresAt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      requestId, enrollment.tokenId, metadata.platform, metadata.hostName,
      metadata.osVersion, metadata.agentVersion, secretHash(claimSecret),
      clientIpHash || null, now, now + REQUEST_TTL_MS
    );
    // The code is spent on the request, not on the agent. Approval is what
    // creates the credential, and a rejected request must not leave a code
    // that someone else can still use.
    database.prepare('UPDATE agent_enrollment_tokens SET usedAt = ? WHERE tokenId = ?')
      .run(now, enrollment.tokenId);
    return { ok: true, requestId, claimSecret, expiresAt: now + REQUEST_TTL_MS };
  });
  return operation();
}

/**
 * Records a failed attempt against a code and locks it after MAX_CODE_ATTEMPTS.
 * Separate from requestEnrollment so the route can call it only when a code was
 * well-formed but unknown, keeping the counter meaningful.
 */
function recordCodeAttempt(code, options = {}) {
  if (!db) return { locked: false, attempts: 0 };
  const now = Number(options.now) || Date.now();
  const normalized = normalizeCode(code);
  const row = db.prepare(`
    SELECT tokenId, attemptCount FROM agent_enrollment_tokens
    WHERE tokenHash = ? AND usedAt IS NULL AND expiresAt > ?
  `).get(secretHash(normalized), now);
  if (!row) return { locked: false, attempts: 0 };
  const attempts = row.attemptCount + 1;
  const locked = attempts >= MAX_CODE_ATTEMPTS;
  db.prepare('UPDATE agent_enrollment_tokens SET attemptCount = ?, lockedAt = ? WHERE tokenId = ?')
    .run(attempts, locked ? now : null, row.tokenId);
  return { locked, attempts };
}

function listPendingRequests(options = {}) {
  if (!db) return [];
  const now = Number(options.now) || Date.now();
  return db.prepare(`
    SELECT requestId, platform, hostName, osVersion, agentVersion, createdAt, expiresAt
    FROM agent_enrollment_requests
    WHERE status = 'pending' AND expiresAt > ?
    ORDER BY createdAt DESC
  `).all(now).map(row => ({
    ...row,
    // Surfaced so the approver can see that approving this one will split or
    // replace an existing machine's history rather than add a new one.
    duplicateHostName: db.prepare(
      'SELECT COUNT(*) AS n FROM agents WHERE hostName = ? AND revokedAt IS NULL'
    ).get(row.hostName).n > 0,
  }));
}

function approveRequest(requestId, { decidedBy, replaceExisting = false } = {}, options = {}) {
  const database = requireDb();
  const now = Number(options.now) || Date.now();
  const operation = database.transaction(() => {
    const request = database.prepare(`
      SELECT * FROM agent_enrollment_requests
      WHERE requestId = ? AND status = 'pending' AND expiresAt > ?
    `).get(String(requestId), now);
    if (!request) return null;

    if (replaceExisting) {
      // Revoking rather than deleting: the observations already stored against
      // the old agentId stay attributable instead of becoming orphans.
      database.prepare(`
        UPDATE agents SET revokedAt = ?, updatedAt = ?
        WHERE hostName = ? AND revokedAt IS NULL
      `).run(now, now, request.hostName);
    }

    const agentId = crypto.randomUUID();
    const token = `${AGENT_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    database.prepare(`
      INSERT INTO agents
        (agentId, platform, hostName, osVersion, agentVersion, tokenHash,
         createdAt, updatedAt, lastSeenAt, revokedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(agentId, request.platform, request.hostName, request.osVersion,
           request.agentVersion, secretHash(token), now, now);
    database.prepare(`
      UPDATE agent_enrollment_requests
      SET status = 'approved', decidedAt = ?, decidedByPrincipalHash = ?, agentId = ?
      WHERE requestId = ?
    `).run(now, decidedBy ? secretHash(`principal:${decidedBy}`) : null, agentId, request.requestId);

    // Held only until the agent collects it with its claim secret; never
    // written to logs, config or audit metadata.
    pendingTokens.set(request.requestId, { token, agentId, issuedAt: now });
    return { agentId, agent: publicAgent(database.prepare('SELECT * FROM agents WHERE agentId = ?').get(agentId)) };
  });
  return operation();
}

function rejectRequest(requestId, { decidedBy } = {}, options = {}) {
  if (!db) return false;
  const now = Number(options.now) || Date.now();
  const changed = db.prepare(`
    UPDATE agent_enrollment_requests
    SET status = 'rejected', decidedAt = ?, decidedByPrincipalHash = ?
    WHERE requestId = ? AND status = 'pending'
  `).run(now, decidedBy ? secretHash(`principal:${decidedBy}`) : null, String(requestId)).changes === 1;
  if (changed) pendingTokens.delete(String(requestId));
  return changed;
}

/**
 * The agent polls this with the claim secret it got when it applied.
 *
 * Returns the token exactly once. Anything else -- still pending, rejected,
 * expired, already collected -- returns a status without a credential.
 */
function claimApproved({ requestId, claimSecret }, options = {}) {
  if (!db) return { status: 'unknown' };
  const now = Number(options.now) || Date.now();
  if (!CLAIM_PATTERN.test(String(claimSecret || ''))) return { status: 'unknown' };
  const request = db.prepare('SELECT * FROM agent_enrollment_requests WHERE requestId = ?').get(String(requestId));
  if (!request) return { status: 'unknown' };
  if (!crypto.timingSafeEqual(
    Buffer.from(request.claimSecretHash), Buffer.from(secretHash(String(claimSecret)))
  )) return { status: 'unknown' };

  if (request.status === 'pending') {
    return request.expiresAt <= now ? { status: 'expired' } : { status: 'pending' };
  }
  if (request.status !== 'approved') return { status: request.status };

  const held = pendingTokens.get(request.requestId);
  if (!held) return { status: 'collected' };
  pendingTokens.delete(request.requestId);
  return { status: 'approved', token: held.token, agentId: held.agentId };
}

function expireStaleRequests(options = {}) {
  if (!db) return 0;
  const now = Number(options.now) || Date.now();
  return db.prepare(
    "UPDATE agent_enrollment_requests SET status = 'expired' WHERE status = 'pending' AND expiresAt <= ?"
  ).run(now).changes;
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
      createdByPrincipalHash TEXT,
      attemptCount INTEGER NOT NULL DEFAULT 0, lockedAt INTEGER
    );
    CREATE TABLE agent_enrollment_requests (
      requestId TEXT PRIMARY KEY, tokenId TEXT NOT NULL,
      platform TEXT NOT NULL, hostName TEXT NOT NULL,
      osVersion TEXT NOT NULL, agentVersion TEXT NOT NULL,
      claimSecretHash TEXT NOT NULL UNIQUE, clientIpHash TEXT,
      createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
      status TEXT NOT NULL, decidedAt INTEGER,
      decidedByPrincipalHash TEXT, agentId TEXT
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
  CODE_ALPHABET,
  CODE_LENGTH,
  ENROLLMENT_TTL_MS,
  MAX_ACTIVE_ENROLLMENTS,
  MAX_CODE_ATTEMPTS,
  MAX_PENDING_REQUESTS,
  REQUEST_TTL_MS,
  approveRequest,
  auditRef,
  claimApproved,
  closeDb,
  createEnrollment,
  expireStaleRequests,
  initDb,
  listPendingRequests,
  recordCodeAttempt,
  rejectRequest,
  requestEnrollment,
  listAgents,
  pruneEnrollmentTokens,
  reopen,
  revokeAgent,
  rotateAgentToken,
  setPepper,
  verifyAgentToken,
  _initForTest,
};
