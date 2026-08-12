'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const {
  buildUnifiedReadModel,
  createAgentCorrelation,
  DEFAULT_CORRELATION_WINDOW_MS,
} = require('./agent-correlation');
const logger = require('./logger');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '.egressview.db');

let db = null;
let lastDbPath = DEFAULT_DB_PATH;
const configuredWindowMs = Number(process.env.EGRESSVIEW_AGENT_CORRELATION_WINDOW_MS);
const correlation = createAgentCorrelation({
  getDb: () => db,
  windowMs: Number.isFinite(configuredWindowMs) && configuredWindowMs >= 0
    ? configuredWindowMs
    : DEFAULT_CORRELATION_WINDOW_MS,
});

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

  const ack = operation.immediate();
  if (!ack.replayed && ack.accepted > 0) {
    try {
      correlation.reconcile({ agentId });
    } catch (error) {
      // The durable ingest ACK remains authoritative. Periodic reconciliation
      // retries this work without making the Agent resend an accepted batch.
      logger.error('[agent-correlation] post-ingest reconcile failed:', error.message);
    }
  }
  return ack;
}

function pruneObservations({ before }) {
  const database = requireDb();
  if (!Number.isFinite(before)) throw new TypeError('before must be finite');
  return database.transaction(() => {
    const correlations = database.prepare(`
      DELETE FROM connection_agent_observations
      WHERE (agentId, observationId) IN (
        SELECT agentId, observationId FROM agent_observations WHERE lastObservedAt < ?
      )
    `).run(before).changes;
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
    return { correlations, observations, batches };
  }).immediate();
}

function reconcileCorrelations(options) {
  return correlation.reconcile(options);
}

/**
 * What an agent last delivered, for the collection health display.
 *
 * A router reports the sessions its most recent poll returned; the equivalent
 * for an agent is the observations in its most recent batch. Without this the
 * health strip fell back to the router fields, so a Mac that was delivering
 * normally was shown as `0` with no collection time — which reads as "the agent
 * is not working" to someone who has just installed it.
 */
function getAgentCollectionStatus(agentId) {
  const database = requireDb();
  const batch = database.prepare(`
    SELECT batchId, receivedAt FROM agent_ingest_batches
    WHERE agentId = ? ORDER BY receivedAt DESC LIMIT 1
  `).get(agentId);
  if (!batch) return { lastReceivedAt: null, observationCount: 0 };
  const observationCount = database.prepare(
    'SELECT COUNT(*) AS n FROM agent_observations WHERE agentId = ? AND batchId = ?'
  ).get(agentId, batch.batchId).n;
  return { lastReceivedAt: batch.receivedAt, observationCount };
}

function getCorrelationDiagnostics() {
  return correlation.diagnostics();
}

function queryCorrelationReadModel(options) {
  return correlation.queryReadModel(options);
}

function queryUnifiedReadModel(routerConnections, options) {
  return buildUnifiedReadModel(routerConnections, correlation.queryReadModel(options));
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
    CREATE TABLE connections (
      src TEXT NOT NULL, dst TEXT NOT NULL, dport INTEGER NOT NULL, proto TEXT NOT NULL,
      sport INTEGER, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto)
    );
    CREATE TABLE connection_agent_observations (
      src TEXT NOT NULL, dst TEXT NOT NULL, dport INTEGER NOT NULL, proto TEXT NOT NULL,
      agentId TEXT NOT NULL, observationId TEXT NOT NULL,
      matchKind TEXT NOT NULL, matchedAt INTEGER NOT NULL, timeDeltaMs INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto, agentId, observationId)
    );
  `);
}

function _dbForTest() {
  return requireDb();
}

module.exports = {
  closeDb,
  initDb,
  getAgentCollectionStatus,
  getCorrelationDiagnostics,
  pruneObservations,
  queryCorrelationReadModel,
  queryUnifiedReadModel,
  reconcileCorrelations,
  reopen,
  storeBatch,
  _dbForTest,
  _initForTest,
};
