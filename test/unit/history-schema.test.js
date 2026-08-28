'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrations, SCHEMA_VERSION } = require('../../src/db-migrate');
const { CONNECTIONS_SQL, OBSERVATIONS_SQL, EVENTS_SQL } = require('../../src/history-schema');

function objects(db) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map(row => `${row.type}:${row.name}`);
}

describe('新規DBのスキーマ（P2-97）', () => {
  it('migrationが作らないものだけが、ここで実際に作られる', () => {
    // `initDb` runs migrations before this SQL, and on an empty database they
    // build the schema from version 0 upward. What is left for these
    // statements to create is small, and pinning it is the point: everything
    // else here is `IF NOT EXISTS` over tables that already exist, so editing
    // one of those definitions changes nothing anywhere.
    const db = new Database(':memory:');
    runMigrations(db, ':memory:', { sourceRouterMap: {} });
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);

    const afterMigrations = new Set(objects(db));
    db.exec(CONNECTIONS_SQL);
    db.exec(OBSERVATIONS_SQL);
    db.exec(EVENTS_SQL);
    const created = objects(db).filter(name => !afterMigrations.has(name));

    assert.deepEqual(created.sort(), [
      'index:idx_dst',
      'index:idx_lastSeen',
      'index:idx_nlog_detectedAt',
      'index:idx_src',
      'table:connections',
      'table:notification_log',
    ], 'if this list grew, a definition was added where migrations should own it; '
      + 'if it shrank, a migration now creates something this file still claims to');
    db.close();
  });

  it('二度流しても壊れない', () => {
    // Every statement is IF NOT EXISTS, which is what lets this run over a
    // database the migrations already built.
    const db = new Database(':memory:');
    runMigrations(db, ':memory:', { sourceRouterMap: {} });
    for (let pass = 0; pass < 2; pass += 1) {
      db.exec(CONNECTIONS_SQL);
      db.exec(OBSERVATIONS_SQL);
      db.exec(EVENTS_SQL);
    }
    assert.ok(objects(db).includes('table:connections'));
    db.close();
  });
});
