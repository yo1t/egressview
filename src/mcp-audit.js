// Append-only audit for the remote MCP endpoint (P2-60 PR 4).
//
// Deliberately separate from EgressView's own `audit_events` store. The MCP
// process runs with a scoped API identity, not the admin token; giving it write
// access to the main audit trail would let a compromised MCP forge or tamper
// with EgressView's records. It therefore owns its own file.
//
// What is recorded: who (pseudonymously), which client, which tool, which
// scopes, the outcome, a reason classification, the request id, and how long
// it took.
//
// What is never recorded: tool arguments, IP or MAC addresses, device note
// bodies, access tokens, raw JWTs, and provider error text. Those either
// identify people directly or hand an attacker material they did not have.
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '.egressview-mcp-audit.db');
// Matches EgressView's own audit retention. Keeping the two in step matters:
// an incident is reconstructed by joining both stores, and if this one expired
// first the main trail would still show that the service identity acted while
// the record of who asked for it had gone.
const DEFAULT_RETENTION_DAYS = 180;
const MAX_TOOL_NAME = 100;
const MAX_MCP_METHOD = 100;
const MAX_REASON = 60;
const MAX_REQUEST_ID = 100;
const MAX_SCOPES = 300;

let db = null;
let hashKey = null;
let lastDbPath = DEFAULT_DB_PATH;
// Write failures must be visible. Silently dropping rows would leave the
// public endpoint running blind while looking healthy.
let writeFailures = 0;
let lastWriteError = null;
let onWriteFailure = null;

/**
 * Pseudonymise an identifier. Without a key we store nothing rather than a
 * bare SHA-256, which would be trivially reversible for short values such as
 * a client id.
 */
function pseudonym(value) {
  if (!value || !hashKey) return null;
  return crypto.createHmac('sha256', hashKey).update(String(value)).digest('hex');
}

function setHashKey(value) {
  if (!value) return;
  hashKey = crypto.createHash('sha256').update(String(value)).digest();
}

function initDb(dbPath, options = {}) {
  lastDbPath = dbPath || DEFAULT_DB_PATH;
  if (options.hashKey) setHashKey(options.hashKey);
  db = new Database(lastDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // This store is owned entirely by the MCP process, so it creates its own
  // schema rather than depending on the EgressView migration runner.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_audit_events (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId      TEXT NOT NULL UNIQUE,
      createdAt    INTEGER NOT NULL,
      eventType    TEXT NOT NULL,
      outcome      TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
      reason       TEXT,
      subjectHash  TEXT,
      clientIdHash TEXT,
      clientIpHash TEXT,
      toolName     TEXT,
      mcpMethod    TEXT,
      httpStatus   INTEGER,
      scopes       TEXT,
      requestId    TEXT,
      durationMs   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_audit_created
      ON mcp_audit_events(createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_audit_type
      ON mcp_audit_events(eventType, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_audit_subject
      ON mcp_audit_events(subjectHash, createdAt DESC);
  `);

  // This store predates the request-level method/status fields and has no
  // user_version migration runner. Expand existing files in place without
  // guessing values for historical rows.
  const columns = new Set(
    db.prepare('PRAGMA table_info(mcp_audit_events)').all().map(row => row.name)
  );
  if (!columns.has('mcpMethod')) {
    db.exec('ALTER TABLE mcp_audit_events ADD COLUMN mcpMethod TEXT');
  }
  if (!columns.has('httpStatus')) {
    db.exec('ALTER TABLE mcp_audit_events ADD COLUMN httpStatus INTEGER');
  }
  if (!columns.has('clientIpHash')) {
    db.exec('ALTER TABLE mcp_audit_events ADD COLUMN clientIpHash TEXT');
  }
  // Indexed because the question this column answers — "is one source
  // flooding us?" — is always a grouped lookup over recent rows.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_audit_client_ip
             ON mcp_audit_events(clientIpHash, createdAt DESC)`);
}

function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

function bounded(value, limit) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, limit);
}

function normalizeScopes(scopes) {
  if (!scopes) return null;
  const list = Array.isArray(scopes) ? scopes : String(scopes).split(/\s+/);
  const clean = [...new Set(list.map(s => String(s).trim()).filter(Boolean))].sort();
  return clean.length ? bounded(clean.join(' '), MAX_SCOPES) : null;
}

/**
 * Append one event. Never throws: losing an audit row must not turn into a
 * failed tool call, and the caller has already decided the outcome.
 * @returns {string|null} the event id, or null when nothing was written
 */
function append(event = {}) {
  if (!db) return null;
  const row = {
    eventId: crypto.randomUUID(),
    createdAt: Date.now(),
    eventType: bounded(event.eventType || 'unknown', 60),
    outcome: event.outcome === 'success' ? 'success' : 'failure',
    // A short classification such as invalid_token or insufficient_scope.
    // Never provider error text, which can echo token contents.
    reason: bounded(event.reason, MAX_REASON),
    subjectHash: pseudonym(event.subject),
    clientIdHash: pseudonym(event.clientId),
    // The only identifier available when a request fails before
    // authentication: unauthorized and invalid_token rows carry no subject or
    // client, so without this a flood cannot be told from ordinary retries.
    // Pseudonymised with the same key, so a raw address is never stored.
    clientIpHash: pseudonym(event.clientIp),
    toolName: bounded(event.toolName, MAX_TOOL_NAME),
    mcpMethod: bounded(event.mcpMethod, MAX_MCP_METHOD),
    httpStatus: Number.isInteger(event.httpStatus)
      && event.httpStatus >= 100 && event.httpStatus <= 599
      ? event.httpStatus : null,
    scopes: normalizeScopes(event.scopes),
    requestId: bounded(event.requestId, MAX_REQUEST_ID),
    durationMs: Number.isFinite(event.durationMs) ? Math.round(event.durationMs) : null,
  };
  try {
    db.prepare(`
      INSERT INTO mcp_audit_events
        (eventId, createdAt, eventType, outcome, reason, subjectHash,
         clientIdHash, clientIpHash, toolName, mcpMethod, httpStatus, scopes,
         requestId, durationMs)
      VALUES
        (@eventId, @createdAt, @eventType, @outcome, @reason, @subjectHash,
         @clientIdHash, @clientIpHash, @toolName, @mcpMethod, @httpStatus, @scopes,
         @requestId, @durationMs)
    `).run(row);
    return row.eventId;
  } catch (error) {
    // Still never throws — a lost row must not fail a tool call the caller has
    // already been authorized for — but the loss is now counted and reported.
    writeFailures += 1;
    lastWriteError = error.message;
    try { onWriteFailure?.(error, writeFailures); } catch {}
    return null;
  }
}

/** Operational health of the store, for startup checks and monitoring. */
function health() {
  return { open: Boolean(db), writeFailures, lastWriteError, dbPath: lastDbPath };
}

/** Register a reporter so runtime write failures are surfaced, not swallowed. */
function setWriteFailureHandler(handler) {
  onWriteFailure = typeof handler === 'function' ? handler : null;
}

/**
 * Prove the store is actually writable before the public endpoint accepts
 * traffic. Opening the file successfully is not the same as being able to
 * append to it — a read-only mount or a full disk both pass initDb.
 */
function assertWritable() {
  if (!db) throw new Error('MCP audit store is not initialized');
  const probeId = append({ eventType: 'mcp_audit_startup', outcome: 'success' });
  if (!probeId) {
    throw new Error(`MCP audit store is not writable: ${lastWriteError || 'unknown error'}`);
  }
}

function list({ limit = 100, before } = {}) {
  if (!db) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sql = `
    SELECT seq, eventId, createdAt, eventType, outcome, reason, subjectHash,
           clientIdHash, clientIpHash, toolName, mcpMethod, httpStatus, scopes,
           requestId, durationMs
    FROM mcp_audit_events
    ${before ? 'WHERE createdAt < ?' : ''}
    ORDER BY seq DESC LIMIT ?
  `;
  return before
    ? db.prepare(sql).all(Number(before), safeLimit)
    : db.prepare(sql).all(safeLimit);
}

/** Counts by event type and reason, for spotting a run of failures. */
function summary({ sinceMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!db) return [];
  return db.prepare(`
    SELECT eventType, outcome, reason, COUNT(*) AS count
    FROM mcp_audit_events WHERE createdAt >= ?
    GROUP BY eventType, outcome, reason
    ORDER BY count DESC
  `).all(Date.now() - Number(sinceMs));
}

// Retention only takes effect while something calls prune(). A single call at
// startup leaves a long-running MCP process never enforcing it, so the
// documented window silently stops applying the longer the process stays up.
// This mirrors the daily schedule the application-side audit already uses.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let pruneTimer = null;

function startPruneSchedule({ intervalMs = PRUNE_INTERVAL_MS, retentionDays } = {}) {
  stopPruneSchedule();
  // prune() swallows its own errors, so a failing delete can never take down
  // the process or stop later audit writes.
  pruneTimer = setInterval(() => prune({ retentionDays }), intervalMs);
  // Never hold the event loop open just to wait for the next prune.
  pruneTimer.unref?.();
  return pruneTimer;
}

function stopPruneSchedule() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

function prune({ retentionDays = DEFAULT_RETENTION_DAYS, now } = {}) {
  if (!db) return 0;
  const at = Number.isFinite(now) ? Number(now) : Date.now();
  const cutoff = at - Number(retentionDays) * 24 * 60 * 60 * 1000;
  try {
    return db.prepare('DELETE FROM mcp_audit_events WHERE createdAt < ?').run(cutoff).changes;
  } catch {
    return 0;
  }
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  PRUNE_INTERVAL_MS,
  append,
  assertWritable,
  health,
  setWriteFailureHandler,
  closeDb,
  initDb,
  list,
  prune,
  startPruneSchedule,
  stopPruneSchedule,
  setHashKey,
  summary,
  _resetForTest(dbPath = ':memory:', options = {}) {
    closeDb();
    hashKey = null;
    writeFailures = 0;
    lastWriteError = null;
    onWriteFailure = null;
    initDb(dbPath, options.withoutHashKey ? {} : { hashKey: 'test-mcp-audit-key' });
  },
  // Test-only handle. Retention tests need rows with a chosen createdAt, and
  // append() deliberately stamps that itself.
  _dbForTest() { return db; },
};
