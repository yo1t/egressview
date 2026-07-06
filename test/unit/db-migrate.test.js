// Unit tests for db-migrate.js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const os       = require('os');

const { runMigrations, SCHEMA_VERSION } = require('../../src/db-migrate');

const TMP = path.join(os.tmpdir(), 'egressview-migrate-test');

function tmpDb(name) {
  return path.join(TMP, name + '.db');
}

before(() => { fs.mkdirSync(TMP, { recursive: true }); });
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function openDb(p) {
  const d = new Database(p);
  d.pragma('journal_mode = WAL');
  d.pragma('busy_timeout = 5000');
  return d;
}

describe('db-migrate: fresh database', () => {
  it('sets user_version to SCHEMA_VERSION on a fresh DB', () => {
    const p = tmpDb('fresh');
    const db = openDb(p);
    try {
      runMigrations(db, p);
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    } finally {
      db.close();
      try { fs.unlinkSync(p); } catch {}
    }
  });

  it('does NOT create a backup for a fresh (empty) database', () => {
    const p = tmpDb('fresh-no-backup');
    const db = openDb(p);
    try {
      runMigrations(db, p);
      const files = fs.readdirSync(TMP).filter(f => f.includes('pre-migration'));
      assert.equal(files.length, 0, 'no backup expected for fresh DB');
    } finally {
      db.close();
      try { fs.unlinkSync(p); } catch {}
    }
  });
});

describe('db-migrate: legacy database (user_version=0, has tables)', () => {
  it('creates a pre-migration backup', () => {
    const p = tmpDb('legacy-backup');
    const db = openDb(p);
    // Simulate a legacy DB: create table manually, leave user_version=0
    db.exec(`CREATE TABLE connections (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT,
      firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto)
    )`);
    db.exec(`INSERT INTO connections VALUES ('192.168.1.1','8.8.8.8',443,'TCP',1,2)`);
    db.close();

    // Re-open and run migrations
    const db2 = openDb(p);
    runMigrations(db2, p);
    db2.close();

    const backups = fs.readdirSync(TMP).filter(f => f.includes('pre-migration'));
    assert.ok(backups.length >= 1, 'expected at least one backup file');
    // Clean up
    for (const f of backups) try { fs.unlinkSync(path.join(TMP, f)); } catch {}
    try { fs.unlinkSync(p); } catch {}
  });

  it('adds source column to existing connections table', () => {
    const p = tmpDb('legacy-source');
    const db = openDb(p);
    db.exec(`CREATE TABLE connections (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT,
      firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto)
    )`);
    db.close();

    const db2 = openDb(p);
    runMigrations(db2, p);
    const cols = db2.prepare('PRAGMA table_info(connections)').all().map(r => r.name);
    assert.ok(cols.includes('source'),    'source column must exist');
    assert.ok(cols.includes('agentHost'), 'agentHost column must exist');
    assert.ok(cols.includes('process'),   'process column must exist');
    assert.ok(cols.includes('pid'),       'pid column must exist');
    db2.close();
    // Clean up
    const backups = fs.readdirSync(TMP).filter(f => f.includes('pre-migration'));
    for (const f of backups) try { fs.unlinkSync(path.join(TMP, f)); } catch {}
    try { fs.unlinkSync(p); } catch {}
  });

  it('sets user_version to SCHEMA_VERSION after migration', () => {
    const p = tmpDb('legacy-version');
    const db = openDb(p);
    db.exec('CREATE TABLE connections (src TEXT, dst TEXT, dport INTEGER, proto TEXT, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, PRIMARY KEY (src, dst, dport, proto))');
    db.close();

    const db2 = openDb(p);
    runMigrations(db2, p);
    assert.equal(db2.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    db2.close();
    // Clean up
    const backups = fs.readdirSync(TMP).filter(f => f.includes('pre-migration'));
    for (const f of backups) try { fs.unlinkSync(path.join(TMP, f)); } catch {}
    try { fs.unlinkSync(p); } catch {}
  });
});

describe('db-migrate: up-to-date database', () => {
  it('is a no-op when user_version == SCHEMA_VERSION', () => {
    const p = tmpDb('current');
    const db = openDb(p);
    db.exec('CREATE TABLE connections (src TEXT, dst TEXT, dport INTEGER, proto TEXT, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, source TEXT NOT NULL DEFAULT \'yamaha\', agentHost TEXT, process TEXT, pid INTEGER, PRIMARY KEY (src, dst, dport, proto))');
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.close();

    const before = fs.readdirSync(TMP).filter(f => f.includes('pre-migration')).length;
    const db2 = openDb(p);
    runMigrations(db2, p);  // should be silent / no-op
    db2.close();
    const after = fs.readdirSync(TMP).filter(f => f.includes('pre-migration')).length;
    assert.equal(after, before, 'no backup should be created for up-to-date DB');
    try { fs.unlinkSync(p); } catch {}
  });
});

describe('db-migrate: in-memory database', () => {
  it('runs migrations without backup for :memory:', () => {
    const db = openDb(':memory:');
    // Should not throw, no backup attempted
    runMigrations(db, ':memory:');
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    db.close();
  });
});
