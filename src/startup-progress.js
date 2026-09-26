// How far a long database check has got, for the page shown while the Hub
// starts (P3-173).
//
// The check is one synchronous SQLite call that says nothing until it ends --
// 346 s on the production database at the start of 2026-09-26, with the page
// showing the same sentence throughout. It cannot be split per table without
// weakening it: SQLite's per-table check skips the freelist and the pages no
// table uses, which only the whole-database check verifies.
//
// What can be watched from outside is how much the process has read. The
// check reads the database from start to end, so the bytes read since it
// began say how far through it is -- but not as a share of the file: measured
// on the production server, a quick_check read 1.9 times the file's size. So
// the estimate is the previous check of the same kind, scaled by how much the
// file has grown since. The first check on a machine has no estimate and shows
// only the amount read.
'use strict';

const fs = require('fs');

const PROC_IO = '/proc/self/io';

/**
 * Bytes this process has read through read(2) and friends, from any thread.
 * `rchar` counts reads served from the page cache as well as from disk, which
 * is what a check that finds its pages already cached still does.
 *
 * @returns {number | null} null where the kernel does not report it (macOS).
 */
function bytesRead({ path = PROC_IO, readFileSync = fs.readFileSync } = {}) {
  try {
    const match = /^rchar:\s*(\d+)/m.exec(readFileSync(path, 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** The database file and its -wal: both are read by a check. */
function databaseBytes(dbPath) {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try { total += fs.statSync(dbPath + suffix).size; } catch { /* not there */ }
  }
  return total;
}

function recordPath(dbPath) {
  return `${dbPath}.startup-check.json`;
}

function readRecord(dbPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(dbPath), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * How many bytes a check of this kind is expected to read, from the last one.
 *
 * @param {'quick' | 'full'} mode
 * @returns {number | null} null with no usable previous check.
 */
function expectedBytes(dbPath, mode, currentDbBytes) {
  const last = readRecord(dbPath)[mode];
  if (!last || !(last.bytesRead > 0) || !(last.dbBytes > 0) || !(currentDbBytes > 0)) return null;
  return Math.round(last.bytesRead * (currentDbBytes / last.dbBytes));
}

/**
 * Keeps what a finished check read, for the next start's estimate. Written
 * only for a check that completed: one that found damage or failed is no
 * guide to how long a sound one takes. Never throws -- a missing estimate is
 * a smaller page, not a reason to stop the start.
 */
function recordCheck(dbPath, mode, { bytesRead: read, dbBytes, ms }) {
  if (!(read > 0) || !(dbBytes > 0)) return false;
  try {
    const record = readRecord(dbPath);
    record[mode] = { bytesRead: read, dbBytes, ms, at: new Date().toISOString() };
    const file = recordPath(dbPath);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a synchronous check and tells `onProgress` where the reading starts
 * and how much it is expected to be, so the startup page can follow it.
 *
 * @template T
 * @param {{ dbPath: string, mode: 'quick' | 'full', phase: string,
 *           onProgress?: (phase: string, detail?: object) => void }} options
 * @param {() => T} run  the check; its result decides whether it is recorded
 * @param {(result: T) => boolean} succeeded
 * @returns {T}
 */
function followCheck({ dbPath, mode, phase, onProgress, read = bytesRead }, run, succeeded) {
  const onDisk = Boolean(dbPath) && dbPath !== ':memory:';
  const dbBytes = onDisk ? databaseBytes(dbPath) : 0;
  const readBase = read();
  onProgress?.(phase, {
    mode,
    readBase,
    expectedBytes: onDisk ? expectedBytes(dbPath, mode, dbBytes) : null,
  });
  const startedAt = Date.now();
  const result = run();
  const readEnd = read();
  if (onDisk && readBase != null && readEnd != null && succeeded(result)) {
    recordCheck(dbPath, mode, { bytesRead: readEnd - readBase, dbBytes, ms: Date.now() - startedAt });
  }
  return result;
}

module.exports = {
  bytesRead,
  databaseBytes,
  expectedBytes,
  recordCheck,
  followCheck,
  recordPath,
};
