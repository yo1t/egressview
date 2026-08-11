'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '.egressview.db');

let db = null;
let lastDbPath = DEFAULT_DB_PATH;

function initDb(dbPath) {
  lastDbPath = dbPath || DEFAULT_DB_PATH;
  db = new Database(lastDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
}

function closeDb() {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
}

function reopen(dbPath) {
  closeDb();
  initDb(dbPath || lastDbPath);
}

function requireDb() {
  if (!db) throw new Error('Agent ingest store is not initialized');
  return db;
}

function batchAck(row, replayed) {
  return Object.freeze({
    batchId: row.batchId,
    accepted: row.acceptedCount,
    duplicate: row.duplicateCount,
    rejected: row.rejectedCount,
    receivedAt: row.receivedAt,
    replayed,
  });
}

function storeBatch(agentId, envelope, { receivedAt = Date.now() } = {}) {
  const database = requireDb();
  if (!Number.isFinite(receivedAt)) throw new TypeError('receivedAt must be finite');

  const operation = database.transaction(() => {
    const existing = database.prepare(`
      SELECT batchId, acceptedCount, duplicateCount, rejectedCount, receivedAt
      FROM agent_ingest_batches WHERE agentId = ? AND batchId = ?
    `).get(agentId, envelope.batchId);
    if (existing) return batchAck(existing, true);

    const insertObservation = database.prepare(`
      INSERT OR IGNORE INTO agent_observations (
        agentId, observationId, batchId, networkProtocol,
        localAddress, localPort, remoteAddress, remotePort,
        processId, processName, bundleId,
        firstObservedAt, lastObservedAt, bytesIn, bytesOut,
        collector, confidence, receivedAt
      ) VALUES (
        @agentId, @observationId, @batchId, @networkProtocol,
        @localAddress, @localPort, @remoteAddress, @remotePort,
        @processId, @processName, @bundleId,
        @firstObservedAt, @lastObservedAt, @bytesIn, @bytesOut,
        @collector, @confidence, @receivedAt
      )
    `);

    let acceptedCount = 0;
    for (const observation of envelope.observations) {
      const result = insertObservation.run({
        agentId,
        observationId: observation.observationId,
        batchId: envelope.batchId,
        networkProtocol: observation.networkProtocol,
        localAddress: observation.localAddress,
        localPort: observation.localPort,
        remoteAddress: observation.remoteAddress,
        remotePort: observation.remotePort,
        processId: observation.processID,
        processName: observation.processName,
        bundleId: observation.bundleID,
        firstObservedAt: Date.parse(observation.firstObservedAt),
        lastObservedAt: Date.parse(observation.lastObservedAt),
        bytesIn: observation.bytesIn,
        bytesOut: observation.bytesOut,
        collector: observation.collector,
        confidence: observation.confidence,
        receivedAt,
      });
      acceptedCount += result.changes;
    }

    const duplicateCount = envelope.observations.length - acceptedCount;
    database.prepare(`
      INSERT INTO agent_ingest_batches (
        agentId, batchId, schemaVersion, sentAt, receivedAt,
        acceptedCount, duplicateCount, rejectedCount, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'complete')
    `).run(
      agentId,
      envelope.batchId,
      envelope.schemaVersion,
      Date.parse(envelope.sentAt),
      receivedAt,
      acceptedCount,
      duplicateCount
    );

    database.prepare(`
      UPDATE agents SET platform = ?, hostName = ?, osVersion = ?, agentVersion = ?, updatedAt = ?
      WHERE agentId = ? AND revokedAt IS NULL
    `).run(
      envelope.agent.platform,
      envelope.agent.hostName,
      envelope.agent.osVersion,
      envelope.agent.agentVersion,
      receivedAt,
      agentId
    );

    return batchAck({
      batchId: envelope.batchId,
      acceptedCount,
      duplicateCount,
      rejectedCount: 0,
      receivedAt,
    }, false);
  });

  return operation.immediate();
}

function pruneObservations({ before }) {
  const database = requireDb();
  if (!Number.isFinite(before)) throw new TypeError('before must be finite');
  return database.transaction(() => {
    const observations = database.prepare(
      'DELETE FROM agent_observations WHERE lastObservedAt < ?'
    ).run(before).changes;
    const batches = database.prepare(`
      DELETE FROM agent_ingest_batches
      WHERE receivedAt < ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_observations o
          WHERE o.agentId = agent_ingest_batches.agentId
            AND o.batchId = agent_ingest_batches.batchId
        )
    `).run(before).changes;
    return { observations, batches };
  }).immediate();
}

function _initForTest(dbPath = ':memory:') {
  closeDb();
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agents (
      agentId TEXT PRIMARY KEY, platform TEXT NOT NULL, hostName TEXT NOT NULL,
      osVersion TEXT NOT NULL, agentVersion TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastSeenAt INTEGER, revokedAt INTEGER
    );
    CREATE TABLE agent_ingest_batches (
      agentId TEXT NOT NULL, batchId TEXT NOT NULL, schemaVersion INTEGER NOT NULL,
      sentAt INTEGER NOT NULL, receivedAt INTEGER NOT NULL,
      acceptedCount INTEGER NOT NULL, duplicateCount INTEGER NOT NULL,
      rejectedCount INTEGER NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY (agentId, batchId)
    );
    CREATE TABLE agent_observations (
      agentId TEXT NOT NULL, observationId TEXT NOT NULL, batchId TEXT NOT NULL,
      networkProtocol TEXT NOT NULL, localAddress TEXT NOT NULL, localPort INTEGER NOT NULL,
      remoteAddress TEXT NOT NULL, remotePort INTEGER NOT NULL, processId INTEGER NOT NULL,
      processName TEXT NOT NULL, bundleId TEXT, firstObservedAt INTEGER NOT NULL,
      lastObservedAt INTEGER NOT NULL, bytesIn TEXT, bytesOut TEXT,
      collector TEXT NOT NULL, confidence TEXT NOT NULL, receivedAt INTEGER NOT NULL,
      PRIMARY KEY (agentId, observationId)
    );
  `);
}

function _dbForTest() {
  return requireDb();
}

module.exports = {
  closeDb,
  initDb,
  pruneObservations,
  reopen,
  storeBatch,
  _dbForTest,
  _initForTest,
};
