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
const REJECTED_OBSERVATION_CODES = new Set([
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_NOTNULL',
  'SQLITE_CONSTRAINT_DATATYPE',
]);

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

function batchAck(row, replayed, acceptedObservationIds = []) {
  const ack = {
    batchId: row.batchId,
    accepted: row.acceptedCount,
    duplicate: row.duplicateCount,
    rejected: row.rejectedCount,
    receivedAt: row.receivedAt,
    replayed,
  };
  // Internal route wiring needs to avoid feeding rejected rows into derived
  // connection tables. Keep this out of the public JSON ACK.
  Object.defineProperty(ack, 'acceptedObservationIds', {
    value: Object.freeze([...acceptedObservationIds]),
    enumerable: false,
  });
  return Object.freeze(ack);
}

function isRejectedObservationError(error) {
  return REJECTED_OBSERVATION_CODES.has(error?.code);
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

    const observationExists = database.prepare(`
      SELECT 1 FROM agent_observations WHERE agentId = ? AND observationId = ?
    `);
    const insertObservation = database.prepare(`
      INSERT INTO agent_observations (
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
    const upsertAppHourly = database.prepare(`
      INSERT INTO agent_app_hourly (
        hourStart, agentId, appIdentity, processName,
        localAddress, remoteAddress, remotePort, networkProtocol,
        firstObservedAt, lastObservedAt
      ) VALUES (
        @hourStart, @agentId, @appIdentity, @processName,
        @localAddress, @remoteAddress, @remotePort, @networkProtocol,
        @firstObservedAt, @lastObservedAt
      )
      ON CONFLICT (
        hourStart, agentId, appIdentity, localAddress,
        remoteAddress, remotePort, networkProtocol
      ) DO UPDATE SET
        processName = excluded.processName,
        firstObservedAt = MIN(agent_app_hourly.firstObservedAt, excluded.firstObservedAt),
        lastObservedAt = MAX(agent_app_hourly.lastObservedAt, excluded.lastObservedAt)
    `);

    let acceptedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;
    const acceptedObservationIds = [];
    for (const observation of envelope.observations) {
      if (observationExists.get(agentId, observation.observationId)) {
        duplicateCount += 1;
        continue;
      }
      const stored = {
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
      };
      try {
        insertObservation.run(stored);
      } catch (error) {
        if (isRejectedObservationError(error)) {
          rejectedCount += 1;
          continue;
        }
        throw error;
      }
      upsertAppHourly.run({
        ...stored,
        hourStart: Math.floor(stored.lastObservedAt / 3_600_000) * 3_600_000,
        appIdentity: stored.bundleId || stored.processName,
      });
      acceptedCount += 1;
      acceptedObservationIds.push(observation.observationId);
    }

    // A rejected row must remain retryable. Recording this batch as complete
    // would make every retry replay the rejection forever, even after a Hub
    // migration adds support for the observation. Accepted rows remain
    // idempotent through their own primary key until the whole batch succeeds.
    if (rejectedCount === 0) {
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
    }

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
      rejectedCount,
      receivedAt,
    }, false, acceptedObservationIds);
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
    database.prepare('DELETE FROM agent_app_hourly WHERE lastObservedAt < ?').run(before);
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
      networkProtocol TEXT NOT NULL CHECK(networkProtocol IN ('tcp', 'udp')),
      localAddress TEXT NOT NULL, localPort INTEGER NOT NULL CHECK(localPort BETWEEN 0 AND 65535),
      remoteAddress TEXT NOT NULL, remotePort INTEGER NOT NULL CHECK(remotePort BETWEEN 1 AND 65535),
      processId INTEGER NOT NULL CHECK(processId BETWEEN 0 AND 2147483647),
      processName TEXT NOT NULL, bundleId TEXT, firstObservedAt INTEGER NOT NULL,
      lastObservedAt INTEGER NOT NULL, bytesIn TEXT, bytesOut TEXT,
      collector TEXT NOT NULL CHECK(collector IN ('network-extension', 'libproc', 'etw')),
      confidence TEXT NOT NULL CHECK(confidence IN ('exact', 'sampled')),
      receivedAt INTEGER NOT NULL, PRIMARY KEY (agentId, observationId),
      CHECK(lastObservedAt >= firstObservedAt)
    );
    CREATE TABLE agent_app_hourly (
      hourStart INTEGER NOT NULL, agentId TEXT NOT NULL, appIdentity TEXT NOT NULL,
      processName TEXT NOT NULL, localAddress TEXT NOT NULL, remoteAddress TEXT NOT NULL,
      remotePort INTEGER NOT NULL, networkProtocol TEXT NOT NULL,
      firstObservedAt INTEGER NOT NULL, lastObservedAt INTEGER NOT NULL,
      PRIMARY KEY (
        hourStart, agentId, appIdentity, localAddress,
        remoteAddress, remotePort, networkProtocol
      )
    ) WITHOUT ROWID;
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

/// Locations for destinations, as stored by enrichment.
///
/// The table is created by enrichment at startup rather than by a migration, so
/// a Hub that has never enriched anything simply has none. That is "nothing to
/// place", not a failure.
function listGeoLocations() {
  const database = requireDb();
  const hasTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'geo_cache'")
    .get();
  if (!hasTable) return [];
  return database
    .prepare(
      'SELECT ip, lat, lon, countryCode, city FROM geo_cache '
      + 'WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY ip'
    )
    .all();
}

function _dbForTest() {
  return requireDb();
}

module.exports = {
  closeDb,
  listGeoLocations,
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
