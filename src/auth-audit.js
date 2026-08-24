'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const logger = require('./logger');

const DEFAULT_RETENTION_DAYS = 180;
const MAX_METADATA_BYTES = 4096;
const DEFAULT_DB_PATH = path.join(__dirname, '..', '.egressview.db');

let db = null;
let lastDbPath = DEFAULT_DB_PATH;
let hashKey = crypto.randomBytes(32);
let writeFailures = 0;
let lastWriteError = null;
let writeStatusHandler = null;

function sha256(value) {
  return crypto.createHmac('sha256', hashKey).update(String(value || '')).digest('hex');
}

function initDb(dbPath, options = {}) {
  lastDbPath = dbPath || DEFAULT_DB_PATH;
  if (options.hashKey) hashKey = Buffer.from(options.hashKey);
  db = new Database(lastDbPath);
  db.pragma('journal_mode = WAL');
  lastWriteError = null;
}

function setHashKey(value) {
  if (!value) return;
  hashKey = crypto.createHash('sha256').update(String(value)).digest();
}

function reopen(dbPath) {
  closeDb();
  initDb(dbPath || lastDbPath);
}

function closeDb() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}

function boundedMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json) <= MAX_METADATA_BYTES) return json;
  return JSON.stringify({ truncated: true });
}

function append(event = {}) {
  if (!db) {
    recordWriteStatus(new Error('Authentication audit store is not initialized'));
    return null;
  }
  const row = {
    eventId: crypto.randomUUID(),
    createdAt: Date.now(),
    eventType: String(event.eventType || 'unknown').slice(0, 100),
    outcome: event.outcome === 'failure' ? 'failure' : 'success',
    authMethod: event.authMethod ? String(event.authMethod).slice(0, 20) : null,
    actorHash: event.actor ? sha256(event.actor) : null,
    // Stable identity behind the credential. Hashed with the same key as
    // actorHash so no raw identifier is stored. NULL when the request has no
    // stable principal, rather than a guess.
    principalHash: event.principal ? sha256(event.principal) : null,
    requestId: event.requestId ? String(event.requestId).slice(0, 100) : null,
    clientIpHash: event.clientIp ? sha256(event.clientIp) : null,
    httpMethod: event.httpMethod ? String(event.httpMethod).slice(0, 10) : null,
    path: event.path ? String(event.path).split('?')[0].slice(0, 300) : null,
    metadata: boundedMetadata(event.metadata),
  };
  try {
    db.prepare(`
      INSERT INTO audit_events
        (eventId, createdAt, eventType, outcome, authMethod, actorHash, principalHash,
         requestId, clientIpHash, httpMethod, path, metadata)
      VALUES
        (@eventId, @createdAt, @eventType, @outcome, @authMethod, @actorHash, @principalHash,
         @requestId, @clientIpHash, @httpMethod, @path, @metadata)
    `).run(row);
    recordWriteStatus(null);
    return row.eventId;
  } catch (error) {
    recordWriteStatus(error);
    logger.warn('[auth-audit] Append failed:', error.message);
    return null;
  }
}

function recordWriteStatus(error) {
  if (error) {
    writeFailures += 1;
    lastWriteError = error.message;
  } else {
    lastWriteError = null;
  }
  try {
    writeStatusHandler?.({ ok: !error, writeFailures, lastWriteError });
  } catch {}
}

function health() {
  return { open: Boolean(db), writeFailures, lastWriteError, dbPath: lastDbPath };
}

function setWriteStatusHandler(handler) {
  writeStatusHandler = typeof handler === 'function' ? handler : null;
}

function assertWritable() {
  if (!db) throw new Error('Authentication audit store is not initialized');
  const probeId = append({ eventType: 'auth_audit_startup', outcome: 'success' });
  if (!probeId) {
    throw new Error(`Authentication audit store is not writable: ${lastWriteError || 'unknown error'}`);
  }
}

function list({ limit = 100, before } = {}) {
  if (!db) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = before
    ? db.prepare(`
        SELECT eventId, createdAt, eventType, outcome, authMethod, actorHash, principalHash,
               requestId, clientIpHash, httpMethod, path, metadata
        FROM audit_events WHERE createdAt < ?
        ORDER BY createdAt DESC, eventId DESC LIMIT ?
      `).all(Number(before), safeLimit)
    : db.prepare(`
        SELECT eventId, createdAt, eventType, outcome, authMethod, actorHash, principalHash,
               requestId, clientIpHash, httpMethod, path, metadata
        FROM audit_events ORDER BY createdAt DESC, eventId DESC LIMIT ?
      `).all(safeLimit);
  return rows.map(row => ({
    ...row,
    actorHash: row.actorHash ? row.actorHash.slice(0, 12) : null,
    clientIpHash: row.clientIpHash ? row.clientIpHash.slice(0, 12) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

function prune(retentionDays = DEFAULT_RETENTION_DAYS) {
  if (!db) return 0;
  const days = Math.min(Math.max(Number(retentionDays) || DEFAULT_RETENTION_DAYS, 1), 3650);
  return db.prepare('DELETE FROM audit_events WHERE createdAt < ?')
    .run(Date.now() - days * 24 * 3600_000).changes;
}

module.exports = {
  append,
  assertWritable,
  closeDb,
  health,
  initDb,
  list,
  prune,
  reopen,
  setHashKey,
  setWriteStatusHandler,
  DEFAULT_RETENTION_DAYS,
  _resetForTest(dbPath = ':memory:') {
    closeDb();
    writeFailures = 0;
    lastWriteError = null;
    writeStatusHandler = null;
    initDb(dbPath, { hashKey: 'test-audit-key' });
  },
};
