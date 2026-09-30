'use strict';

// The database thread. It opens its own connection to the Hub's database and
// does the work that used to hold the main thread: first the retention delete
// of agent observations (P3-182), later the other heavy jobs.
//
// Requests come in as { id, op, args } and each gets exactly one reply,
// { id, ok, result } or { id, ok: false, error }. Requests run one at a time,
// in the order they arrive, because they share one connection.

const { parentPort, workerData } = require('node:worker_threads');
const agentIngest = require('./agent-ingest-store');

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

function open(dbPath) {
  agentIngest.reopen(dbPath);
}

function close() {
  agentIngest.closeDb();
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
  open: ({ dbPath }) => { open(dbPath); return { opened: true }; },
  close: () => { close(); return { closed: true }; },
  'agentIngest.prune': pruneAgentObservations,
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
  if (workerData?.dbPath) open(workerData.dbPath);
  parentPort.on('message', message => parentPort.postMessage(handle(message)));
}

module.exports = { handle, pruneAgentObservations, PASS_GAP_MS, MAX_PASSES_PER_RUN };
