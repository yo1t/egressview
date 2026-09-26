// Unit tests for src/backup.js
// Run: node --test test/unit/backup.test.js

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Database = require('better-sqlite3');

const backup = require('../../src/backup');

// ─── Temp directory helpers ───────────────────────────────────────────────────

let tmpDir, fakeDb, backupDir;

/** Create a real SQLite DB at `p` with a `marks` table containing one row. */
function makeRealDb(p, mark = 'original') {
  const d = new Database(p);
  d.pragma('journal_mode = WAL');
  d.exec('CREATE TABLE IF NOT EXISTS marks (val TEXT)');
  d.prepare('DELETE FROM marks').run();
  d.prepare('INSERT INTO marks (val) VALUES (?)').run(mark);
  d.close();
}

/** Read the mark value back from a SQLite DB file. */
function readMark(p) {
  const d = new Database(p, { readonly: true, fileMustExist: true });
  const row = d.prepare('SELECT val FROM marks LIMIT 1').get();
  d.close();
  return row?.val ?? null;
}

function setup() {
  tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-backup-test-'));
  fakeDb    = path.join(tmpDir, 'test.db');
  backupDir = path.join(tmpDir, 'backups');
  makeRealDb(fakeDb, 'fake-db-content');
  backup._setPathsForTest(fakeDb, backupDir);
}

function teardown() {
  backup.stopPeriodicBackup();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── configure / getConfig ────────────────────────────────────────────────────

describe('configure / getConfig', () => {
  before(setup);
  after(teardown);

  it('returns default config', () => {
    const c = backup.getConfig();
    assert.equal(c.intervalHours, 24);
    assert.equal(c.maxGenerations, 7);
    assert.equal(c.maxBackupBytes, 0);
    assert.equal(c.autoPrune, false);
  });

  it('configure() updates intervalHours', () => {
    backup.configure({ intervalHours: 12 });
    assert.equal(backup.getConfig().intervalHours, 12);
  });

  // Node replaces a timer delay above 2^31-1 ms with 1 ms, silently. 8,760
  // hours is above it, and that is what ran the backup continuously on
  // 2026-09-23.
  it('configure() refuses an interval a timer cannot hold, and keeps the old one', () => {
    backup.configure({ intervalHours: 12 });
    backup.configure({ intervalHours: 8760 });
    assert.equal(backup.getConfig().intervalHours, 12);
    backup.configure({ intervalHours: backup.MAX_INTERVAL_HOURS + 1 });
    assert.equal(backup.getConfig().intervalHours, 12);
  });

  it('configure() accepts the largest interval a timer can hold', () => {
    backup.configure({ intervalHours: backup.MAX_INTERVAL_HOURS });
    assert.equal(backup.getConfig().intervalHours, backup.MAX_INTERVAL_HOURS);
    assert.ok(backup.MAX_INTERVAL_HOURS * 3_600_000 <= 2 ** 31 - 1);
    assert.ok((backup.MAX_INTERVAL_HOURS + 1) * 3_600_000 > 2 ** 31 - 1);
  });

  it('configure() updates maxGenerations', () => {
    backup.configure({ maxGenerations: 3 });
    assert.equal(backup.getConfig().maxGenerations, 3);
  });

  it('configure() ignores missing keys', () => {
    backup.configure({});
    // should not throw, values unchanged from previous assertions
    assert.ok(backup.getConfig().intervalHours > 0);
  });
});

// ─── getBackupPath (path traversal protection) ───────────────────────────────

describe('getBackupPath', () => {
  before(setup);
  after(teardown);

  it('returns null for name with ".."', () => {
    assert.equal(backup.getBackupPath('../../../etc/passwd'), null);
  });

  it('returns null for name with "/"', () => {
    assert.equal(backup.getBackupPath('sub/dir.db'), null);
  });

  it('returns null for null input', () => {
    assert.equal(backup.getBackupPath(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(backup.getBackupPath(''), null);
  });

  it('returns null for non-existent file', () => {
    assert.equal(backup.getBackupPath('egressview_2025-01-01_00-00-00.db'), null);
  });

  it('returns the full path for an existing backup file', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const name = 'egressview_2025-01-01_00-00-00.db';
    fs.writeFileSync(path.join(backupDir, name), 'data');
    const p = backup.getBackupPath(name);
    assert.ok(p.endsWith(name));
    assert.ok(fs.existsSync(p));
  });

  it('accepts the collision-resistant backup filename format', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const name = 'egressview_2025-01-01_00-00-00-123-deadbeef.db';
    fs.writeFileSync(path.join(backupDir, name), 'data');
    assert.equal(backup.getBackupPath(name), path.join(backupDir, name));
  });
});

// ─── listBackups ─────────────────────────────────────────────────────────────

describe('listBackups', () => {
  beforeEach(() => {
    setup();
    fs.mkdirSync(backupDir, { recursive: true });
  });
  after(teardown);

  it('returns empty array when no backups exist', () => {
    assert.deepEqual(backup.listBackups(), []);
  });

  it('lists backup files sorted by name', () => {
    fs.writeFileSync(path.join(backupDir, 'egressview_2025-01-03_00-00-00.db'), 'c');
    fs.writeFileSync(path.join(backupDir, 'egressview_2025-01-01_00-00-00.db'), 'a');
    fs.writeFileSync(path.join(backupDir, 'egressview_2025-01-02_00-00-00.db'), 'b');
    const list = backup.listBackups();
    assert.equal(list.length, 3);
    assert.equal(list[0].name, 'egressview_2025-01-01_00-00-00.db');
    assert.equal(list[2].name, 'egressview_2025-01-03_00-00-00.db');
  });

  it('ignores non-.db files', () => {
    fs.writeFileSync(path.join(backupDir, 'egressview_2025-01-01_00-00-00.db'), 'ok');
    fs.writeFileSync(path.join(backupDir, 'README.txt'), 'ignore me');
    assert.equal(backup.listBackups().length, 1);
  });

  it('each entry has name, size, created fields', () => {
    fs.writeFileSync(path.join(backupDir, 'egressview_2025-01-01_00-00-00.db'), 'hello');
    const [entry] = backup.listBackups();
    assert.ok(typeof entry.name === 'string');
    assert.ok(typeof entry.size === 'number');
    assert.ok(typeof entry.created === 'string');
  });
});

// ─── createBackup / pruneOldBackups ──────────────────────────────────────────

describe('createBackup', () => {
  before(setup);
  after(teardown);

  it('returns null when database file does not exist', async () => {
    backup._setPathsForTest(path.join(tmpDir, 'nonexistent.db'), backupDir);
    assert.equal(await backup.createBackup(), null);
    // restore
    backup._setPathsForTest(fakeDb, backupDir);
  });

  it('does not create a partial backup when free space is below the safe minimum', async () => {
    try {
      backup._setFreeBytesForTest(0);
      assert.equal(await backup.createBackup(), null);
      assert.equal(backup.listBackups().length, 0);
    } finally {
      backup._setFreeBytesForTest(null);
    }
  });

  it('creates a backup file and returns its name', async () => {
    const name = await backup.createBackup();
    assert.ok(typeof name === 'string');
    assert.ok(name.startsWith('egressview_'));
    assert.ok(name.endsWith('.db'));
    const p = path.join(backupDir, name);
    assert.ok(fs.existsSync(p));
  });

  // One at a time. On 2026-09-23 a timer that overflowed to 1 ms started a
  // backup every millisecond, each on its own connection, until the process
  // held 1,031 of them and 7 GB. A second caller now gets the run in progress.
  it('runs one backup at a time: a second caller gets the run in progress', async () => {
    const before = backup.listBackups().length;
    const [first, second] = await Promise.all([backup.createBackup(), backup.createBackup()]);
    assert.ok(first, 'the backup did not complete');
    assert.equal(second, first, 'a second backup ran alongside the first');
    assert.equal(backup.listBackups().length, before + 1);
  });

  it('starts a new backup once the previous one has finished', async () => {
    const first = await backup.createBackup();
    const second = await backup.createBackup();
    assert.ok(first && second);
    assert.notEqual(second, first, 'a finished run was handed out again');
  });

  it('backup is a valid SQLite DB with the same content as the source', async () => {
    const name = await backup.createBackup();
    assert.equal(readMark(path.join(backupDir, name)), 'fake-db-content');
  });

  it('backup includes transactions still in the WAL (not yet checkpointed)', async () => {
    // Open the source DB, write a new row, and keep WAL un-checkpointed by
    // disabling auto-checkpoint before the write.
    const d = new Database(fakeDb);
    d.pragma('journal_mode = WAL');
    d.pragma('wal_autocheckpoint = 0');
    d.prepare('INSERT INTO marks (val) VALUES (?)').run('wal-only-row');
    // Do NOT checkpoint; keep the connection open so WAL is live during backup
    const name = await backup.createBackup();
    d.close();

    const bdb = new Database(path.join(backupDir, name), { readonly: true });
    const rows = bdb.prepare('SELECT val FROM marks ORDER BY val').all().map(r => r.val);
    bdb.close();
    assert.ok(rows.includes('wal-only-row'), 'WAL-resident row must be present in backup');
  });

  it('names a backup only once it is complete', async () => {
    const isolatedDir = path.join(tmpDir, 'backups-naming');
    backup._setPathsForTest(fakeDb, isolatedDir);
    try {
      const name = await backup.createBackup();
      assert.ok(name);
      assert.deepEqual(fs.readdirSync(isolatedDir), [name], 'the copy was left under another name');
      assert.equal(readMark(path.join(isolatedDir, name)), readMark(fakeDb));
    } finally {
      backup._setPathsForTest(fakeDb, backupDir);
    }
  });

  it('returns null and leaves no partial file for a corrupt source DB', async () => {
    const corruptDb  = path.join(tmpDir, 'corrupt.db');
    const isolatedDir = path.join(tmpDir, 'backups-corrupt');  // avoid same-second name collision with earlier tests
    fs.writeFileSync(corruptDb, 'this is not a sqlite database at all');
    backup._setPathsForTest(corruptDb, isolatedDir);
    assert.equal(await backup.createBackup(), null);
    assert.equal(backup.listBackups().length, 0, 'no partial backup left behind');
    // Not merely unlisted: nothing at all, under any name. A .partial or its
    // -journal left here is disk spent on a copy that proved nothing.
    assert.deepEqual(fs.readdirSync(isolatedDir), [], 'something was left in the backup directory');
    backup._setPathsForTest(fakeDb, backupDir);
  });
});

describe('automatic backup prune', () => {
  before(() => {
    setup();
    backup.configure({ maxGenerations: 3, autoPrune: true });
    fs.mkdirSync(backupDir, { recursive: true });
  });
  after(teardown);

  it('removes only oldest files above the retention floor when explicitly enabled', async () => {
    for (let i = 1; i <= 5; i++) {
      makeRealDb(path.join(backupDir, `egressview_2025-01-0${i}_00-00-00.db`), `generation-${i}`);
    }
    // Creating a generation runs the retention-based prune plan only after opt-in.
    await backup.createBackup();
    for (let i = 0; i < 100 && backup.getActivePruneJob(); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(backup.getActivePruneJob(), null, 'automatic prune worker should finish');
    const list = backup.listBackups();
    assert.ok(list.length <= 3, `Expected ≤3 backups, got ${list.length}`);
  });
});

// ─── restoreFromFile ──────────────────────────────────────────────────────────

describe('restoreFromFile', () => {
  before(setup);
  after(teardown);

  it('rejects when source file does not exist', async () => {
    await assert.rejects(
      () => backup.restoreFromFile(path.join(tmpDir, 'ghost.db')),
      /not found/i
    );
  });

  it('copies source file to DB path and removes stale WAL/SHM', async () => {
    const src = path.join(tmpDir, 'restore-src.db');
    makeRealDb(src, 'restored-content');
    // Plant stale WAL/SHM files that must not survive the restore
    fs.writeFileSync(fakeDb + '-wal', 'stale');
    fs.writeFileSync(fakeDb + '-shm', 'stale');

    await backup.restoreFromFile(src);

    // Check WAL/SHM removal BEFORE opening the DB — opening a WAL-mode DB
    // (even readonly) makes SQLite recreate fresh -wal/-shm files.
    assert.ok(!fs.existsSync(fakeDb + '-wal'), 'stale -wal removed');
    assert.ok(!fs.existsSync(fakeDb + '-shm'), 'stale -shm removed');
    assert.equal(readMark(fakeDb), 'restored-content');
  });

  it('rejects a corrupt restore source before replacing the current DB', async () => {
    const currentMark = readMark(fakeDb);
    const src = path.join(tmpDir, 'corrupt-restore.db');
    fs.writeFileSync(src, Buffer.concat([
      Buffer.from('SQLite format 3\0'),
      Buffer.alloc(256, 0x41),
    ]));

    await assert.rejects(() => backup.restoreFromFile(src), /integrity check failed/i);
    assert.equal(readMark(fakeDb), currentMark);
  });

  it('aborts without replacing the current DB when the safety backup fails', async () => {
    const src = path.join(tmpDir, 'restore-valid.db');
    makeRealDb(src, 'replacement');
    const originalBytes = Buffer.from('not a valid sqlite database');
    fs.writeFileSync(fakeDb, originalBytes);

    await assert.rejects(() => backup.restoreFromFile(src), /safety backup failed/i);
    assert.deepEqual(fs.readFileSync(fakeDb), originalBytes);
  });

  it('keeps the current DB when the pre-replacement close hook fails', async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(fakeDb + suffix); } catch {}
    }
    makeRealDb(fakeDb, 'before-hook-original');
    const src = path.join(tmpDir, 'hook-restore.db');
    makeRealDb(src, 'hook-replacement');

    await assert.rejects(
      () => backup.restoreFromFile(src, { beforeReplace: () => { throw new Error('close failed'); } }),
      /close failed/
    );
    assert.equal(readMark(fakeDb), 'before-hook-original');
  });

  it('restores the original DB and runtime when post-restore initialization fails', async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(fakeDb + suffix); } catch {}
    }
    makeRealDb(fakeDb, 'runtime-original');
    const src = path.join(tmpDir, 'runtime-replacement.db');
    makeRealDb(src, 'runtime-replacement');
    const calls = [];

    await assert.rejects(
      () => backup.restoreFromFile(src, {
        beforeReplace: () => calls.push('close-original'),
        afterReplace: () => { calls.push(`open-${readMark(fakeDb)}`); throw new Error('reopen failed'); },
        beforeRollback: () => calls.push('close-partial'),
        afterRollback: () => calls.push(`open-${readMark(fakeDb)}`),
      }),
      /reopen failed/
    );

    assert.equal(readMark(fakeDb), 'runtime-original');
    assert.deepEqual(calls, [
      'close-original',
      'open-runtime-replacement',
      'close-partial',
      'open-runtime-original',
    ]);
  });

  it('recovers the original DB when an error occurs after replacement starts', async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(fakeDb + suffix); } catch {}
    }
    makeRealDb(fakeDb, 'rollback-original');
    const src = path.join(tmpDir, 'rollback-replacement.db');
    makeRealDb(src, 'rollback-replacement');
    let replacements = 0;

    await assert.rejects(
      () => backup.restoreFromFile(src, {
        replaceDb(sourcePath) {
          replacements++;
          fs.copyFileSync(sourcePath, fakeDb);
          if (replacements === 1) throw new Error('failure after replacement');
        },
      }),
      /failure after replacement/
    );

    assert.equal(replacements, 2, 'replacement followed by safety rollback');
    assert.equal(readMark(fakeDb), 'rollback-original');
  });

  it('reports both errors when replacement and safety rollback fail', async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(fakeDb + suffix); } catch {}
    }
    makeRealDb(fakeDb, 'double-failure-original');
    const src = path.join(tmpDir, 'double-failure-replacement.db');
    makeRealDb(src, 'double-failure-replacement');
    let replacements = 0;

    await assert.rejects(
      () => backup.restoreFromFile(src, {
        replaceDb(sourcePath) {
          replacements++;
          if (replacements === 1) {
            fs.copyFileSync(sourcePath, fakeDb);
            throw new Error('primary replacement failed');
          }
          throw new Error('safety rollback failed');
        },
      }),
      err => {
        assert.match(err.message, /primary replacement failed/);
        assert.match(err.message, /safety rollback also failed/);
        assert.match(err.cause.message, /safety rollback failed/);
        return true;
      }
    );
    assert.equal(replacements, 2);
  });
});

// ─── restoreFromGeneration ────────────────────────────────────────────────────

describe('restoreFromGeneration', () => {
  before(setup);
  after(teardown);

  it('rejects for an unknown backup name', async () => {
    await assert.rejects(
      () => backup.restoreFromGeneration('egressview_9999-01-01_00-00-00.db'),
      /not found/i
    );
  });

  it('restores successfully from an existing generation', async () => {
    const name = 'egressview_2025-01-01_12-00-00.db';
    fs.mkdirSync(backupDir, { recursive: true });
    makeRealDb(path.join(backupDir, name), 'fake-db-content');

    // Overwrite DB with different content
    makeRealDb(fakeDb, 'overwritten');
    await backup.restoreFromGeneration(name);
    assert.equal(readMark(fakeDb), 'fake-db-content');
  });
});

describe('periodic backup start', () => {
  before(setup);
  after(teardown);

  // A process that dies mid-backup leaves its .partial behind. The next start
  // clears it: nothing else can be writing it, and it is not a backup.
  it('removes unfinished copies left by an earlier run', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const partial = path.join(backupDir, 'egressview_2026-09-23_10-32-24-091-5055ce1b.db.partial');
    fs.writeFileSync(partial, 'half a database');
    fs.writeFileSync(`${partial}-journal`, 'its journal');
    const keep = path.join(backupDir, 'egressview_2026-09-22_00-00-00.db');
    makeRealDb(keep, 'kept');
    backup._setPathsForTest(fakeDb, backupDir);
    backup.configure({ intervalHours: 24 });
    try {
      backup.startPeriodicBackup();
    } finally {
      backup.stopPeriodicBackup();
    }
    assert.equal(fs.existsSync(partial), false, 'the unfinished copy is still there');
    assert.equal(fs.existsSync(`${partial}-journal`), false, 'its journal is still there');
    assert.equal(readMark(keep), 'kept', 'a finished backup was touched');
  });
});

describe('a backup in progress, or one that failed', () => {
  before(setup);
  after(teardown);

  // What a process killed mid-backup leaves behind. Nothing under a final
  // name may appear until the copy is complete and checked: the startup
  // restore and the "is there a recent backup" test both read final names.
  it('is not listed while it is still being written', async () => {
    const isolatedDir = path.join(tmpDir, 'backups-in-progress');
    backup._setPathsForTest(fakeDb, isolatedDir);
    let release;
    backup._setCopyForTest((source, destination) => {
      fs.writeFileSync(destination, 'half a database');
      return new Promise(resolve => { release = () => resolve({ ok: false, error: 'stopped' }); });
    });
    let pending;
    try {
      pending = backup.createBackup();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(backup.listBackups().length, 0, 'an unfinished copy is listed as a backup');
    } finally {
      // Released even when the assertion fails: a run left pending would be
      // handed to every later caller as the backup in progress.
      release?.();
      const result = await pending;
      backup._setPathsForTest(fakeDb, backupDir);
      assert.equal(result, null, 'a copy that failed was accepted');
    }
  });

  it('leaves nothing behind when the copy fails its check', async () => {
    const isolatedDir = path.join(tmpDir, 'backups-failed-check');
    backup._setPathsForTest(fakeDb, isolatedDir);
    backup._setCopyForTest(async (source, destination) => {
      fs.writeFileSync(destination, 'not whole');
      fs.writeFileSync(`${destination}-journal`, 'x');
      return { ok: false, error: 'the copy is missing connections' };
    });
    try {
      assert.equal(await backup.createBackup(), null);
      assert.deepEqual(fs.readdirSync(isolatedDir), []);
    } finally {
      backup._setPathsForTest(fakeDb, backupDir);
    }
  });

  // The review finding this PR answers: the copy was checked with
  // integrity_check on the main thread, which takes 171-283 s on the
  // production database while the watchdog kills at 120 s. The main thread
  // must now do nothing with the database during a backup but wait.
  it('never checks the database on the main thread', async () => {
    const isolatedDir = path.join(tmpDir, 'backups-off-thread');
    backup._setPathsForTest(fakeDb, isolatedDir);
    const asked = [];
    const proto = Database.prototype;
    const original = proto.pragma;
    proto.pragma = function (source, ...rest) {
      asked.push(String(source));
      return original.call(this, source, ...rest);
    };
    let name;
    try {
      name = await backup.createBackup();
    } finally {
      proto.pragma = original;
      backup._setPathsForTest(fakeDb, backupDir);
    }
    assert.ok(name, 'the backup did not complete');
    const checks = asked.filter(p => /integrity_check|quick_check/.test(p));
    assert.deepEqual(checks, [], `the main thread ran ${checks.join(', ')}`);
  });

  it('abandons a copy that does not finish in time', async () => {
    const out = path.join(tmpDir, 'timeout-copy.db');
    const result = await backup._copyOnWorker(fakeDb, out, { timeoutMs: 1 });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not finish/);
  });
});

// The admin-screen restore swaps a verified copy over the live file. It used
// to remove the old -wal/-shm after the swap; a failure in between left the
// restored file beside the old -wal, which SQLite replays into it.
describe('replacing the database during a restore', () => {
  before(setup);
  after(teardown);

  // Leaves the database as a crash leaves a WAL database: one row in the main
  // file and one only in the -wal.
  function crashWithWalOnlyRow(file) {
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} }
    const scratch = `${file}.crashing`;
    const d = new Database(scratch);
    d.pragma('journal_mode = WAL');
    d.pragma('wal_autocheckpoint = 0');
    d.exec('CREATE TABLE marks (val TEXT)');
    d.prepare('INSERT INTO marks VALUES (?)').run('original');
    d.pragma('wal_checkpoint(TRUNCATE)');
    d.prepare('INSERT INTO marks VALUES (?)').run('only-in-wal');
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(scratch + suffix)) fs.copyFileSync(scratch + suffix, file + suffix);
    }
    d.close();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(scratch + suffix); } catch {} }
  }

  function marks(file) {
    const d = new Database(file);
    try { return d.prepare('SELECT val FROM marks').all().map(r => r.val); } finally { d.close(); }
  }

  it('never puts the restored file beside the replaced database\'s -wal', async () => {
    backup._setPathsForTest(fakeDb, backupDir);
    crashWithWalOnlyRow(fakeDb);
    const source = path.join(tmpDir, 'restore-me.db');
    makeRealDb(source, 'restored');
    const original = fs.renameSync;
    let walPresentAtSwap = null;
    fs.renameSync = (from, to) => {
      if (to === fakeDb) walPresentAtSwap = fs.existsSync(`${fakeDb}-wal`);
      return original(from, to);
    };
    try {
      await backup._replaceDbAtomically(source);
    } finally {
      fs.renameSync = original;
    }
    assert.equal(walPresentAtSwap, false, 'the old -wal was beside the file being swapped in');
    assert.deepEqual(marks(fakeDb), ['restored'], 'the replaced database was replayed into the restored one');
  });

  it('puts the -wal back when the swap fails, so reopening shows the original whole', async () => {
    backup._setPathsForTest(fakeDb, backupDir);
    crashWithWalOnlyRow(fakeDb);
    const source = path.join(tmpDir, 'restore-me-2.db');
    makeRealDb(source, 'restored');
    const original = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === fakeDb && from.endsWith('.tmp')) throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
      return original(from, to);
    };
    try {
      await assert.rejects(() => backup._replaceDbAtomically(source), /rename refused/);
    } finally {
      fs.renameSync = original;
    }
    assert.deepEqual(marks(fakeDb).sort(), ['only-in-wal', 'original'], 'the original, reopened, lost what was in its -wal');
    makeRealDb(fakeDb, 'fake-db-content');
  });
});

// ─── restore off the main thread ──────────────────────────────────────────────
//
// A restore ran integrity_check on the main thread three times. On the
// production database each takes 171-283 s and the watchdog kills the process
// at 120 s, so a restore from the settings screen stopped the Hub partway.

describe('restore does not hold the main thread', () => {
  beforeEach(() => {
    setup();
  });
  after(() => {
    backup._setVerifyForTest(null);
    backup._setCopyForTest(null);
    teardown();
  });

  function slowVerify(ms, calls, failFor = () => false) {
    return filePath => new Promise(resolve => {
      calls.push(filePath);
      setTimeout(() => resolve(failFor(filePath)
        ? { ok: false, error: 'refused by the test' }
        : { ok: true }), ms);
    });
  }

  it('keeps serving while every check runs, and checks the file, the copy and the result', async () => {
    const src = path.join(tmpDir, 'slow-restore.db');
    makeRealDb(src, 'restored-while-serving');
    const calls = [];
    backup._setVerifyForTest(slowVerify(150, calls));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try {
      await backup.restoreFromFile(src);
    } finally {
      clearInterval(timer);
      backup._setVerifyForTest(null);
    }
    assert.equal(calls.length, 3, `checked ${calls.length} times`);
    assert.equal(calls[0], src);
    assert.match(path.basename(calls[1]), /\.restore-[0-9a-f]+\.tmp$/);
    assert.equal(calls[2], fakeDb);
    // Three checks of 150 ms each: a main thread held for them would not tick.
    assert.ok(ticks >= 20, `the main thread ticked only ${ticks} times during the restore`);
    assert.equal(readMark(fakeDb), 'restored-while-serving');
  });

  it('does not swap in a copy whose check fails', async () => {
    const src = path.join(tmpDir, 'copy-fails.db');
    makeRealDb(src, 'never-swapped-in');
    const before = readMark(fakeDb);
    const calls = [];
    backup._setVerifyForTest(slowVerify(5, calls, file => file.endsWith('.tmp')));
    try {
      await assert.rejects(() => backup.restoreFromFile(src), /integrity check failed/i);
    } finally {
      backup._setVerifyForTest(null);
    }
    assert.equal(readMark(fakeDb), before);
  });

  // Before anything destructive: a file that fails its check must not cost a
  // safety backup of the whole database or close the Hub's connections.
  it('refuses a file that fails its check before the safety backup or closing anything', async () => {
    const src = path.join(tmpDir, 'refused-early.db');
    makeRealDb(src, 'refused');
    const before = backup.listBackups().length;
    let closed = false;
    backup._setVerifyForTest(slowVerify(5, [], file => file === src));
    try {
      await assert.rejects(
        () => backup.restoreFromFile(src, { beforeReplace: () => { closed = true; } }),
        /integrity check failed/i
      );
    } finally {
      backup._setVerifyForTest(null);
    }
    assert.equal(closed, false, 'connections were closed for a file that was going to be refused');
    assert.equal(backup.listBackups().length, before, 'a safety backup was taken for a file that was going to be refused');
  });

  it('refuses a second restore while one is running', async () => {
    const src = path.join(tmpDir, 'first.db');
    makeRealDb(src, 'first-restore');
    const other = path.join(tmpDir, 'second.db');
    makeRealDb(other, 'second-restore');
    backup._setVerifyForTest(slowVerify(100, []));
    try {
      const first = backup.restoreFromFile(src);
      await assert.rejects(() => backup.restoreFromFile(other), /already running/);
      await first;
    } finally {
      backup._setVerifyForTest(null);
    }
    assert.equal(readMark(fakeDb), 'first-restore');
  });

  it('starts no other backup while a restore replaces the database', async () => {
    const src = path.join(tmpDir, 'no-backup-during.db');
    makeRealDb(src, 'restored');
    let duringRestore;
    backup._setVerifyForTest(async file => {
      // Asked while the restore is in its checks, as a periodic tick would be.
      if (file.endsWith('.tmp') && duringRestore === undefined) duringRestore = await backup.createBackup();
      return { ok: true };
    });
    try {
      await backup.restoreFromFile(src);
    } finally {
      backup._setVerifyForTest(null);
    }
    assert.equal(duringRestore, null, 'a backup was started in the middle of the swap');
    const names = backup.listBackups().map(b => b.name);
    assert.equal(names.length, 1, `expected only the safety backup, found ${names.join(', ')}`);
  });

  it('the real check runs on a worker and refuses a file cut short', async () => {
    const whole = path.join(tmpDir, 'whole.db');
    makeRealDb(whole, 'whole');
    const d = new Database(whole); d.pragma('journal_mode = DELETE'); d.close();
    assert.deepEqual(await backup._verifyOnWorker(whole), { ok: true });

    const cut = path.join(tmpDir, 'cut.db');
    const bytes = fs.readFileSync(whole);
    fs.writeFileSync(cut, bytes.subarray(0, bytes.length - 512));
    const result = await backup._verifyOnWorker(cut);
    assert.equal(result.ok, false);
    assert.match(result.error, /declares|malformed|corrupt|integrity/i);
  });
});

// ─── when the next backup is due (P3-176) ────────────────────────────────────
//
// Counted from the newest backup, not from when the Hub started: three deploys
// in three days had left production 44 hours from one backup to the next.

describe('次のバックアップの時刻', () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.parse('2026-09-26T10:00:00Z');

  it('最新のバックアップから数える', () => {
    assert.equal(backup._nextBackupDelay({ now, intervalMs: 24 * HOUR, latestAt: now - 20 * HOUR }), 4 * HOUR);
  });

  it('バックアップが無いか、間隔より古ければ、すぐ', () => {
    assert.equal(backup._nextBackupDelay({ now, intervalMs: 24 * HOUR, latestAt: null }), 0);
    assert.equal(backup._nextBackupDelay({ now, intervalMs: 24 * HOUR, latestAt: now - 30 * HOUR }), 0);
  });

  // Retrying at once is how a backup loop begins (2026-09-23).
  it('取れなかった後は、今から間隔ぶん待つ（すぐ再試行しない）', () => {
    assert.equal(backup._nextBackupDelay({
      now, intervalMs: 24 * HOUR, latestAt: now - 30 * HOUR, lastRunMadeNoBackup: true,
    }), 24 * HOUR);
  });

  describe('実際に予約する', () => {
    beforeEach(setup);
    afterEach(() => { backup._setCopyForTest(null); teardown(); });

    function backupAgedHours(hours) {
      fs.mkdirSync(backupDir, { recursive: true });
      const file = path.join(backupDir, 'egressview_2026-09-25_00-00-00.db');
      makeRealDb(file, 'old');
      const at = new Date(Date.now() - hours * HOUR);
      fs.utimesSync(file, at, at);
      return at.getTime();
    }

    it('再起動しても、最新のバックアップから間隔ぶん後に予約する', () => {
      const latest = backupAgedHours(20);
      let copies = 0;
      backup._setCopyForTest(async () => { copies += 1; return { ok: false, error: 'not expected' }; });
      backup.configure({ intervalHours: 24 });
      backup.startPeriodicBackup();
      try {
        assert.equal(backup._nextBackupAt(), latest + 24 * HOUR);
        assert.equal(copies, 0);
      } finally {
        backup.stopPeriodicBackup();
      }
    });

    it('間隔より古ければ起動してすぐ取り、失敗しても次は間隔ぶん後', async () => {
      backupAgedHours(30);
      let copies = 0;
      backup._setCopyForTest(async () => { copies += 1; return { ok: false, error: 'disk said no' }; });
      backup.configure({ intervalHours: 24 });
      const startedAt = Date.now();
      backup.startPeriodicBackup();
      try {
        for (let i = 0; i < 100 && copies === 0; i += 1) await new Promise(r => setTimeout(r, 10));
        for (let i = 0; i < 100 && backup._nextBackupAt() < startedAt + HOUR; i += 1) await new Promise(r => setTimeout(r, 10));
        assert.equal(copies, 1);
        assert.ok(backup._nextBackupAt() >= startedAt + 24 * HOUR - 1000,
          `next backup at ${new Date(backup._nextBackupAt()).toISOString()}, not a day away`);
      } finally {
        backup.stopPeriodicBackup();
      }
    });
  });
});
