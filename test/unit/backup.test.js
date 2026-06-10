// Unit tests for src/backup.js
// Run: node --test test/unit/backup.test.js

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const backup = require('../../src/backup');

// ─── Temp directory helpers ───────────────────────────────────────────────────

let tmpDir, fakeDb, backupDir;

function setup() {
  tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'widemap-backup-test-'));
  fakeDb    = path.join(tmpDir, 'test.db');
  backupDir = path.join(tmpDir, 'backups');
  fs.writeFileSync(fakeDb, 'fake-db-content');
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
    assert.equal(backup.getBackupPath('widemap_2025-01-01_00-00-00.db'), null);
  });

  it('returns the full path for an existing backup file', () => {
    // Create a fake backup file
    fs.mkdirSync(backupDir, { recursive: true });
    const name = 'widemap_2025-01-01_00-00-00.db';
    fs.writeFileSync(path.join(backupDir, name), 'data');
    const p = backup.getBackupPath(name);
    assert.ok(p.endsWith(name));
    assert.ok(fs.existsSync(p));
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
    fs.writeFileSync(path.join(backupDir, 'widemap_2025-01-03_00-00-00.db'), 'c');
    fs.writeFileSync(path.join(backupDir, 'widemap_2025-01-01_00-00-00.db'), 'a');
    fs.writeFileSync(path.join(backupDir, 'widemap_2025-01-02_00-00-00.db'), 'b');
    const list = backup.listBackups();
    assert.equal(list.length, 3);
    assert.equal(list[0].name, 'widemap_2025-01-01_00-00-00.db');
    assert.equal(list[2].name, 'widemap_2025-01-03_00-00-00.db');
  });

  it('ignores non-.db files', () => {
    fs.writeFileSync(path.join(backupDir, 'widemap_2025-01-01_00-00-00.db'), 'ok');
    fs.writeFileSync(path.join(backupDir, 'README.txt'), 'ignore me');
    assert.equal(backup.listBackups().length, 1);
  });

  it('each entry has name, size, created fields', () => {
    fs.writeFileSync(path.join(backupDir, 'widemap_2025-01-01_00-00-00.db'), 'hello');
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

  it('returns null when database file does not exist', () => {
    backup._setPathsForTest(path.join(tmpDir, 'nonexistent.db'), backupDir);
    assert.equal(backup.createBackup(), null);
    // restore
    backup._setPathsForTest(fakeDb, backupDir);
  });

  it('creates a backup file and returns its name', () => {
    const name = backup.createBackup();
    assert.ok(typeof name === 'string');
    assert.ok(name.startsWith('widemap_'));
    assert.ok(name.endsWith('.db'));
    const p = path.join(backupDir, name);
    assert.ok(fs.existsSync(p));
  });

  it('backup file contains the same content as the source DB', () => {
    const name = backup.createBackup();
    const content = fs.readFileSync(path.join(backupDir, name), 'utf8');
    assert.equal(content, 'fake-db-content');
  });
});

describe('pruneOldBackups', () => {
  before(() => {
    setup();
    backup.configure({ maxGenerations: 3 });
    fs.mkdirSync(backupDir, { recursive: true });
  });
  after(teardown);

  it('removes oldest files when count exceeds maxGenerations', () => {
    // Create 5 fake backup files
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(backupDir, `widemap_2025-01-0${i}_00-00-00.db`), 'x');
    }
    // Trigger prune by creating one more backup (createBackup calls pruneOldBackups)
    backup.createBackup();
    const list = backup.listBackups();
    assert.ok(list.length <= 3, `Expected ≤3 backups, got ${list.length}`);
  });
});

// ─── restoreFromFile ──────────────────────────────────────────────────────────

describe('restoreFromFile', () => {
  before(setup);
  after(teardown);

  it('throws when source file does not exist', () => {
    assert.throws(
      () => backup.restoreFromFile(path.join(tmpDir, 'ghost.db')),
      /not found/i
    );
  });

  it('copies source file to DB path', () => {
    const src = path.join(tmpDir, 'restore-src.db');
    fs.writeFileSync(src, 'restored-content');
    backup.restoreFromFile(src);
    const result = fs.readFileSync(fakeDb, 'utf8');
    assert.equal(result, 'restored-content');
  });
});

// ─── restoreFromGeneration ────────────────────────────────────────────────────

describe('restoreFromGeneration', () => {
  before(setup);
  after(teardown);

  it('throws for an unknown backup name', () => {
    assert.throws(
      () => backup.restoreFromGeneration('widemap_9999-01-01_00-00-00.db'),
      /not found/i
    );
  });

  it('restores successfully from an existing generation', () => {
    // Use a fixed past timestamp so the safety backup (created inside
    // restoreFromFile) gets a different name and does not overwrite
    // the source backup we want to restore from.
    const name = 'widemap_2025-01-01_12-00-00.db';
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, name), 'fake-db-content');

    // Overwrite DB with different content
    fs.writeFileSync(fakeDb, 'overwritten');
    backup.restoreFromGeneration(name);
    const result = fs.readFileSync(fakeDb, 'utf8');
    assert.equal(result, 'fake-db-content');
  });
});
