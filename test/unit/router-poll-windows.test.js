'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { recordPoll, pollGaps, prune } = require('../../src/router-poll-windows');
const { BUCKET_MS } = require('../../src/connection-buckets');

// P3-157. A window in which no router answered drew the same bar as a window
// in which nothing was sent, and those mean opposite things: "not known" and
// "nothing left the network". A user read steady traffic off a chart covering
// three minutes in which their machine was down.
let db;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % BUCKET_MS);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE router_poll_windows (
      routerId    TEXT    NOT NULL,
      bucketStart INTEGER NOT NULL,
      polls       INTEGER NOT NULL DEFAULT 0,
      failures    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (routerId, bucketStart)
    ) WITHOUT ROWID;
  `);
});

function pollEvery(minutes, { ok = true, router = 'r1', from = T0 } = {}) {
  for (let i = 0; i < minutes; i += 1) recordPoll(db, router, from + i * 60_000, { ok });
}

describe('router poll windows', () => {
  it('counts the answers and the failures of a window separately', () => {
    recordPoll(db, 'r1', T0 + 1_000, { ok: true });
    recordPoll(db, 'r1', T0 + 61_000, { ok: false });
    recordPoll(db, 'r1', T0 + 121_000, { ok: true });
    const row = db.prepare('SELECT * FROM router_poll_windows').get();
    assert.deepEqual(
      { bucketStart: row.bucketStart, polls: row.polls, failures: row.failures },
      { bucketStart: T0, polls: 2, failures: 1 }
    );
  });

  it('reports the windows in which no router answered', () => {
    pollEvery(30);
    // Ten minutes, two windows, in which every attempt failed.
    for (let i = 30; i < 40; i += 1) recordPoll(db, 'r1', T0 + i * 60_000, { ok: false });
    pollEvery(20, { from: T0 + 40 * 60_000 });

    const gaps = pollGaps(db, { from: T0, to: T0 + 60 * 60_000, now: T0 + 61 * 60_000 });
    assert.deepEqual(gaps, [{ from: T0 + 30 * 60_000, to: T0 + 40 * 60_000 }]);
  });

  // The Hub being down is the case that started this: nothing is written at
  // all, so a gap has to be the absence of an answer, not a recorded failure.
  it('reports a window nothing was written for at all', () => {
    pollEvery(10);
    pollEvery(10, { from: T0 + 20 * 60_000 });
    const gaps = pollGaps(db, { from: T0, to: T0 + 30 * 60_000, now: T0 + 31 * 60_000 });
    assert.deepEqual(gaps, [{ from: T0 + 10 * 60_000, to: T0 + 20 * 60_000 }]);
  });

  it('does not call a window a gap when another router answered in it', () => {
    pollEvery(30, { router: 'r1' });
    for (let i = 10; i < 20; i += 1) recordPoll(db, 'r1', T0 + i * 60_000, { ok: false });
    pollEvery(30, { router: 'r2' });
    assert.deepEqual(pollGaps(db, { from: T0, to: T0 + 30 * 60_000, now: T0 + 31 * 60_000 }), []);
  });

  // Hatching everything that predates the feature would report an outage where
  // there was only no measurement -- a worse lie than the one being fixed.
  it('says nothing about time before the first window it recorded', () => {
    pollEvery(10, { from: T0 + 60 * 60_000 });
    const gaps = pollGaps(db, {
      from: T0 - 24 * 60 * 60_000, to: T0 + 70 * 60_000, now: T0 + 71 * 60_000,
    });
    assert.deepEqual(gaps, []);
  });

  // The newest window is still open. One failed poll in it does not mean the
  // window has no record -- the next attempt is a minute away and may well
  // succeed. Reporting it straight away puts a band on the right edge of the
  // chart every time a single poll times out.
  it('does not call the window in progress a gap', () => {
    pollEvery(10);
    const now = T0 + 11 * 60_000;
    recordPoll(db, 'r1', T0 + 10 * 60_000 + 30_000, { ok: false });
    assert.deepEqual(pollGaps(db, { from: T0, to: now, now }), []);

    // Once it has closed without an answer, it is a gap.
    const later = T0 + 16 * 60_000;
    assert.deepEqual(
      pollGaps(db, { from: T0, to: later, now: later }),
      [{ from: T0 + 10 * 60_000, to: T0 + 15 * 60_000 }]
    );
  });

  it('holds the gap open to the end of the record when it never recovers', () => {
    pollEvery(10);
    for (let i = 10; i < 25; i += 1) recordPoll(db, 'r1', T0 + i * 60_000, { ok: false });
    const gaps = pollGaps(db, { from: T0, to: T0 + 30 * 60_000, now: T0 + 26 * 60_000 });
    assert.deepEqual(gaps, [{ from: T0 + 10 * 60_000, to: T0 + 25 * 60_000 }]);
  });

  it('drops windows past retention', () => {
    recordPoll(db, 'r1', T0 - 20 * 24 * 60 * 60_000, { ok: true });
    recordPoll(db, 'r1', T0, { ok: true });
    assert.equal(prune(db, { now: T0 + 60_000 }), 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM router_poll_windows').get().n, 1);
  });
});
