// How thorough the startup database check needs to be.
//
// The Hub ran a full `integrity_check` on every start. On the production Hub
// (3.6 GB) that held the start for minutes before anything could answer --
// the port opens within a second and then says nothing (P3-168). Measured on
// a copy of that database, under the same conditions: `integrity_check` 171 s,
// `quick_check` 4.5 s. (Both with the page cache warm; a cold start was not
// measured.) `quick_check` reads every page and checks the structure of each,
// but skips the cross-check of every index against its table, which is where
// the time goes.
//
// What it skips is damage a crash can leave half-written, so the full check is
// kept for every start that follows anything other than an orderly stop:
//
//   - The stop writes a marker, and only an orderly stop does: SIGTERM, after
//     the databases are closed. An uncaught exception, the watchdog's SIGKILL,
//     an OOM kill and a power cut all leave none.
//   - The start takes the marker and removes it straight away, so whatever
//     happens during this run, the next start does not inherit a clean bill of
//     health it did not earn.
//   - The full check runs anyway when the last one is more than a week old,
//     so a Hub that is only ever stopped cleanly is still checked in full.
//
// Anything unexpected about the marker counts as "not clean". The cost of a
// wrong "clean" is damage going unnoticed; the cost of a wrong "not clean" is
// one slow start.
'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_SUFFIX = '.clean-shutdown';
const FULL_CHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function markerPath(dbPath) {
  return `${dbPath}${MARKER_SUFFIX}`;
}

/**
 * Reads and removes the clean-shutdown marker.
 *
 * @returns {{ clean: boolean, lastFullCheckAt: number|null, reason: string }}
 */
function takeCleanShutdownMarker(dbPath, { fsImpl = fs } = {}) {
  const file = markerPath(dbPath);
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { clean: false, lastFullCheckAt: null, reason: 'the last stop was not orderly' };
    }
    return { clean: false, lastFullCheckAt: null, reason: `the marker could not be read (${error.code || error.message})` };
  }
  try {
    fsImpl.unlinkSync(file);
  } catch (error) {
    // Left in place, it would vouch for this run too, however it ends.
    return { clean: false, lastFullCheckAt: null, reason: `the marker could not be removed (${error.code || error.message})` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return { clean: false, lastFullCheckAt: null, reason: 'the marker is unreadable' };
  }
  if (!parsed || !Number.isFinite(parsed.closedAt)) {
    return { clean: false, lastFullCheckAt: null, reason: 'the marker is incomplete' };
  }
  return {
    clean: true,
    lastFullCheckAt: Number.isFinite(parsed.lastFullCheckAt) ? parsed.lastFullCheckAt : null,
    reason: 'the last stop was orderly',
  };
}

/**
 * @returns {{ mode: 'quick'|'full', reason: string }}
 */
function chooseStartupCheck(marker, { now = Date.now(), maxAgeMs = FULL_CHECK_MAX_AGE_MS } = {}) {
  if (!marker?.clean) return { mode: 'full', reason: marker?.reason || 'no record of an orderly stop' };
  if (!Number.isFinite(marker.lastFullCheckAt)) {
    return { mode: 'full', reason: 'no full check on record' };
  }
  if (now - marker.lastFullCheckAt > maxAgeMs) {
    return { mode: 'full', reason: 'the last full check is more than a week old' };
  }
  return { mode: 'quick', reason: 'the last stop was orderly and the last full check is recent' };
}

/**
 * Written only after the databases are closed, by an orderly stop.
 * Written to a temporary name and renamed, so a stop cut short cannot leave a
 * half-written marker that parses.
 */
function writeCleanShutdownMarker(dbPath, { lastFullCheckAt = null, now = Date.now(), fsImpl = fs } = {}) {
  const file = markerPath(dbPath);
  const temporary = `${file}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify({ closedAt: now, lastFullCheckAt })}\n`, { mode: 0o600 });
  fsImpl.renameSync(temporary, file);
}

/**
 * File descriptors this process still holds on the database, its -wal, -shm
 * or -journal.
 *
 * "Stopped cleanly" has to mean every connection was closed, not the ones the
 * shutdown code remembers to close. Eleven modules open their own connection
 * to the same file; the first version of the marker was written after three
 * of them had closed. Asking the operating system what is still open catches
 * the ones nobody listed -- including any added later.
 *
 * @returns {string[]|null} the paths still open, or null where the process's
 *   descriptors cannot be listed (anything but Linux). The production Hub runs
 *   on Linux.
 */
function openHandlesTo(dbPath, { fdDir = '/proc/self/fd', fsImpl = fs } = {}) {
  let entries;
  try { entries = fsImpl.readdirSync(fdDir); } catch { return null; }
  const base = path.resolve(dbPath);
  const targets = new Set(['', '-wal', '-shm', '-journal'].map(suffix => base + suffix));
  const open = [];
  for (const entry of entries) {
    let target;
    try { target = fsImpl.readlinkSync(path.join(fdDir, entry)); } catch { continue; }
    if (targets.has(target)) open.push(target);
  }
  return open;
}

module.exports = {
  openHandlesTo,
  MARKER_SUFFIX,
  FULL_CHECK_MAX_AGE_MS,
  markerPath,
  takeCleanShutdownMarker,
  chooseStartupCheck,
  writeCleanShutdownMarker,
};
