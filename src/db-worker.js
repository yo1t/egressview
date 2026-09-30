'use strict';

// A database thread. It opens its own connection to the Hub's database and
// does work that used to hold the main thread (P3-184). It has one of two
// roles, fixed when it starts:
//
//   - maintenance: the retention delete of agent observations (P3-182).
//   - read: the connection log's heavy reads, on a read-only connection, so a
//     slow query stops the person who asked for it and no one else.
//
// They are separate threads so a long delete never queues a page behind it.
//
// Requests come in as { id, op, args } and each gets exactly one reply,
// { id, ok, result } or { id, ok: false, error }. Requests run one at a time,
// in the order they arrive, because they share one connection.

const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const agentIngest = require('./agent-ingest-store');
const { createHistoryQueries } = require('./history-queries');
const { summarizeAppGroups } = require('./app-classifier');
const { routerKindForId } = require('./router-id');
const {
  connectionReadColumns, normalizeObservedBy, createRowHydration,
} = require('./connection-rows');

// Between passes of a long delete. The main thread writes to the same file,
// and SQLite lets one connection write at a time: without a gap a delete
// that has work left would take the lock again at once, and an upload waiting
// in its busy handler could keep missing it.
const PASS_GAP_MS = 250;
// Enough passes to clear one ordinary run (about 20 today) and the backlog
// after a day away, without holding the thread for hours if something is
// wrong. The caller comes back later for the rest.
const MAX_PASSES_PER_RUN = 2000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The reads the read role answers. Named here so a message cannot call any
// other function on the query object.
const HISTORY_READS = new Set([
  'queryByTimeRangePaged',
  'countByTimeRange',
  'groupDstByTimeRange',
  'summarizeByTimeRange',
]);

let role = 'maintenance';
let reader = null;

function openReader(dbPath, sourceRouterMap = {}) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  // Read per request: a router added while the Hub runs is in the table, not
  // in this thread's memory.
  let kinds = new Map();
  const rows = createRowHydration({
    routerKind: id => kinds.get(id) || routerKindForId(id, sourceRouterMap),
  });
  const queries = createHistoryQueries({
    getDb: () => db,
    getDbPath: () => dbPath,
    Database,
    connectionReadColumns,
    hydrateConnectionRows: rows.hydrateConnectionRows,
    normalizeObservedBy,
    compatibilitySource: rows.compatibilitySource,
    summarizeAppGroups,
  });
  const refreshKinds = () => {
    kinds = new Map(db.prepare('SELECT id, kind FROM routers').all().map(row => [row.id, row.kind]));
  };
  return { db, queries, refreshKinds };
}

function open(dbPath, options = {}) {
  role = options.role === 'read' ? 'read' : 'maintenance';
  if (role === 'read') {
    reader?.db.close();
    reader = openReader(dbPath, options.sourceRouterMap);
  } else {
    agentIngest.reopen(dbPath);
  }
}

function close() {
  if (role === 'read') {
    reader?.db.close();
    reader = null;
  } else {
    agentIngest.closeDb();
  }
}

function readHistory({ fn, args = [] }) {
  if (!HISTORY_READS.has(fn)) throw new Error(`Not a history read: ${fn}`);
  if (!reader) throw new Error('The read thread has no database open');
  reader.refreshKinds();
  return reader.queries[fn](...args);
}

function pruneAgentObservations({ before }) {
  const totals = {
    observations: 0, correlations: 0, hourly: 0, batches: 0, passes: 0, more: false,
    observationsMs: 0, hourlyMs: 0, receiptsMs: 0, slowestTransactionMs: 0,
    checkpointMs: 0, slowestCheckpointMs: 0, logFramesAtEnd: null,
  };
  for (;;) {
    const pass = agentIngest.pruneObservations({ before });
    totals.passes += 1;
    for (const key of ['observations', 'correlations', 'hourly', 'batches']) totals[key] += pass[key];
    for (const key of ['observationsMs', 'hourlyMs', 'receiptsMs']) totals[key] += pass.timings[key];
    totals.slowestTransactionMs = Math.max(totals.slowestTransactionMs, pass.timings.slowestTransactionMs);
    // Written back here, after each pass: a delete fills the log quickly, and
    // left to the automatic checkpoint the main thread's next upload could be
    // the commit that pays for it.
    const written = agentIngest.checkpointLog();
    totals.checkpointMs += written.ms;
    totals.slowestCheckpointMs = Math.max(totals.slowestCheckpointMs, written.ms);
    totals.logFramesAtEnd = written.logFrames;
    if (!pass.more) break;
    if (totals.passes >= MAX_PASSES_PER_RUN) { totals.more = true; break; }
    sleep(PASS_GAP_MS);
  }
  return totals;
}

const operations = {
  close: () => { close(); return { closed: true }; },
  'agentIngest.prune': pruneAgentObservations,
  'history.read': readHistory,
};

function handle({ id, op, args }) {
  const operation = operations[op];
  if (!operation) return { id, ok: false, error: `Unknown database operation: ${op}` };
  try {
    return { id, ok: true, result: operation(args || {}) };
  } catch (error) {
    return { id, ok: false, error: error?.message || String(error), code: error?.code };
  }
}

if (parentPort) {
  if (workerData?.dbPath) open(workerData.dbPath, workerData);
  parentPort.on('message', message => parentPort.postMessage(handle(message)));
}

module.exports = {
  handle, open, close, pruneAgentObservations, HISTORY_READS, PASS_GAP_MS, MAX_PASSES_PER_RUN,
};
