'use strict';

const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const logger = require('./logger');

const DEFAULT_RETENTION_DAYS = 180;
const MAX_METADATA_BYTES = 4096;

let db = null;
let lastDbPath = null;
let hashKey = crypto.randomBytes(32);

function sha256(value) {
  return crypto.createHmac('sha256', hashKey).update(String(value || '')).digest('hex');
}

function initDb(dbPath, options = {}) {
  lastDbPath = dbPath;
  if (options.hashKey) hashKey = Buffer.from(options.hashKey);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
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
  if (!db) return null;
  const row = {
    eventId: crypto.randomUUID(),
    createdAt: Date.now(),
    eventType: String(event.eventType || 'unknown').slice(0, 100),
    outcome: event.outcome === 'failure' ? 'failure' : 'success',
    authMethod: event.authMethod ? String(event.authMethod).slice(0, 20) : null,
    actorHash: event.actor ? sha256(event.actor) : null,
    requestId: event.requestId ? String(event.requestId).slice(0, 100) : null,
    clientIpHash: event.clientIp ? sha256(event.clientIp) : null,
    httpMethod: event.httpMethod ? String(event.httpMethod).slice(0, 10) : null,
    path: event.path ? String(event.path).split('?')[0].slice(0, 300) : null,
    metadata: boundedMetadata(event.metadata),
  };
  try {
    db.prepare(`
      INSERT INTO audit_events
        (eventId, createdAt, eventType, outcome, authMethod, actorHash,
         requestId, clientIpHash, httpMethod, path, metadata)
      VALUES
        (@eventId, @createdAt, @eventType, @outcome, @authMethod, @actorHash,
         @requestId, @clientIpHash, @httpMethod, @path, @metadata)
    `).run(row);
    return row.eventId;
  } catch (error) {
    logger.warn('[auth-audit] Append failed:', error.message);
    return null;
  }
}

function list({ limit = 100, before } = {}) {
  if (!db) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = before
    ? db.prepare(`
        SELECT eventId, createdAt, eventType, outcome, authMethod, actorHash,
               requestId, clientIpHash, httpMethod, path, metadata
        FROM audit_events WHERE createdAt < ?
        ORDER BY createdAt DESC, eventId DESC LIMIT ?
      `).all(Number(before), safeLimit)
    : db.prepare(`
        SELECT eventId, createdAt, eventType, outcome, authMethod, actorHash,
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
  closeDb,
  initDb,
  list,
  prune,
  reopen,
  setHashKey,
  DEFAULT_RETENTION_DAYS,
  _resetForTest(dbPath = ':memory:') {
    closeDb();
    initDb(dbPath, { hashKey: 'test-audit-key' });
  },
};
