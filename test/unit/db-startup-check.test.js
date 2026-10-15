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
  openHandlesTo,
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
    // Windows has no POSIX permission bits to set: every file reports 0666
    // there. The rest of this test means the same on every platform.
    if (process.platform !== 'win32') assert.equal(fs.statSync(markerPath(db)).mode & 0o777, 0o600);
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

  // 269 s on production (2026-10-15): after an orderly stop, a full check that
  // is due only because of its age follows startup instead.
  it('defers a week-old full check after an orderly stop when asked to', () => {
    const marker = { clean: true, lastFullCheckAt: now - FULL_CHECK_MAX_AGE_MS - 1 };
    assert.equal(chooseStartupCheck(marker, { now, deferFull: true }).mode, 'deferred-full');
    assert.equal(chooseStartupCheck({ clean: false }, { now, deferFull: true }).mode, 'full', 'never after an unorderly stop');
    assert.equal(chooseStartupCheck({ clean: true, lastFullCheckAt: null }, { now, deferFull: true }).mode, 'full', 'nor with no full check on record');
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

  it('checks in full the first time, and defers the quick check after an orderly stop', () => {
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'full');
    history.closeDb();
    assert.equal(history.markCleanShutdown().written, true);

    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'deferred');
    assert.equal(history.getStartupCheck().result, 'deferred');
    assert.equal(fs.existsSync(markerPath(db)), false, 'the marker survived the start that used it');
  });

  // What the watchdog's SIGKILL, an OOM kill or a power cut look like from
  // here: the run ends and nothing records it.
  it('checks in full after a run that ended without an orderly stop', () => {
    history._initForTest(db);
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);            // consumes the marker
    assert.equal(history.getStartupCheck().mode, 'deferred');
    // ...and this run is killed: no closeDb, no markCleanShutdown.
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'full');
  });

  it('refuses to record a clean stop while the database is still open', () => {
    history._initForTest(db);
    assert.equal(history.markCleanShutdown().written, false);
    assert.equal(fs.existsSync(markerPath(db)), false);
  });

  it('carries the time of the last full check through a deferred start', () => {
    history._initForTest(db);
    const fullAt = history.getStartupCheck().lastFullCheckAt;
    assert.ok(Number.isFinite(fullAt));
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'deferred');
    assert.equal(history.getStartupCheck().lastFullCheckAt, fullAt, 'a deferred start pretended to be a full check');
  });

  // The deferred quick check found damage, or could not run: the next start
  // must not inherit the recent full check, so it checks in full first.
  it('後回しの検査が異常を返したら、次の起動は完全な検査になる', () => {
    history._initForTest(db);
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'deferred');
    history.recordBackgroundCheck({ result: 'corrupt', ms: 10 });
    assert.equal(history.getStartupCheck().background.result, 'corrupt');
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'full');
  });

  it('後回しの検査がokなら、次も後回しのまま', () => {
    history._initForTest(db);
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);
    history.recordBackgroundCheck({ result: 'ok', ms: 10 });
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'deferred');
  });

  it('defers the full check after an orderly stop once the last one is more than a week old', () => {
    history._initForTest(db);
    history.closeDb();
    writeCleanShutdownMarker(db, { lastFullCheckAt: Date.now() - FULL_CHECK_MAX_AGE_MS - DAY });
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'deferred-full');
    assert.equal(history.getStartupCheck().result, 'deferred');
  });

  // The daily full check (or a deferred one) that passed counts as the last
  // full check, so the next orderly start does not find it a week old.
  it('裏で通った完全な検査は、次の起動の「最後の完全な検査」になる', () => {
    history._initForTest(db);
    history.closeDb();
    writeCleanShutdownMarker(db, { lastFullCheckAt: Date.now() - FULL_CHECK_MAX_AGE_MS - DAY });
    history._initForTest(db);
    const at = Date.now();
    history.recordBackgroundCheck({ result: 'ok', mode: 'full', ms: 5, at });
    assert.equal(history.getStartupCheck().lastFullCheckAt, at);
    history.closeDb();
    history.markCleanShutdown();
    history._initForTest(db);
    assert.equal(history.getStartupCheck().mode, 'deferred');
  });
});

// Review finding: the first version wrote the marker after three of the
// eleven connections to the database had closed. "Clean" now means the
// process holds no descriptor on the database at all, whoever opened it.
describe('handles still open at shutdown', () => {
  // A stand-in for /proc/self/fd: one symlink per descriptor.
  function fakeFdDir(targets) {
    const fdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-'));
    targets.forEach((target, i) => fs.symlinkSync(target, path.join(fdDir, String(i + 3))));
    return fdDir;
  }

  it('finds the database, its -wal and -shm among the open descriptors', () => {
    const fdDir = fakeFdDir([db, `${db}-wal`, `${db}-shm`, '/dev/null', path.join(dir, 'other.db')]);
    try {
      assert.deepEqual(openHandlesTo(db, { fdDir }).sort(), [db, `${db}-shm`, `${db}-wal`].sort());
    } finally {
      fs.rmSync(fdDir, { recursive: true, force: true });
    }
  });

  it('finds nothing when only other files are open', () => {
    const fdDir = fakeFdDir(['/dev/null', path.join(dir, 'other.db')]);
    try {
      assert.deepEqual(openHandlesTo(db, { fdDir }), []);
    } finally {
      fs.rmSync(fdDir, { recursive: true, force: true });
    }
  });

  it('says it cannot tell where descriptors cannot be listed', () => {
    assert.equal(openHandlesTo(db, { fdDir: path.join(dir, 'no-such-dir') }), null);
  });

  describe('recording the clean stop', () => {
    const history = require('../../src/history');
    const backup = require('../../src/backup');
    beforeEach(() => backup._setPathsForTest(db, path.join(dir, 'backups')));
    afterEach(() => history._initForTest());

    it('refuses while another module still holds the database open', () => {
      history._initForTest(db);
      history.closeDb();
      const result = history.markCleanShutdown({ openHandles: () => [db, `${db}-wal`] });
      assert.equal(result.written, false);
      assert.match(result.reason, /2 handle\(s\).*hub\.db/);
      assert.equal(fs.existsSync(markerPath(db)), false, 'a marker was written with handles still open');
    });

    it('writes it once every handle is closed', () => {
      history._initForTest(db);
      history.closeDb();
      const result = history.markCleanShutdown({ openHandles: () => [] });
      assert.equal(result.written, true);
      assert.equal(fs.existsSync(markerPath(db)), true);
    });
  });
});

// The process the background checks run in: a real child against real files.
describe('database checks while the Hub keeps working', () => {
  const { runDatabaseCheck, lowPriorityCommand, msUntilNextHour } = require('../../src/db-background-check');
  const Database = require('better-sqlite3');

  function soundDb() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qc-')), 'ok.db');
    const created = new Database(file);
    created.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT); CREATE INDEX t_b ON t(b); INSERT INTO t (b) VALUES (\'x\'), (\'y\');');
    created.close();
    return file;
  }

  it('健全なDBでは、軽い検査も完全な検査もokを返す', async () => {
    const file = soundDb();
    for (const mode of ['quick', 'full']) {
      const outcome = await runDatabaseCheck(file, mode);
      assert.equal(outcome.result, 'ok', mode);
      assert.equal(outcome.mode, mode);
      assert.ok(Number.isFinite(outcome.ms));
    }
  });

  it('DBが無ければerrorを返し、投げない', async () => {
    const outcome = await runDatabaseCheck(path.join(os.tmpdir(), `missing-${process.pid}-${Date.now()}.db`), 'full');
    assert.equal(outcome.result, 'error');
    assert.ok(outcome.error);
  });

  it('Linuxでは、CPUとディスクの優先度を最低にして動かす', () => {
    const linux = lowPriorityCommand(['x.js'], { platform: 'linux', exists: () => true });
    assert.equal(linux.command, '/usr/bin/nice');
    assert.deepEqual(linux.args.slice(0, 5), ['-n', '19', '/usr/bin/ionice', '-c', '3']);
    const elsewhere = lowPriorityCommand(['x.js'], { platform: 'darwin', exists: () => true });
    assert.equal(elsewhere.command, process.execPath);
  });

  it('次の04:00までの時間を、今日が過ぎていれば明日で数える', () => {
    const before = new Date(2026, 9, 15, 3, 30, 0);
    assert.equal(msUntilNextHour(4, before), 30 * 60 * 1000);
    const after = new Date(2026, 9, 15, 11, 0, 0);
    assert.equal(msUntilNextHour(4, after), 17 * 60 * 60 * 1000);
  });
});
