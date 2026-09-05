// Unit tests for src/backup.js
// Run: node --test test/unit/backup.test.js

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
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

  it('creates distinct generations when backups run in the same millisecond', async () => {
    const [first, second] = await Promise.all([backup.createBackup(), backup.createBackup()]);
    assert.notEqual(first, second);
    assert.ok(fs.existsSync(path.join(backupDir, first)));
    assert.ok(fs.existsSync(path.join(backupDir, second)));
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

  it('returns null and leaves no partial file for a corrupt source DB', async () => {
    const corruptDb  = path.join(tmpDir, 'corrupt.db');
    const isolatedDir = path.join(tmpDir, 'backups-corrupt');  // avoid same-second name collision with earlier tests
    fs.writeFileSync(corruptDb, 'this is not a sqlite database at all');
    backup._setPathsForTest(corruptDb, isolatedDir);
    assert.equal(await backup.createBackup(), null);
    assert.equal(backup.listBackups().length, 0, 'no partial backup left behind');
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
