// Successful agent uploads, counted per agent and written to the audit trail
// once an hour rather than once per upload (P3-175).
//
// Every upload used to leave its own audit row. A Windows agent uploads every
// few seconds, so on 2026-09-26 that was 24,000-34,000 rows a day -- over 90%
// of the trail, 0.6 GB after two months, and on course for about 3 GB when the
// 180-day window fills. Each said only that a routine upload succeeded.
//
// What the trail is for is unchanged: every refusal and failure is still its
// own row, as is everything else a person or a credential does. An hour's
// successful uploads from one agent become one row that says how many there
// were, how much they carried, and when the first and last arrived.
//
// The counts live in memory until written. They are written when the hour
// ends, at an orderly stop, and at the latest a minute after the hour; a
// process killed outright loses at most the hour in progress. The audit table
// is append-only, so a running total cannot be kept in it.
'use strict';

const HOUR_MS = 60 * 60 * 1000;
const EVENT_TYPE = 'agent_ingest_summary';

function hourOf(at) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/**
 * @param {{ append: (event: object) => unknown, now?: () => number, windowMs?: number }} options
 */
function createIngestAuditSummary({ append, now = Date.now, windowMs = HOUR_MS } = {}) {
  if (typeof append !== 'function') throw new TypeError('append is required');
  /** @type {Map<string, object>} one entry per agent for the window in progress */
  const open = new Map();
  let timer = null;

  function windowOf(at) {
    return windowMs === HOUR_MS ? hourOf(at) : Math.floor(at / windowMs) * windowMs;
  }

  function write(entry) {
    append({
      eventType: EVENT_TYPE,
      outcome: 'success',
      authMethod: entry.authMethod,
      actor: entry.actor,
      principal: entry.principal,
      clientIp: entry.clientIp,
      httpMethod: 'POST',
      path: entry.path,
      metadata: {
        windowStart: new Date(entry.windowStart).toISOString(),
        windowEnd: new Date(entry.windowStart + windowMs).toISOString(),
        firstAt: new Date(entry.firstAt).toISOString(),
        lastAt: new Date(entry.lastAt).toISOString(),
        uploads: entry.uploads,
        observationCount: entry.observationCount,
        acceptedCount: entry.acceptedCount,
        duplicateCount: entry.duplicateCount,
        replayedCount: entry.replayedCount,
        maxDurationMs: entry.maxDurationMs,
      },
    });
  }

  /** Writes every window that has ended, or every window when `force`. */
  function flush({ force = false } = {}) {
    const current = windowOf(now());
    let written = 0;
    for (const [key, entry] of open) {
      if (!force && entry.windowStart >= current) continue;
      write(entry);
      open.delete(key);
      written += 1;
    }
    return written;
  }

  function ensureTimer() {
    if (timer) return;
    // A minute's slack: an hour's row is written within a minute of the hour
    // ending even when no upload arrives to trigger it.
    timer = setInterval(() => flush(), 60 * 1000);
    timer.unref?.();
  }

  /**
   * Counts one successful upload.
   *
   * @param {{ authMethod?: string, actor?: string, principal?: string, clientIp?: string, path?: string }} who
   * @param {{ observationCount: number, acceptedCount: number, duplicateCount: number,
   *           replayed?: boolean, durationMs?: number }} upload
   */
  function record(who, upload) {
    const at = now();
    const windowStart = windowOf(at);
    const key = who.principal || who.actor || 'unknown';
    let entry = open.get(key);
    if (entry && entry.windowStart !== windowStart) {
      // The previous hour for this agent has ended: it is written before the
      // new one starts, so rows appear in order.
      write(entry);
      entry = null;
    }
    if (!entry) {
      entry = {
        windowStart, firstAt: at, lastAt: at,
        authMethod: who.authMethod, actor: who.actor, principal: who.principal,
        clientIp: who.clientIp, path: who.path,
        uploads: 0, observationCount: 0, acceptedCount: 0, duplicateCount: 0,
        replayedCount: 0, maxDurationMs: 0,
      };
      open.set(key, entry);
    }
    entry.lastAt = at;
    // The address the agent is at now, if it moved within the hour.
    entry.clientIp = who.clientIp ?? entry.clientIp;
    entry.uploads += 1;
    entry.observationCount += upload.observationCount || 0;
    entry.acceptedCount += upload.acceptedCount || 0;
    entry.duplicateCount += upload.duplicateCount || 0;
    if (upload.replayed) entry.replayedCount += 1;
    entry.maxDurationMs = Math.max(entry.maxDurationMs, upload.durationMs || 0);
    ensureTimer();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return flush({ force: true });
  }

  return { record, flush, stop, pending: () => open.size };
}

module.exports = { createIngestAuditSummary, EVENT_TYPE };
