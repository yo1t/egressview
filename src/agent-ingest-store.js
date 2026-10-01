'use strict';

const runtimeProfiler = require('./runtime-profiler');

const path = require('node:path');
const Database = require('better-sqlite3');
const { applyWalPragmas } = require('./sqlite-wal');
const {
  buildUnifiedReadModel,
  createAgentCorrelation,
  DEFAULT_CORRELATION_WINDOW_MS,
} = require('./agent-correlation');

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
  applyWalPragmas(db);
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

function batchAck(row, replayed, acceptedObservationIds = [], completedCount = 0) {
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
  // How many of the duplicates completed a stored row (P3-170). Counted in
  // `duplicate` for the agent, whose check is accepted + duplicate = sent, and
  // kept out of the JSON the agent reads.
  Object.defineProperty(ack, 'completed', { value: completedCount, enumerable: false });
  return Object.freeze(ack);
}

function isRejectedObservationError(error) {
  return REJECTED_OBSERVATION_CODES.has(error?.code);
}

// How many observations are written before the loop gets a turn.
//
// A whole batch in one transaction is up to 200 observations and was measured
// on the Hub at 71 to 149 ms -- time during which nothing else on the Hub can
// run, including /healthz. That figure does not grow with the number of agents;
// it is set by the batch size, so it is the same jank on a Hub with three
// agents and one with three hundred. Fifty is about 37 ms at the measured 0.75
// ms an observation, which is under the event-loop budget P3-139 was fought
// for.
//
// The batch stops being written atomically, and that is safe here by
// construction rather than by luck: an observation carries its own primary key
// and a repeat is counted as a duplicate, and `agent_ingest_batches` is written
// only once every chunk is in. A Hub that dies halfway leaves observations with
// no batch row, the agent resends the same batchId, and the second attempt
// counts what is already there as duplicates and finishes the job.
const OBSERVATIONS_PER_CHUNK = 50;

function yieldToLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Whether a repeated observation id is the closing report of the flow stored
 * under it, carrying the byte counts the stored row does not have (P3-170).
 *
 * Only then is the row updated. Anything else with a known id -- a retry of
 * the same report, a second report with counts, or a report whose protocol,
 * destination or process is not the stored one -- stays a plain duplicate, so
 * an agent can never rewrite a different connection's row through an id it
 * reused.
 */
function completesStoredObservation(stored, observation) {
  if (stored.bytesIn != null || stored.bytesOut != null) return false;
  if (observation.bytesIn == null && observation.bytesOut == null) return false;
  return stored.networkProtocol === observation.networkProtocol
    && stored.remoteAddress === observation.remoteAddress
    && stored.remotePort === observation.remotePort
    && stored.processId === observation.processID
    && (stored.localPort === 0 || stored.localPort === observation.localPort);
}

const UNSPECIFIED_ADDRESSES = new Set(['0.0.0.0', '::', '']);

/**
 * Whether an observation says which local address and port its flow left
 * from. A Mac agent's opening report often does not: the flow is seen before
 * the system has chosen them, and on one Mac on 2026-09-27 that was 93% of
 * TCP flows. Without them the flow cannot be matched to the router's record.
 */
function hasLocalEndpoint(observation) {
  return observation.localPort !== 0 && !UNSPECIFIED_ADDRESSES.has(observation.localAddress);
}

/**
 * Store one agent batch.
 *
 * Asynchronous because it gives the event loop a turn between chunks; the work
 * itself is synchronous SQLite, so the chunk is what bounds the pause.
 */
async function storeBatch(agentId, envelope, { receivedAt = Date.now() } = {}) {
  const database = requireDb();
  if (!Number.isFinite(receivedAt)) throw new TypeError('receivedAt must be finite');

  const existing = database.prepare(`
    SELECT batchId, acceptedCount, duplicateCount, rejectedCount, receivedAt
    FROM agent_ingest_batches WHERE agentId = ? AND batchId = ?
  `).get(agentId, envelope.batchId);
  if (existing) return batchAck(existing, true);

  const storedObservation = database.prepare(`
    SELECT networkProtocol, localAddress, localPort, remoteAddress, remotePort, processId,
           processName, bundleId, firstObservedAt, lastObservedAt, bytesIn, bytesOut, remoteHostname
    FROM agent_observations WHERE agentId = ? AND observationId = ?
  `);
  // The closing report of a flow, sent under the observation id of its opening
  // report (P3-170). The row gains the counts it could not have had when the
  // flow opened; nothing else about the flow is taken from the second report.
  const completeObservation = database.prepare(`
    UPDATE agent_observations
    SET bytesIn = @bytesIn, bytesOut = @bytesOut,
        lastObservedAt = MAX(lastObservedAt, @lastObservedAt),
        localAddress = @localAddress, localPort = @localPort,
        remoteHostname = COALESCE(remoteHostname, @remoteHostname)
    WHERE agentId = @agentId AND observationId = @observationId
      AND bytesIn IS NULL AND bytesOut IS NULL
  `);
  const insertObservation = database.prepare(`
    INSERT INTO agent_observations (
      agentId, observationId, batchId, networkProtocol,
      localAddress, localPort, remoteAddress, remotePort,
      processId, processName, bundleId,
      firstObservedAt, lastObservedAt, bytesIn, bytesOut,
      collector, confidence, receivedAt, remoteHostname
    ) VALUES (
      @agentId, @observationId, @batchId, @networkProtocol,
      @localAddress, @localPort, @remoteAddress, @remotePort,
      @processId, @processName, @bundleId,
      @firstObservedAt, @lastObservedAt, @bytesIn, @bytesOut,
      @collector, @confidence, @receivedAt, @remoteHostname
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
  let completedCount = 0;
  let rejectedCount = 0;
  const acceptedObservationIds = [];

  const writeChunk = database.transaction((chunk) => {
    for (const observation of chunk) {
      const stored = storedObservation.get(agentId, observation.observationId);
      if (stored) {
        duplicateCount += 1;
        if (completesStoredObservation(stored, observation)) {
          // The closing report knows the local endpoint an opening report
          // taken before the connection was made did not. One already stored
          // is kept; address and port move together.
          const endpoint = !hasLocalEndpoint(stored) && hasLocalEndpoint(observation)
            ? observation : stored;
          completeObservation.run({
            agentId,
            observationId: observation.observationId,
            bytesIn: observation.bytesIn ?? null,
            bytesOut: observation.bytesOut ?? null,
            lastObservedAt: Date.parse(observation.lastObservedAt),
            localAddress: endpoint.localAddress,
            localPort: endpoint.localPort,
            remoteHostname: observation.remoteHostname ?? null,
          });
          // The flow may now end in a later hour than its opening said.
          const lastObservedAt = Math.max(stored.lastObservedAt, Date.parse(observation.lastObservedAt));
          upsertAppHourly.run({
            agentId,
            hourStart: Math.floor(lastObservedAt / 3_600_000) * 3_600_000,
            appIdentity: stored.bundleId || stored.processName,
            processName: stored.processName,
            localAddress: endpoint.localAddress,
            remoteAddress: stored.remoteAddress,
            remotePort: stored.remotePort,
            networkProtocol: stored.networkProtocol,
            firstObservedAt: stored.firstObservedAt,
            lastObservedAt,
          });
          completedCount += 1;
        }
        continue;
      }
      const row = {
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
        // Absent and null mean the same thing here -- the agent had no name
        // for this flow -- and both must reach SQLite as NULL rather than
        // undefined, which better-sqlite3 refuses to bind (P3-14 stage 2).
        remoteHostname: observation.remoteHostname ?? null,
      };
      try {
        insertObservation.run(row);
      } catch (error) {
        if (isRejectedObservationError(error)) {
          rejectedCount += 1;
          continue;
        }
        throw error;
      }
      upsertAppHourly.run({
        ...row,
        hourStart: Math.floor(row.lastObservedAt / 3_600_000) * 3_600_000,
        appIdentity: row.bundleId || row.processName,
      });
      acceptedCount += 1;
      acceptedObservationIds.push(observation.observationId);
    }
  });

  const observations = envelope.observations;
  for (let i = 0; i < observations.length; i += OBSERVATIONS_PER_CHUNK) {
    if (i > 0) await yieldToLoop();
    const chunk = observations.slice(i, i + OBSERVATIONS_PER_CHUNK);
    runtimeProfiler.measureSync('agentIngest.chunk', () => writeChunk.immediate(chunk));
  }

  const finish = database.transaction(() => {
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
  });
  if (observations.length > OBSERVATIONS_PER_CHUNK) await yieldToLoop();
  runtimeProfiler.measureSync('agentIngest.finish', () => finish.immediate());

  // Correlation deliberately does not run here. It used to, once per ingest,
  // and because it passed no `since` it re-examined the newest 5,000
  // uncorrelated observations every time. An agent-only flow never gets a link
  // row, so it never leaves that set: the same rows were reclassified on every
  // batch forever. With ~1.9M stored observations that turned a small write
  // into 3-6s of synchronous work, and better-sqlite3 is synchronous, so the
  // whole server stalled behind an agent's routine upload -- /healthz included.
  // The ACK only promises durability, and the periodic runner reconciles on its
  // own schedule, so this side effect never belonged in the response path.
  return batchAck({
    batchId: envelope.batchId,
    acceptedCount,
    duplicateCount,
    rejectedCount,
    receivedAt,
  }, false, acceptedObservationIds, completedCount);
}

// How much one call deletes: rows per transaction, and how long it may keep
// going before handing the event loop back. A day of agent observations is
// about 460,000 rows with eight indexes. Deleted in one transaction, that held
// the loop for over 120 seconds, the watchdog killed the Hub, the delete rolled
// back, and the restart spent 505 seconds on an integrity check -- about eleven
// minutes without the Hub, every night, and the rows still there.
//
// The batch size adapts to the disk rather than being guessed: the same day
// took 7.4 seconds on a development Mac and over 120 on the production
// instance. Each observation batch aims at PRUNE_TARGET_MS; one that takes
// longer halves the next, one well under it doubles the next.
const PRUNE_BUDGET_MS = 200;
const PRUNE_TARGET_MS = 100;
const PRUNE_BATCH_MIN = 50;
const PRUNE_BATCH_MAX = 5000;
let adaptivePruneBatch = 500;

function adaptPruneBatch(size, elapsedMs, { targetMs = PRUNE_TARGET_MS, maxBatch = PRUNE_BATCH_MAX } = {}) {
  if (elapsedMs > targetMs) return Math.max(PRUNE_BATCH_MIN, Math.floor(size / 2));
  if (elapsedMs < targetMs / 4) return Math.min(maxBatch, size * 2);
  return size;
}

/**
 * Deletes agent observations older than `before`, with their correlation
 * links, the hourly attribution rows they fed, and batch receipts nothing
 * refers to any more.
 *
 * Works in small transactions and stops when its time budget is spent,
 * reporting `more: true`; the caller runs it again soon. Observations go
 * first, because a batch receipt can only go once no observation points at it.
 *
 * `timings` says where the time went, so a slow pass can be told apart: the
 * observation deletes, the hourly rows, the batch receipts, and the slowest
 * single transaction among them (the longest a writer elsewhere had to wait).
 *
 * @returns {{ correlations: number, observations: number, hourly: number,
 *   batches: number, more: boolean, timings: { observationsMs: number,
 *   hourlyMs: number, receiptsMs: number, slowestTransactionMs: number } }}
 */
function pruneObservations({
  before, batchSize, budgetMs = PRUNE_BUDGET_MS, now = Date.now,
  targetMs = PRUNE_TARGET_MS, maxBatch = PRUNE_BATCH_MAX,
} = {}) {
  const database = requireDb();
  if (!Number.isFinite(before)) throw new TypeError('before must be finite');
  const startedAt = now();
  const outOfTime = () => now() - startedAt >= budgetMs;
  const timings = { observationsMs: 0, hourlyMs: 0, receiptsMs: 0, slowestTransactionMs: 0 };
  const result = { correlations: 0, observations: 0, hourly: 0, batches: 0, more: false, timings };
  // Runs one transaction and charges its time to a phase.
  const timed = (phase, run) => {
    const began = now();
    const value = run();
    const elapsed = now() - began;
    timings[phase] += elapsed;
    timings.slowestTransactionMs = Math.max(timings.slowestTransactionMs, elapsed);
    return value;
  };

  const pickObservations = database.prepare(`
    SELECT rowid AS id, agentId, observationId FROM agent_observations
    WHERE lastObservedAt < ? LIMIT ?
  `);
  const unlink = database.prepare(
    'DELETE FROM connection_agent_observations WHERE agentId = ? AND observationId = ?'
  );
  const dropObservation = database.prepare('DELETE FROM agent_observations WHERE rowid = ?');
  // A caller that names a size gets exactly that size (tests do); otherwise
  // the size carries over between calls and follows the disk.
  const fixedSize = Number.isInteger(batchSize) && batchSize > 0;
  // A caller that holds the write lock against someone else's writes (the
  // database thread, P3-184) asks for smaller transactions: there, how long
  // one transaction keeps the lock matters more than how fast the whole run
  // finishes.
  let size = fixedSize ? batchSize : Math.min(adaptivePruneBatch, maxBatch);
  const observationBatch = database.transaction(() => {
    const rows = pickObservations.all(before, size);
    for (const row of rows) {
      result.correlations += unlink.run(row.agentId, row.observationId).changes;
      result.observations += dropObservation.run(row.id).changes;
    }
    return rows.length;
  });
  for (;;) {
    const batchStartedAt = now();
    const deleted = timed('observationsMs', () => observationBatch.immediate());
    const full = deleted >= size;
    if (!fixedSize) {
      size = adaptPruneBatch(size, now() - batchStartedAt, { targetMs, maxBatch });
      adaptivePruneBatch = size;
    }
    if (!full) break;
    if (outOfTime()) { result.more = true; return result; }
  }

  // An hour at a time, oldest first. The hour leads the primary key, so each
  // delete is a range read; filtering on lastObservedAt alone read the whole
  // table. An hour row can only be past `before` if its hour started before it.
  const nextHour = database.prepare(
    'SELECT MIN(hourStart) AS hour FROM agent_app_hourly WHERE hourStart > ?'
  );
  // An hour in pieces of the batch size: one busy hour was 1.0-1.3 s in a
  // single transaction on 2026-10-01, long enough to stall the main thread's
  // writes waiting for the lock. The table has no rowid, so the pieces are
  // picked by primary key.
  const dropHourPiece = database.prepare(`
    DELETE FROM agent_app_hourly
    WHERE (hourStart, agentId, appIdentity, localAddress, remoteAddress, remotePort, networkProtocol) IN (
      SELECT hourStart, agentId, appIdentity, localAddress, remoteAddress, remotePort, networkProtocol
      FROM agent_app_hourly WHERE hourStart = ? AND lastObservedAt < ? LIMIT ?
    )
  `);
  const hourPiece = fixedSize ? batchSize : Math.min(size, maxBatch);
  for (let cursor = -Infinity; ;) {
    const hour = nextHour.get(cursor)?.hour;
    if (hour == null || hour >= before) break;
    for (;;) {
      const deleted = timed('hourlyMs',
        () => database.transaction(() => dropHourPiece.run(hour, before, hourPiece).changes).immediate());
      result.hourly += deleted;
      if (deleted < hourPiece) break;
      if (outOfTime()) { result.more = true; return result; }
    }
    cursor = hour;
    if (outOfTime()) { result.more = true; return result; }
  }

  // Agent by agent, so the receipt lookup uses (agentId, receivedAt) instead
  // of reading every receipt.
  const nextAgent = database.prepare(
    'SELECT MIN(agentId) AS agentId FROM agent_ingest_batches WHERE agentId > ?'
  );
  const dropBatches = database.prepare(`
    DELETE FROM agent_ingest_batches WHERE rowid IN (
      SELECT b.rowid FROM agent_ingest_batches b
      WHERE b.agentId = ? AND b.receivedAt < ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_observations o
          WHERE o.agentId = b.agentId AND o.batchId = b.batchId
        )
      LIMIT ?
    )
  `);
  for (let cursor = ''; ;) {
    const agentId = nextAgent.get(cursor)?.agentId;
    if (agentId == null) break;
    for (;;) {
      const deleted = timed('receiptsMs', () => database.transaction(
        () => dropBatches.run(agentId, before, size).changes
      ).immediate());
      result.batches += deleted;
      if (deleted < size) break;
      if (outOfTime()) { result.more = true; return result; }
    }
    cursor = agentId;
    if (outOfTime()) { result.more = true; return result; }
  }
  return result;
}

/**
 * Copies what it can of the write-ahead log back into the database, without
 * waiting for anyone (PASSIVE). Run on the database thread after each prune
 * pass, so the write-back of a delete is paid there rather than by whichever
 * connection's commit next crosses the automatic threshold.
 */
function checkpointLog({ now = Date.now } = {}) {
  const began = now();
  const [row] = requireDb().pragma('wal_checkpoint(PASSIVE)');
  return {
    ms: now() - began,
    busy: row?.busy ?? null,
    logFrames: row?.log ?? null,
    checkpointedFrames: row?.checkpointed ?? null,
  };
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
      receivedAt INTEGER NOT NULL,
      remoteHostname TEXT CHECK(remoteHostname IS NULL OR length(remoteHostname) BETWEEN 1 AND 253),
      PRIMARY KEY (agentId, observationId),
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
    -- Mirrors the migration. Attribution names this index with INDEXED BY to
    -- stop the planner entering the join from the wrong side, and a query that
    -- names an index does not run at all where the index is absent -- so a
    -- schema here that drifts from the migration fails the test rather than
    -- quietly testing a different plan than production runs.
    CREATE INDEX idx_connection_agent_observation
      ON connection_agent_observations(agentId, observationId);
    CREATE INDEX idx_connection_agent_connection
      ON connection_agent_observations(src, dst, dport, proto);
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
  OBSERVATIONS_PER_CHUNK,
  closeDb,
  listGeoLocations,
  initDb,
  getAgentCollectionStatus,
  getCorrelationDiagnostics,
  pruneObservations,
  checkpointLog,
  _adaptPruneBatchForTest: adaptPruneBatch,
  queryCorrelationReadModel,
  queryUnifiedReadModel,
  reconcileCorrelations,
  reopen,
  storeBatch,
  _dbForTest,
  _initForTest,
};
