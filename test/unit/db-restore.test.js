'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  DbRestoreFailClosedError,
  isCorruptionError,
  checkLiveDatabase,
  verifyCandidate,
  restoreFromCandidates,
} = require('../../src/db-restore');

// On 2026-09-23 the production Hub's startup check would, on any failure,
// delete the live database and copy the newest file in the backup directory
// over it without checking it. That directory then held 2,761 files, nearly
// all 0 bytes -- and a 0-byte file passes `integrity_check` as an empty
// database. Every test here holds one rule: whatever goes wrong, the original
// database is still there afterwards.

const OPTIONS = { Database, maxSchemaVersion: 31, requiredTables: ['connections'] };
const silent = { info() {}, warn() {}, error() {} };

let dir;
let live;

function makeDb(file, { dst = '203.0.113.7', version = 31 } = {}) {
  const db = new Database(file);
  db.exec(`CREATE TABLE connections (dst TEXT, lastSeen INTEGER)`);
  db.prepare('INSERT INTO connections VALUES (?, ?)').run(dst, 1);
  db.pragma(`user_version = ${version}`);
  db.close();
}

function liveRow() {
  const db = new Database(live, { readonly: true });
  try { return db.prepare('SELECT dst FROM connections').get()?.dst; } finally { db.close(); }
}

// Damages page 2, the connections table, and leaves page 1 alone. The schema
// still reads, so only `integrity_check` can tell -- which is the shape of
// damage most likely to reach a restore unnoticed.
function damageDataPage(file) {
  const db = new Database(file, { readonly: true });
  const pageSize = db.pragma('page_size', { simple: true });
  db.close();
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, pageSize + 8);
  fs.closeSync(fd);
}

function damage(file) {
  // Past the 100-byte header and into the first page's content, so the file
  // still opens as a database and `integrity_check` finds the damage.
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(3000, 0xff), 0, 3000, 1024);
  fs.closeSync(fd);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
  live = path.join(dir, 'live.db');
  makeDb(live, { dst: 'original' });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the live database check', () => {
  it('says ok for a healthy database', () => {
    const db = new Database(live);
    try { assert.equal(checkLiveDatabase(db), 'ok'); } finally { db.close(); }
  });

  // A lock, a read error, a permission problem: none of these says the data
  // is damaged, and treating them as if they did is how a healthy database
  // gets deleted.
  it('stops, rather than calling it corruption, when the check itself throws', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const db = { pragma() { throw busy; } };
    assert.throws(() => checkLiveDatabase(db), DbRestoreFailClosedError);
    assert.equal(liveRow(), 'original');
  });

  it('calls it corruption only for the codes that mean the file is damaged', () => {
    assert.equal(isCorruptionError({ code: 'SQLITE_CORRUPT' }), true);
    assert.equal(isCorruptionError({ code: 'SQLITE_CORRUPT_VTAB' }), true);
    assert.equal(isCorruptionError({ code: 'SQLITE_NOTADB' }), true);
    for (const code of ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_CANTOPEN', 'EACCES', undefined]) {
      assert.equal(isCorruptionError({ code }), false, `${code} was treated as corruption`);
    }
  });
});

describe('a backup candidate', () => {
  it('is accepted when it is a whole Hub database', () => {
    const candidate = path.join(dir, 'good.db');
    makeDb(candidate);
    assert.equal(verifyCandidate(candidate, OPTIONS).ok, true);
  });

  // The case that makes this module necessary: an empty file is a valid,
  // empty SQLite database, and `integrity_check` says "ok".
  it('is refused when it is 0 bytes, although integrity_check would pass it', () => {
    const candidate = path.join(dir, 'zero.db');
    fs.writeFileSync(candidate, '');
    const check = new Database(path.join(dir, 'zero-probe.db'));
    try { assert.equal(check.pragma('integrity_check')[0].integrity_check, 'ok'); } finally { check.close(); }
    const verdict = verifyCandidate(candidate, OPTIONS);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /empty/);
  });

  it('is refused when it is a database without the Hub tables', () => {
    const candidate = path.join(dir, 'other.db');
    const db = new Database(candidate);
    db.exec('CREATE TABLE something_else (x)');
    db.close();
    assert.match(verifyCandidate(candidate, OPTIONS).reason, /missing tables: connections/);
  });

  it('is refused when it is damaged', () => {
    const candidate = path.join(dir, 'damaged.db');
    makeDb(candidate);
    damage(candidate);
    assert.equal(verifyCandidate(candidate, OPTIONS).ok, false);
  });

  it('is refused when its schema reads but a data page is damaged', () => {
    const candidate = path.join(dir, 'data-damaged.db');
    makeDb(candidate);
    damageDataPage(candidate);
    // The schema is intact: this is not caught by merely opening the file.
    const probe = new Database(candidate, { readonly: true });
    try { assert.ok(probe.prepare("SELECT name FROM sqlite_master").all().length > 0); } finally { probe.close(); }
    // Depending on what SQLite has cached, the check reports the damage as
    // rows or throws SQLITE_CORRUPT. Either is a refusal; what matters is that
    // it comes from reading the data pages, which nothing else here does.
    const verdict = verifyCandidate(candidate, OPTIONS);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /integrity_check|SQLITE_CORRUPT/);
  });

  // A file longer than the pages its header declares is not the file that
  // was written; `integrity_check` ignores the tail, so only the length says so.
  it('is refused when its length does not match the pages it declares', () => {
    const candidate = path.join(dir, 'padded.db');
    makeDb(candidate);
    fs.appendFileSync(candidate, Buffer.alloc(4096, 0));
    const verdict = verifyCandidate(candidate, OPTIONS);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /does not match/);
  });

  it('is refused when it was written by a newer Hub', () => {
    const candidate = path.join(dir, 'newer.db');
    makeDb(candidate, { version: 99 });
    assert.match(verifyCandidate(candidate, OPTIONS).reason, /newer/);
  });

  it('is refused when it is cut short', () => {
    const candidate = path.join(dir, 'short.db');
    makeDb(candidate);
    const size = fs.statSync(candidate).size;
    fs.truncateSync(candidate, size - 512);
    assert.equal(verifyCandidate(candidate, OPTIONS).ok, false);
  });
});

describe('restoring a damaged database', () => {
  function restore(candidates, extra = {}) {
    return restoreFromCandidates({
      targetPath: live, candidates, ...OPTIONS, logger: silent, now: () => 1_700_000_000_000, ...extra,
    });
  }

  it('swaps in the newest candidate that verifies, and keeps the damaged file', () => {
    const good = path.join(dir, 'good.db');
    makeDb(good, { dst: 'from-backup' });
    const result = restore([good]);
    assert.equal(liveRow(), 'from-backup');
    assert.ok(fs.existsSync(result.preservedAs), 'the damaged database was deleted');
    const kept = new Database(result.preservedAs, { readonly: true });
    try { assert.equal(kept.prepare('SELECT dst FROM connections').get().dst, 'original'); } finally { kept.close(); }
  });

  it('skips candidates that do not verify and takes the next one', () => {
    const zero = path.join(dir, 'zero.db');
    fs.writeFileSync(zero, '');
    const good = path.join(dir, 'good.db');
    makeDb(good, { dst: 'older-but-real' });
    restore([zero, good]);
    assert.equal(liveRow(), 'older-but-real');
  });

  // The -wal belongs to the damaged database. Left beside the restored file,
  // SQLite would replay the damaged pages into it.
  it('moves the damaged database\'s -wal aside with it', () => {
    fs.writeFileSync(`${live}-wal`, 'wal of the damaged database');
    const good = path.join(dir, 'good.db');
    makeDb(good, { dst: 'from-backup' });
    const result = restore([good]);
    assert.equal(fs.existsSync(`${live}-wal`), false, 'the old -wal is still beside the restored file');
    assert.equal(fs.readFileSync(`${result.preservedAs}-wal`, 'utf8'), 'wal of the damaged database');
  });

  describe('leaves the original where it was when', () => {
    it('the only candidate is 0 bytes', () => {
      const zero = path.join(dir, 'zero.db');
      fs.writeFileSync(zero, '');
      assert.throws(() => restore([zero]), DbRestoreFailClosedError);
      assert.equal(liveRow(), 'original');
    });

    it('the only candidate is damaged', () => {
      const bad = path.join(dir, 'bad.db');
      makeDb(bad);
      damage(bad);
      assert.throws(() => restore([bad]), DbRestoreFailClosedError);
      assert.equal(liveRow(), 'original');
    });

    it('there are no candidates at all', () => {
      assert.throws(() => restore([]), /no backup verified/);
      assert.equal(liveRow(), 'original');
    });

    it('copying the candidate fails', () => {
      const good = path.join(dir, 'good.db');
      makeDb(good, { dst: 'from-backup' });
      const fsImpl = {
        ...fs,
        copyFileSync() { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); },
      };
      assert.throws(() => restore([good], { fsImpl }), /copy failed/);
      assert.equal(liveRow(), 'original');
    });

    it('moving the verified copy into place fails', () => {
      const good = path.join(dir, 'good.db');
      makeDb(good, { dst: 'from-backup' });
      fs.writeFileSync(`${live}-wal`, '');
      const fsImpl = {
        ...fs,
        renameSync(from, to) {
          if (to === live) throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
          return fs.renameSync(from, to);
        },
      };
      assert.throws(() => restore([good], { fsImpl }), DbRestoreFailClosedError);
      assert.equal(liveRow(), 'original', 'the original is not where it was');
      assert.equal(fs.existsSync(`${live}-wal`), true, 'the original -wal is not where it was');
      assert.deepEqual(
        fs.readdirSync(dir).filter(name => name.includes('.restore-')),
        [],
        'the temporary copy was left behind'
      );
    });

    it('keeping a copy of the damaged database fails', () => {
      const good = path.join(dir, 'good.db');
      makeDb(good, { dst: 'from-backup' });
      const fsImpl = {
        ...fs,
        linkSync() { throw Object.assign(new Error('hard links not supported'), { code: 'EPERM' }); },
      };
      assert.throws(() => restore([good], { fsImpl }), /Could not keep a copy/);
      assert.equal(liveRow(), 'original');
      assert.deepEqual(
        fs.readdirSync(dir).filter(name => name.includes('.damaged-') || name.includes('.restore-')),
        [],
        'something was left behind'
      );
    });
  });

  // Leaves `live` as a crash leaves a WAL database: a row in the main file and
  // a row that exists only in the -wal. Reopening shows both; the main file on
  // its own shows only the first.
  function crashWithWalOnlyRow() {
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(live + suffix); } catch {} }
    const scratch = path.join(dir, 'crashing.db');
    const db = new Database(scratch);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec('CREATE TABLE connections (dst TEXT, lastSeen INTEGER)');
    db.pragma('user_version = 31');
    db.prepare('INSERT INTO connections VALUES (?, ?)').run('original', 1);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.prepare('INSERT INTO connections VALUES (?, ?)').run('only-in-wal', 2);
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(scratch + suffix)) fs.copyFileSync(scratch + suffix, live + suffix);
    }
    db.close();
  }

  function liveRows() {
    const db = new Database(live);
    try { return db.prepare('SELECT dst FROM connections ORDER BY lastSeen').all().map(r => r.dst); } finally { db.close(); }
  }

  // The review finding: removing the damaged database's -wal *after* the swap
  // left a window in which the restored file sat beside it. If the start
  // stopped there, the restart replayed the damaged pages into the restored
  // database. The -wal now leaves first.
  it('never puts the restored file beside the damaged database\'s -wal', () => {
    crashWithWalOnlyRow();
    const good = path.join(dir, 'good.db');
    makeDb(good, { dst: 'from-backup' });
    let walPresentAtSwap = null;
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (to === live) walPresentAtSwap = fs.existsSync(`${live}-wal`);
        return fs.renameSync(from, to);
      },
    };
    restore([good], { fsImpl });
    assert.equal(walPresentAtSwap, false, 'the damaged -wal was still beside the file being swapped in');
    assert.deepEqual(liveRows(), ['from-backup'], 'the damaged database was replayed into the restored one');
  });

  it('leaves the original, -wal included, when its -wal cannot be moved', () => {
    crashWithWalOnlyRow();
    const good = path.join(dir, 'good.db');
    makeDb(good, { dst: 'from-backup' });
    const fsImpl = {
      ...fs,
      unlinkSync(file) {
        if (file === `${live}-wal`) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
        return fs.unlinkSync(file);
      },
    };
    assert.throws(() => restore([good], { fsImpl }), /could not move the damaged database's -wal/i);
    assert.deepEqual(liveRows(), ['original', 'only-in-wal'], 'the original, reopened, lost what was in its -wal');
  });

  it('puts the -wal back when the swap fails, so reopening shows the original whole', () => {
    crashWithWalOnlyRow();
    const good = path.join(dir, 'good.db');
    makeDb(good, { dst: 'from-backup' });
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (to === live) throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
        return fs.renameSync(from, to);
      },
    };
    assert.throws(() => restore([good], { fsImpl }), DbRestoreFailClosedError);
    assert.deepEqual(liveRows(), ['original', 'only-in-wal'], 'the original, reopened, lost what was in its -wal');
  });
});
