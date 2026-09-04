'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../src/db-migrate');

function v20Database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-v21-test-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE connections (src TEXT, dst TEXT, srcDnsName TEXT, dstHost TEXT);
    CREATE TABLE devices (ip TEXT, dnsName TEXT);
  `);
  db.pragma('user_version = 20');
  return { db, file, dir };
}

// Measured on production 2026-09-04: 386,343 connection rows carried a name
// that only restated the address, and not one carried a genuine name. The
// destination side had always dropped these; the source side stored them.
test('v21 clears names that only restate the address', () => {
  const { db, file, dir } = v20Database();
  const insert = db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)');
  insert.run('192.168.41.33', '1.1.1.1', 'ip-192-168-41-33.ap-northeast-1.compute.internal', null);
  insert.run('10.0.0.5', '1.1.1.1', 'ec2-1-2-3-4.compute-1.amazonaws.com', null);
  insert.run('10.0.0.6', '1.1.1.1', '5.0.0.10.in-addr.arpa', null);
  runMigrations(db, file);
  const left = db.prepare('SELECT COUNT(*) FROM connections WHERE srcDnsName IS NOT NULL').pluck().get();
  assert.equal(left, 0, 'a name that restates the address survived');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Starting with "ip-" is not a reason to drop a name. ip-api.com is a real
// service and an ISP's ip-<x>-<y>-<z>.<domain> carries the ISP.
test('v21 keeps genuine names, including ones that start with ip-', () => {
  const { db, file, dir } = v20Database();
  const insert = db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)');
  insert.run('192.168.41.34', '1.1.1.1', 'printer.local', 'one.one.one.one');
  insert.run('192.168.41.35', '208.95.112.1', 'nas.home', 'ip-api.com');
  insert.run('192.168.41.36', '103.253.24.69', 'laptop', 'ip-253-24-69.axgn.com');
  runMigrations(db, file);
  const names = db.prepare('SELECT srcDnsName FROM connections ORDER BY src').pluck().all();
  assert.deepEqual(names, ['printer.local', 'nas.home', 'laptop']);
  const hosts = db.prepare('SELECT dstHost FROM connections ORDER BY src').pluck().all();
  assert.deepEqual(hosts, ['one.one.one.one', 'ip-api.com', 'ip-253-24-69.axgn.com'],
    'v21 must not touch destination names');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v21 clears the device table too', () => {
  const { db, file, dir } = v20Database();
  const insert = db.prepare('INSERT INTO devices VALUES (?, ?)');
  insert.run('192.168.41.33', 'ip-192-168-41-33.ap-northeast-1.compute.internal');
  insert.run('192.168.41.34', 'printer.local');
  runMigrations(db, file);
  const rows = db.prepare('SELECT ip, dnsName FROM devices ORDER BY ip').all();
  assert.equal(rows[0].dnsName, null);
  assert.equal(rows[1].dnsName, 'printer.local');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// An empty database builds connections after the migrations run, and older
// databases predate the device tables, so v21 must not require either.
test('v21 runs on a database that has none of those tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-v21-empty-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  runMigrations(db, file);
  assert.equal(db.pragma('user_version', { simple: true }), 21);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
