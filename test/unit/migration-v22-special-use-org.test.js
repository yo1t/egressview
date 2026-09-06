'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../src/db-migrate');

function v21Database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-v22-test-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE connections (src TEXT, dst TEXT, dstHost TEXT, org TEXT);
    CREATE TABLE notification_log (src TEXT, dst TEXT, dstHost TEXT, org TEXT);
  `);
  db.pragma('user_version = 21');
  return { db, file, dir };
}

// P3-59, measured on production 2026-09-06: 2,824 distinct destinations under
// one `Internet Assigned Numbers Authority` group, 21,120 rows, and not one of
// them a genuine public destination.
test('v22 clears the registry reservation name from special-use destinations', () => {
  const { db, file, dir } = v21Database();
  const insert = db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)');
  const iana = 'Internet Assigned Numbers Authority';
  insert.run('192.168.99.50', '10.9.9.9', '10.9.9.9', iana);
  insert.run('192.168.99.50', '169.254.169.254', '169.254.169.254', iana);
  insert.run('192.168.99.50', '192.0.0.6', '192.0.0.6', iana);
  insert.run('192.168.99.50', '198.18.0.1', '198.18.0.1', iana);
  insert.run('192.168.99.50', '100.64.1.10', '100.64.1.10', iana);

  runMigrations(db, file);

  const left = db.prepare('SELECT COUNT(*) FROM connections WHERE org IS NOT NULL').pluck().get();
  assert.equal(left, 0, 'a reservation name survived on a special-use destination');
  // The point of the change: the destination is now readable as its address.
  const shown = db.prepare(
    "SELECT COALESCE(NULLIF(org, ''), NULLIF(dstHost, ''), dst) FROM connections ORDER BY dst"
  ).pluck().all();
  assert.deepEqual(shown, ['10.9.9.9', '100.64.1.10', '169.254.169.254', '192.0.0.6', '198.18.0.1']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('v22 leaves a real destination its organization', () => {
  // The failure that would matter more than the one being fixed: a reader
  // looking at an address where a name belonged.
  const { db, file, dir } = v21Database();
  const insert = db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)');
  insert.run('192.168.99.50', '8.8.8.8', 'dns.google', 'Google LLC');
  insert.run('192.168.99.50', '52.219.1.2', 's3.example', 'Amazon.com, Inc.');
  // Just outside two of the ranges, where an off-by-one would show up.
  insert.run('192.168.99.50', '198.20.0.1', '198.20.0.1', 'Some Registrant');
  insert.run('192.168.99.50', '100.128.0.1', '100.128.0.1', 'Another Registrant');

  runMigrations(db, file);

  const orgs = db.prepare('SELECT org FROM connections ORDER BY dst').pluck().all();
  assert.deepEqual(orgs, ['Another Registrant', 'Some Registrant', 'Amazon.com, Inc.', 'Google LLC']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('v22 clears a dstHost that only restates a special-use address', () => {
  // Without this the cleared rows fall back to `dstHost` and the reader gets
  // the same emptiness in a different column. Measured: 49 rows across 27
  // destinations on production.
  const { db, file, dir } = v21Database();
  const insert = db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)');
  const iana = 'Internet Assigned Numbers Authority';
  insert.run('192.168.99.50', '172.16.173.1', 'ip-172-16-173-1.ap-northeast-1.compute.internal', iana);
  insert.run('192.168.99.50', '10.9.9.10', 'ip-10-9-9-10.ap-northeast-1.compute.internal', iana);
  // A name somebody chose, on a private address. It identifies the
  // destination, so it stays.
  insert.run('192.168.99.50', '192.168.99.7', 'pixel.advertising.com', iana);
  // A junk name on a real public destination is v21's business, not v22's.
  insert.run('192.168.99.50', '54.1.2.3', 'ec2-54-1-2-3.compute-1.amazonaws.com', 'Amazon.com, Inc.');

  runMigrations(db, file);

  const shown = db.prepare(
    "SELECT COALESCE(NULLIF(org, ''), NULLIF(dstHost, ''), dst) FROM connections ORDER BY dst"
  ).pluck().all();
  assert.deepEqual(shown, [
    '10.9.9.10',
    '172.16.173.1',
    'pixel.advertising.com',
    'Amazon.com, Inc.',
  ]);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('v22 runs on a database that has neither table', () => {
  // An empty database builds the connections DDL after the migrations, and
  // older databases predate notification_log. Neither may fail the upgrade.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-v22-empty-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  db.pragma('user_version = 21');
  runMigrations(db, file);
  assert.equal(db.pragma('user_version', { simple: true }), 22);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('v22 also cleans notification_log', () => {
  const { db, file, dir } = v21Database();
  db.prepare('INSERT INTO notification_log VALUES (?, ?, ?, ?)')
    .run('192.168.99.50', '198.18.0.4', '198.18.0.4', 'Internet Assigned Numbers Authority');
  runMigrations(db, file);
  assert.equal(db.prepare('SELECT org FROM notification_log').pluck().get(), null);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
