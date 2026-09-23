'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  FULL_CHECK_MAX_AGE_MS,
  markerPath,
  takeCleanShutdownMarker,
  chooseStartupCheck,
  writeCleanShutdownMarker,
} = require('../../src/db-startup-check');
const { checkLiveDatabase } = require('../../src/db-restore');

// The production Hub ran a full integrity_check on every start: 171 s on a
// copy of its 3.6 GB database, against 4.5 s for quick_check. The quick check
// is only safe after an orderly stop, and the rule these tests hold is that
// nothing else -- a crash, the watchdog, a marker that is odd in any way --
// ever earns it.

let dir;
let db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-check-'));
  db = path.join(dir, 'hub.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;

describe('the clean-shutdown marker', () => {
  it('is absent after a stop that was not orderly', () => {
    const marker = takeCleanShutdownMarker(db);
    assert.equal(marker.clean, false);
  });

  it('is read and removed at start, so this run cannot inherit it', () => {
    writeCleanShutdownMarker(db, { lastFullCheckAt: 1_000, now: 2_000 });
    const marker = takeCleanShutdownMarker(db);
    assert.equal(marker.clean, true);
    assert.equal(marker.lastFullCheckAt, 1_000);
    assert.equal(fs.existsSync(markerPath(db)), false, 'the marker is still there for the next start');
  });

  it('counts as not clean when it cannot be parsed, and is still removed', () => {
    fs.writeFileSync(markerPath(db), '{"closedAt": 12');
    assert.equal(takeCleanShutdownMarker(db).clean, false);
    assert.equal(fs.existsSync(markerPath(db)), false);
  });

  it('counts as not clean when it lacks the time of the stop', () => {
    fs.writeFileSync(markerPath(db), JSON.stringify({ lastFullCheckAt: 1 }));
    assert.equal(takeCleanShutdownMarker(db).clean, false);
  });

  // Left in place, it would vouch for this run too, however it ends.
  it('counts as not clean when it cannot be removed', () => {
    writeCleanShutdownMarker(db, { lastFullCheckAt: 1_000, now: 2_000 });
    const fsImpl = { ...fs, unlinkSync() { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } };
    const marker = takeCleanShutdownMarker(db, { fsImpl });
    assert.equal(marker.clean, false);
    assert.match(marker.reason, /could not be removed/);
  });

  it('is written readable only by its owner, and not left half-written', () => {
    writeCleanShutdownMarker(db, { lastFullCheckAt: 5, now: 6 });
    assert.equal(fs.statSync(markerPath(db)).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${markerPath(db)}.tmp`), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(db), 'utf8')), { closedAt: 6, lastFullCheckAt: 5 });
  });
});

describe('choosing the startup check', () => {
  const now = 100 * DAY;

  it('checks in full after a stop that was not orderly', () => {
    assert.equal(chooseStartupCheck({ clean: false, lastFullCheckAt: now }, { now }).mode, 'full');
    assert.equal(chooseStartupCheck(null, { now }).mode, 'full');
  });

  // undefined is the case that matters: `now - undefined` is NaN, and NaN is
  // never greater than a week, so without this rule it would pass as recent.
  it('checks in full when there is no full check on record', () => {
    assert.equal(chooseStartupCheck({ clean: true, lastFullCheckAt: undefined }, { now }).mode, 'full');
    assert.equal(chooseStartupCheck({ clean: true }, { now }).mode, 'full');
    assert.equal(chooseStartupCheck({ clean: true, lastFullCheckAt: null }, { now }).mode, 'full');
  });

  it('checks in full when the last full check is more than a week old', () => {
    const marker = { clean: true, lastFullCheckAt: now - FULL_CHECK_MAX_AGE_MS - 1 };
    assert.equal(chooseStartupCheck(marker, { now }).mode, 'full');
  });

  it('uses the quick check after an orderly stop with a recent full check', () => {
    assert.equal(chooseStartupCheck({ clean: true, lastFullCheckAt: now - DAY }, { now }).mode, 'quick');
    assert.equal(chooseStartupCheck({ clean: true, lastFullCheckAt: now - FULL_CHECK_MAX_AGE_MS }, { now }).mode, 'quick');
  });
});

describe('the quick check', () => {
  it('runs quick_check, not integrity_check', () => {
    const asked = [];
    const fake = { pragma(name) { asked.push(name); return [{ [name]: 'ok' }]; } };
    assert.equal(checkLiveDatabase(fake, { mode: 'quick' }), 'ok');
    assert.equal(checkLiveDatabase(fake, { mode: 'full' }), 'ok');
    assert.deepEqual(asked, ['quick_check', 'integrity_check']);
  });

  // Faster is only worth having if it still finds damage.
  it('still finds a damaged data page', () => {
    const real = new Database(db);
    real.exec('CREATE TABLE connections (dst TEXT, lastSeen INTEGER)');
    const insert = real.prepare('INSERT INTO connections VALUES (?, ?)');
    for (let i = 0; i < 200; i += 1) insert.run(`203.0.113.${i % 250}`, i);
    const pageSize = real.pragma('page_size', { simple: true });
    real.close();
    const fd = fs.openSync(db, 'r+');
    fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, pageSize + 8);
    fs.closeSync(fd);
    const damaged = new Database(db, { readonly: true });
    try {
      assert.equal(checkLiveDatabase(damaged, { mode: 'quick' }), 'corrupt');
    } finally {
      damaged.close();
    }
  });
});

describe('start, stop and start again', () => {
  const history = require('../../src/history');
  const backup = require('../../src/backup');

  beforeEach(() => backup._setPathsForTest(db, path.join(dir, 'backups')));
  afterEach(() => history._initForTest());

  it('checks in full the first time, and quickly after an orderly stop', () => {
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'full');
    history.closeDb();
    assert.equal(history.markCleanShutdown(), true);

    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'quick');
    assert.equal(fs.existsSync(markerPath(db)), false, 'the marker survived the start that used it');
  });

  // What the watchdog's SIGKILL, an OOM kill or a power cut look like from
  // here: the run ends and nothing records it.
  it('checks in full after a run that ended without an orderly stop', () => {
    history._initForTest(db);
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);            // consumes the marker
    assert.equal(history.getStartupCheck().mode, 'quick');
    // ...and this run is killed: no closeDb, no markCleanShutdown.
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'full');
  });

  it('refuses to record a clean stop while the database is still open', () => {
    history._initForTest(db);
    assert.equal(history.markCleanShutdown(), false);
    assert.equal(fs.existsSync(markerPath(db)), false);
  });

  it('carries the time of the last full check through a quick start', () => {
    history._initForTest(db);
    const fullAt = history.getStartupCheck().lastFullCheckAt;
    assert.ok(Number.isFinite(fullAt));
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'quick');
    assert.equal(history.getStartupCheck().lastFullCheckAt, fullAt, 'a quick start pretended to be a full check');
  });

  it('checks in full once the last full check is more than a week old', () => {
    history._initForTest(db);
    history.closeDb();
    writeCleanShutdownMarker(db, { lastFullCheckAt: Date.now() - FULL_CHECK_MAX_AGE_MS - DAY });
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'full');
  });
});
