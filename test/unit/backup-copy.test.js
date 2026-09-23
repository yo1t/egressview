'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { verifyCopy, copyAndVerify } = require('../../src/backup-copy');

// The copy that runs on the backup worker. The previous method never finished
// on a database that was being written (7,142 restarts in 12 minutes on a
// copy of the production database), and its check ran on the main thread for
// longer than the watchdog allows.

let dir;
let source;

function makeHubDb(file, { version = 31 } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE connections (dst TEXT, lastSeen INTEGER); CREATE TABLE devices (ip TEXT)');
  const insert = db.prepare('INSERT INTO connections VALUES (?, ?)');
  for (let i = 0; i < 50; i += 1) insert.run(`203.0.113.${i}`, i);
  db.pragma(`user_version = ${version}`);
  return db;
}

const EXPECTED = { sourceVersion: 31, sourceTables: ['connections', 'devices'] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-copy-'));
  source = path.join(dir, 'hub.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('copying a live database', () => {
  it('produces a whole, checked copy', () => {
    makeHubDb(source).close();
    const out = path.join(dir, 'out.db');
    const result = copyAndVerify(Database, { source, destination: out });
    assert.ok(result.bytes > 0);
    const copy = new Database(out, { readonly: true });
    try { assert.equal(copy.prepare('SELECT COUNT(*) n FROM connections').get().n, 50); } finally { copy.close(); }
  });

  // The live Hub has writes that are in the -wal and not yet in the main
  // file. A copy that missed them would be quietly out of date.
  it('includes writes still in the -wal, taken from a read-only connection', () => {
    const writer = makeHubDb(source);
    writer.prepare('INSERT INTO connections VALUES (?, ?)').run('198.51.100.1', 99);
    const out = path.join(dir, 'out.db');
    try {
      copyAndVerify(Database, { source, destination: out });
    } finally {
      writer.close();
    }
    const copy = new Database(out, { readonly: true });
    try { assert.equal(copy.prepare('SELECT COUNT(*) n FROM connections').get().n, 51); } finally { copy.close(); }
  });

  // The backup must never hold a write handle on the live database.
  it('opens the live database read-only', () => {
    makeHubDb(source).close();
    const opened = [];
    class Recording extends Database {
      constructor(file, options) {
        super(file, options);
        opened.push({ file, readonly: Boolean(options?.readonly) });
      }
    }
    copyAndVerify(Recording, { source, destination: path.join(dir, 'out.db') });
    const live = opened.filter(entry => entry.file === source);
    assert.ok(live.length > 0);
    assert.ok(live.every(entry => entry.readonly), 'the live database was opened for writing');
  });

  // The copy is written in rollback-journal mode, so checking it leaves
  // nothing beside it. The old method left a -shm next to every backup.
  it('leaves nothing beside the copy', () => {
    makeHubDb(source).close();
    const out = path.join(dir, 'out.db');
    copyAndVerify(Database, { source, destination: out });
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith('out.db')), ['out.db']);
  });
});

describe('checking a copy', () => {
  it('accepts a whole copy', () => {
    const copy = path.join(dir, 'whole.db');
    makeHubDb(copy).close();
    const db = new Database(copy); db.pragma('journal_mode = DELETE'); db.close();
    assert.ok(verifyCopy(Database, copy, EXPECTED) > 0);
  });

  // An empty file opens as an empty database and passes integrity_check.
  it('refuses a 0-byte copy, although integrity_check would pass it', () => {
    const copy = path.join(dir, 'zero.db');
    fs.writeFileSync(copy, '');
    // Refused on the first rule it breaks: it is schema v0 and has no tables.
    assert.throws(() => verifyCopy(Database, copy, EXPECTED), /schema v0|missing connections/);
  });

  it('refuses a copy missing a table the source has', () => {
    const copy = path.join(dir, 'partial.db');
    const db = new Database(copy);
    db.exec('CREATE TABLE connections (dst TEXT)');
    db.pragma('user_version = 31');
    db.close();
    assert.throws(() => verifyCopy(Database, copy, EXPECTED), /missing devices/);
  });

  it('refuses a copy on another schema version', () => {
    const copy = path.join(dir, 'version.db');
    const db = makeHubDb(copy, { version: 30 });
    db.pragma('journal_mode = DELETE');
    db.close();
    assert.throws(() => verifyCopy(Database, copy, EXPECTED), /schema v30, the source v31/);
  });

  // Everything else about this copy is right; only its length says it is not
  // the file that was written.
  it('refuses a copy longer than the pages it declares', () => {
    const copy = path.join(dir, 'padded.db');
    const db = makeHubDb(copy);
    db.pragma('journal_mode = DELETE');
    db.close();
    fs.appendFileSync(copy, Buffer.alloc(4096, 0));
    assert.throws(() => verifyCopy(Database, copy, EXPECTED), /declares/);
  });

  // A copy still in WAL mode could carry content in a -wal that was never
  // checked; reading it leaves a -shm, and that is what gives it away.
  it('refuses a copy that reading leaves something beside', () => {
    const copy = path.join(dir, 'wal-mode.db');
    makeHubDb(copy).close();
    fs.writeFileSync(`${copy}-shm`, '');
    assert.throws(() => verifyCopy(Database, copy, EXPECTED), /left a -(wal|shm)/);
  });

  it('refuses a copy whose data pages are damaged', () => {
    const copy = path.join(dir, 'damaged.db');
    const db = makeHubDb(copy);
    db.pragma('journal_mode = DELETE');
    const pageSize = db.pragma('page_size', { simple: true });
    db.close();
    const fd = fs.openSync(copy, 'r+');
    fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, pageSize + 8);
    fs.closeSync(fd);
    assert.throws(() => verifyCopy(Database, copy, EXPECTED), /integrity_check|malformed|corrupt/i);
  });
});
