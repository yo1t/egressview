'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrations, SCHEMA_VERSION } = require('../../src/db-migrate');
const { CONNECTIONS_SQL, OBSERVATIONS_SQL, EVENTS_SQL } = require('../../src/history-schema');

/** What `initDb` does to a database, in the order it does it. */
function openLikeInitDb(db) {
  runMigrations(db, ':memory:', { sourceRouterMap: {} });
  db.exec(CONNECTIONS_SQL);
  db.exec(OBSERVATIONS_SQL);
  db.exec(EVENTS_SQL);
  return db;
}

function objects(db) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map(row => `${row.type}:${row.name}`);
}

// Repaired by re-running initDb's sequence after the object is dropped from a
// database already at the current version. Measured 2026-08-29.
const REPAIRED = [
  'index:idx_ai_notification_cause',
  'index:idx_ai_notification_created',
  'index:idx_dst',
  'index:idx_lastSeen',
  'index:idx_nlog_detectedAt',
  'index:idx_obs_lastSeen',
  'index:idx_obs_router',
  'index:idx_src',
  'table:ai_notification_events',
  'table:connection_observations',
  'table:connections',
  'table:notification_log',
  'table:routers',
];

describe('initDbが直接作るスキーマ（P2-97）', () => {
  it('migrationが作らない2テーブルは、ここでしか作られない', () => {
    // connections and notification_log predate migrations. If this ever fails
    // because a migration started creating them, this file's remaining reason
    // to exist has changed and the comment at the top is wrong.
    const db = new Database(':memory:');
    runMigrations(db, ':memory:', { sourceRouterMap: {} });
    const afterMigrations = new Set(objects(db));
    assert.ok(!afterMigrations.has('table:connections'));
    assert.ok(!afterMigrations.has('table:notification_log'));

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
    ]);
    db.close();
  });

  it('重複している定義は、migrationが作る表と列が一致している', () => {
    // These do nothing on a healthy database, but they are what a repair would
    // rebuild. A definition that has drifted would rebuild the wrong table
    // precisely when something is already wrong.
    const migrated = new Database(':memory:');
    runMigrations(migrated, ':memory:', { sourceRouterMap: {} });
    const direct = new Database(':memory:');
    direct.exec(CONNECTIONS_SQL);
    direct.exec(OBSERVATIONS_SQL);
    direct.exec(EVENTS_SQL);

    const shared = objects(direct)
      .filter(name => name.startsWith('table:'))
      .map(name => name.slice('table:'.length))
      .filter(name => objects(migrated).includes(`table:${name}`));
    assert.ok(shared.length >= 3, `expected shared tables, got ${shared.join(',')}`);

    for (const table of shared) {
      const columns = (db) => db.prepare(`PRAGMA table_info(${table})`).all()
        .map(c => c.name).sort();
      assert.deepEqual(columns(direct), columns(migrated), `${table} definitions have drifted`);
    }
    migrated.close();
    direct.close();
  });

  it('版が現在のままで欠けたオブジェクトは、13件だけが戻る', () => {
    // The point of this test is the 35, not the 13.
    //
    // Migrations never run again once user_version reaches the current
    // version, so on a database that says it is current while an object is
    // missing -- a restored upload, an interrupted operation -- these
    // statements are the only repair there is. They cover an arbitrary
    // fraction of the schema, decided by what happened to be written here.
    //
    // **A partial repair is not a safety net.** A database missing
    // agent_observations fails at runtime whatever happens to connections, and
    // recreating connections empty would present data loss as a working
    // system. This test states the split so it cannot drift unnoticed; making
    // it complete or explicit is open work.
    const reference = openLikeInitDb(new Database(':memory:'));
    const all = objects(reference);
    reference.close();

    const repaired = [];
    const lost = [];
    for (const entry of all) {
      const [type, name] = entry.split(':');
      const db = openLikeInitDb(new Database(':memory:'));
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
      db.exec(`DROP ${type === 'table' ? 'TABLE' : 'INDEX'} ${name}`);
      openLikeInitDb(db);
      (db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) ? repaired : lost)
        .push(entry);
      db.close();
    }

    assert.deepEqual(repaired.sort(), REPAIRED,
      'the set of objects a re-open can restore changed; update the comment in '
      + 'src/history-schema.js, which states this split as measured fact');
    assert.equal(repaired.length + lost.length, all.length);
    // Named explicitly: these are security-relevant and are not repaired.
    for (const unrepaired of ['table:audit_events', 'table:api_identities', 'table:agents']) {
      assert.ok(lost.includes(unrepaired), `${unrepaired} is expected to be unrepaired`);
    }
  });
});
