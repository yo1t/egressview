// Unit tests for db-migrate.js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const os       = require('os');

const { runMigrations, SCHEMA_VERSION, _assertDiskSpace, _verifyDbCopy, _MIGRATIONS } = require('../../src/db-migrate');

let TMP;

function tmpDb(name) {
  return path.join(TMP, name + '.db');
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), `egressview-migrate-test-${process.pid}-`));
});
after(() => {
  if (TMP) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
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

  it('creates append-only AI conversation, usage, and notification tables at v8', () => {
    const db = openDb(':memory:');
    runMigrations(db, ':memory:');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(row => row.name);
    assert.ok(tables.includes('ai_conversations'));
    assert.ok(tables.includes('ai_messages'));
    assert.ok(tables.includes('ai_usage'));
    assert.ok(tables.includes('ai_notification_events'));
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(row => row.name);
    assert.ok(indexes.includes('idx_ai_messages_conversation'));
    assert.ok(indexes.includes('idx_ai_usage_created'));
    assert.ok(indexes.includes('idx_ai_notification_created'));
    db.close();
  });

  it('creates the additive Hub-Agent v13 schema and indexes', () => {
    const db = openDb(':memory:');
    runMigrations(db, ':memory:');
    const tables = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(row => row.name)
    );
    for (const table of [
      'agent_enrollment_tokens',
      'agents',
      'agent_ingest_batches',
      'agent_observations',
      'connection_agent_observations',
    ]) {
      assert.ok(tables.has(table), `missing ${table}`);
    }

    const indexes = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(row => row.name)
    );
    for (const index of [
      'idx_agent_enrollment_expiry',
      'idx_agents_active',
      'idx_agent_batches_received',
      'idx_agent_observations_time',
      'idx_agent_observations_flow_time',
      'idx_agent_observations_batch',
      'idx_connection_agent_observation',
      'idx_connection_agent_connection',
    ]) {
      assert.ok(indexes.has(index), `missing ${index}`);
    }
    db.close();
  });

  it('creates the additive v14 AI message scope table', () => {
    const db = openDb(':memory:');
    runMigrations(db, ':memory:');
    const columns = db.prepare('PRAGMA table_info(ai_message_scopes)').all().map(row => row.name);
    assert.deepEqual(columns, ['messageId', 'sourceKind', 'sourceId']);
    assert.throws(() => db.prepare(`
      INSERT INTO ai_message_scopes (messageId, sourceKind, sourceId)
      VALUES ('missing', 'unknown', 'source')
    `).run(), /CHECK constraint failed/);
    db.close();
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

  it('adds current metadata columns and removes the legacy source column', () => {
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
    assert.ok(!cols.includes('source'),   'source column must be removed by v5');
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
    db.exec('CREATE TABLE connections (src TEXT, dst TEXT, dport INTEGER, proto TEXT, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, agentHost TEXT, process TEXT, pid INTEGER, PRIMARY KEY (src, dst, dport, proto))');
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

describe('db-migrate: v11 browser roles', () => {
  it('keeps local sessions as admin and revokes OIDC or unknown sessions', () => {
    const db = openDb(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tokenHash TEXT NOT NULL UNIQUE,
        deviceLabel TEXT,
        createdAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        csrfHash TEXT,
        authMethod TEXT NOT NULL DEFAULT 'local',
        subjectHash TEXT
      );
      INSERT INTO sessions
        (tokenHash, createdAt, lastSeenAt, expiresAt, authMethod)
      VALUES
        ('local-token', 1, 1, 9999999999999, 'local'),
        ('oidc-token', 1, 1, 9999999999999, 'oidc'),
        ('future-token', 1, 1, 9999999999999, 'future-auth');
    `);
    db.pragma('user_version = 10');

    runMigrations(db, ':memory:');

    assert.deepEqual(
      db.prepare('SELECT tokenHash, authMethod, role FROM sessions').all(),
      [{ tokenHash: 'local-token', authMethod: 'local', role: 'admin' }]
    );
    const roleColumn = db.prepare('PRAGMA table_info(sessions)').all()
      .find(column => column.name === 'role');
    assert.equal(roleColumn.dflt_value, "'viewer'");
    db.close();
  });
});

describe('db-migrate: v13 Hub-Agent and v14 AI scope additive schemas', () => {
  it('preserves v13 AI messages and creates a verified v13-to-v14 backup', () => {
    const p = tmpDb('v14-ai-scope-upgrade');
    let db = openDb(p);
    runMigrations(db, p);
    db.prepare(`
      INSERT INTO ai_conversations
        (conversationId, createdAt, provider, model, rangeFrom, rangeTo)
      VALUES ('c1', 1, 'ollama', 'm1', 0, 1)
    `).run();
    db.prepare(`
      INSERT INTO ai_messages
        (messageId, conversationId, requestId, role, body, createdAt,
         provider, model, rangeFrom, rangeTo, status, errorCode)
      VALUES ('m1', 'c1', 'r1', 'user', 'keep-me', 2,
              'ollama', 'm1', 0, 1, 'complete', NULL)
    `).run();
    db.exec('DROP TABLE ai_message_scopes');
    db.pragma('user_version = 13');
    db.close();

    db = openDb(p);
    runMigrations(db, p);
    // Asserting the constant, not a literal: this test is about v13 data
    // surviving an upgrade, and hardcoding the target breaks it every time a
    // later migration is added.
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(db.prepare(`SELECT body FROM ai_messages WHERE messageId = 'm1'`).get().body, 'keep-me');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_message_scopes').get().count, 0);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();

    const backups = fs.readdirSync(TMP)
      .filter(name => name.startsWith(`v14-ai-scope-upgrade.db.pre-migration.v13-to-v${SCHEMA_VERSION}`));
    assert.equal(backups.length, 1);
    _verifyDbCopy(path.join(TMP, backups[0]));
  });

  it('preserves v12 data and creates a verified backup on upgrade', () => {
    const p = tmpDb('v13-agent-upgrade');
    const db = openDb(p);
    db.exec(`
      CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO sentinel VALUES (1, 'keep-me');
    `);
    db.pragma('user_version = 12');
    db.close();

    const upgraded = openDb(p);
    runMigrations(upgraded, p);
    assert.equal(upgraded.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(upgraded.prepare('SELECT value FROM sentinel WHERE id = 1').get().value, 'keep-me');
    assert.ok(upgraded.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_observations'`
    ).get());
    assert.ok(upgraded.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='ai_message_scopes'`
    ).get());
    assert.equal(upgraded.pragma('integrity_check', { simple: true }), 'ok');
    upgraded.close();

    const backups = fs.readdirSync(TMP)
      .filter(name => name.startsWith(`v13-agent-upgrade.db.pre-migration.v12-to-v${SCHEMA_VERSION}`));
    assert.equal(backups.length, 1);
    const backupPath = path.join(TMP, backups[0]);
    _verifyDbCopy(backupPath);
    const backup = new Database(backupPath, { readonly: true });
    assert.equal(backup.pragma('user_version', { simple: true }), 12);
    assert.equal(backup.prepare('SELECT value FROM sentinel WHERE id = 1').get().value, 'keep-me');
    assert.equal(backup.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_observations'`
    ).get(), undefined);
    assert.equal(backup.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='ai_message_scopes'`
    ).get(), undefined);
    backup.close();
  });

  it('enforces observation provenance and range constraints', () => {
    const db = openDb(':memory:');
    runMigrations(db, ':memory:');
    const insert = db.prepare(`
      INSERT INTO agent_observations (
        agentId, observationId, batchId, networkProtocol,
        localAddress, localPort, remoteAddress, remotePort,
        processId, processName, bundleId, firstObservedAt, lastObservedAt,
        bytesIn, bytesOut, collector, confidence, receivedAt
      ) VALUES (
        @agentId, @observationId, @batchId, @networkProtocol,
        @localAddress, @localPort, @remoteAddress, @remotePort,
        @processId, @processName, @bundleId, @firstObservedAt, @lastObservedAt,
        @bytesIn, @bytesOut, @collector, @confidence, @receivedAt
      )
    `);
    const valid = {
      agentId: 'agent-1', observationId: 'obs-1', batchId: 'batch-1',
      networkProtocol: 'tcp', localAddress: '192.0.2.10', localPort: 49152,
      remoteAddress: '198.51.100.20', remotePort: 443,
      processId: 42, processName: 'Example', bundleId: 'com.example.app',
      firstObservedAt: 100, lastObservedAt: 200,
      bytesIn: '18446744073709551615', bytesOut: null,
      collector: 'network-extension', confidence: 'exact', receivedAt: 201,
    };
    insert.run(valid);
    insert.run({ ...valid, observationId: 'obs-2', localPort: 0 });
    assert.throws(() => insert.run({ ...valid, observationId: 'obs-3', remotePort: 0 }));
    assert.throws(() => insert.run({ ...valid, observationId: 'obs-4', lastObservedAt: 99 }));
    assert.throws(() => insert.run({ ...valid, observationId: 'obs-5', bytesIn: '12x' }));
    assert.throws(() => insert.run({
      ...valid,
      observationId: 'obs-6',
      bytesIn: '18446744073709551616',
    }));
    assert.throws(() => insert.run({ ...valid, observationId: 'obs-7', bytesIn: '01' }));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 2);
    db.close();
  });

  it('migrates v16 Agent observations to v17 without losing data or indexes', () => {
    const p = tmpDb('v17-agent-local-port');
    let db = openDb(p);
    for (const migration of _MIGRATIONS.filter(item => item.version <= 16)) {
      db.transaction(() => {
        migration.up(db, {});
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
    db.prepare(`
      INSERT INTO agent_observations (
        agentId, observationId, batchId, networkProtocol,
        localAddress, localPort, remoteAddress, remotePort,
        processId, processName, bundleId, firstObservedAt, lastObservedAt,
        bytesIn, bytesOut, collector, confidence, receivedAt
      ) VALUES ('agent-1', 'obs-1', 'batch-1', 'tcp',
        '192.0.2.10', 49152, '198.51.100.20', 443,
        42, 'Example', NULL, 100, 200, NULL, NULL,
        'network-extension', 'exact', 201)
    `).run();
    db.close();

    db = openDb(p);
    runMigrations(db, p);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT localPort FROM agent_observations WHERE observationId = ?').get('obs-1').localPort, 49152);
    const indexes = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(row => row.name));
    for (const name of [
      'idx_agent_observations_time',
      'idx_agent_observations_flow_time',
      'idx_agent_observations_batch',
      'idx_agent_observations_agent_flow',
    ]) assert(indexes.has(name), `missing ${name}`);
    const zeroPort = db.prepare(`
      INSERT INTO agent_observations
      SELECT agentId, 'obs-2', batchId, networkProtocol,
        localAddress, 0, remoteAddress, remotePort,
        processId, processName, bundleId, firstObservedAt, lastObservedAt,
        bytesIn, bytesOut, collector, confidence, receivedAt
      FROM agent_observations WHERE observationId = 'obs-1'
    `).run();
    assert.equal(zeroPort.changes, 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();

    const backups = fs.readdirSync(TMP)
      .filter(name => name.startsWith(`v17-agent-local-port.db.pre-migration.v16-to-v${SCHEMA_VERSION}`));
    assert.equal(backups.length, 1);
    _verifyDbCopy(path.join(TMP, backups[0]));
  });

  it('rolls back all new v13 objects when an incompatible pre-existing table causes failure', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE agents (agentId TEXT PRIMARY KEY)');
    db.pragma('user_version = 12');

    assert.throws(() => runMigrations(db, ':memory:'));
    assert.equal(db.pragma('user_version', { simple: true }), 12);
    assert.equal(db.prepare('PRAGMA table_info(agents)').all().length, 1);
    assert.equal(db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_observations'`
    ).get(), undefined);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
  });

  it('backfills the v19 hourly Agent application rollup without losing app identities', () => {
    const p = tmpDb('v19-agent-app-hourly');
    const db = openDb(p);
    for (const migration of _MIGRATIONS.filter(item => item.version <= 18)) {
      db.transaction(() => {
        migration.up(db, {});
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
    const insert = db.prepare(`
      INSERT INTO agent_observations (
        agentId, observationId, batchId, networkProtocol,
        localAddress, localPort, remoteAddress, remotePort,
        processId, processName, bundleId, firstObservedAt, lastObservedAt,
        bytesIn, bytesOut, collector, confidence, receivedAt
      ) VALUES ('agent-1', ?, 'batch-1', 'tcp',
        '192.0.2.10', ?, '198.51.100.20', 443,
        ?, 'Example Helper', 'com.example.app', ?, ?, NULL, NULL,
        'network-extension', 'exact', ?)
    `);
    insert.run('obs-1', 49152, 42, 3_600_100, 3_600_200, 3_600_201);
    insert.run('obs-2', 49153, 43, 3_600_300, 3_600_400, 3_600_401);

    runMigrations(db, p);

    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    const rollup = db.prepare('SELECT * FROM agent_app_hourly').get();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_app_hourly').get().n, 1);
    assert.equal(rollup.hourStart, 3_600_000);
    assert.equal(rollup.appIdentity, 'com.example.app');
    assert.equal(rollup.firstObservedAt, 3_600_100);
    assert.equal(rollup.lastObservedAt, 3_600_400);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
  });

  it('migrates v19 Agent observations to v20 and accepts ETW without losing data', () => {
    const p = tmpDb('v20-agent-etw');
    const db = openDb(p);
    for (const migration of _MIGRATIONS.filter(item => item.version <= 19)) {
      db.transaction(() => {
        migration.up(db, {});
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
    db.prepare(`
      INSERT INTO agent_observations (
        agentId, observationId, batchId, networkProtocol,
        localAddress, localPort, remoteAddress, remotePort,
        processId, processName, bundleId, firstObservedAt, lastObservedAt,
        bytesIn, bytesOut, collector, confidence, receivedAt
      ) VALUES ('agent-1', 'obs-macos', 'batch-1', 'tcp',
        '192.0.2.10', 49152, '198.51.100.20', 443,
        42, 'Example', NULL, 100, 200, NULL, NULL,
        'network-extension', 'exact', 201)
    `).run();

    runMigrations(db, p);

    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT collector FROM agent_observations').get().collector, 'network-extension');
    const insertEtw = db.prepare(`
      INSERT INTO agent_observations
      SELECT agentId, 'obs-windows', 'batch-2', networkProtocol,
        localAddress, localPort, remoteAddress, remotePort,
        processId, 'Windows App', bundleId, firstObservedAt, lastObservedAt,
        bytesIn, bytesOut, 'etw', confidence, receivedAt
      FROM agent_observations WHERE observationId = 'obs-macos'
    `).run();
    assert.equal(insertEtw.changes, 1);
    assert.throws(() => db.prepare(`
      INSERT INTO agent_observations
      SELECT agentId, 'obs-invalid', 'batch-3', networkProtocol,
        localAddress, localPort, remoteAddress, remotePort,
        processId, processName, bundleId, firstObservedAt, lastObservedAt,
        bytesIn, bytesOut, 'unknown', confidence, receivedAt
      FROM agent_observations WHERE observationId = 'obs-macos'
    `).run(), /CHECK constraint failed/);
    const indexes = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index'"
    ).all().map(row => row.name));
    for (const name of [
      'idx_agent_observations_time',
      'idx_agent_observations_flow_time',
      'idx_agent_observations_batch',
      'idx_agent_observations_agent_flow',
    ]) assert(indexes.has(name), `missing ${name}`);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();

    const backups = fs.readdirSync(TMP)
      .filter(name => name.startsWith(`v20-agent-etw.db.pre-migration.v19-to-v${SCHEMA_VERSION}`));
    assert.equal(backups.length, 1);
    _verifyDbCopy(path.join(TMP, backups[0]));
  });
});

// ─── P2-30 v4/v5: expand observations, then remove source ─────────────────────

describe('db-migrate: v4 observation backfill', () => {
  function legacyV3Db(p) {
    const db = openDb(p);
    db.exec(`CREATE TABLE connections (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT,
      firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'yamaha',
      agentHost TEXT, process TEXT, pid INTEGER,
      PRIMARY KEY (src, dst, dport, proto)
    )`);
    db.pragma('user_version = 3');
    const ins = db.prepare('INSERT INTO connections (src,dst,dport,proto,firstSeen,lastSeen,source) VALUES (?,?,?,?,?,?,?)');
    ins.run('192.168.1.10', '8.8.8.8', 443, 'TCP', 100, 200, 'yamaha');
    ins.run('192.168.1.10', '9.9.9.9', 53,  'UDP', 110, 210, 'cisco');
    ins.run('192.168.1.11', '8.8.4.4', 443, 'TCP', 120, 220, 'yamaha+cisco');
    ins.run('192.168.1.12', '1.1.1.1', 80,  'TCP', 130, 230, 'inspect');
    ins.run('192.168.1.13', '2.2.2.2', 22,  'TCP', 140, 240, 'weird source!');
    return db;
  }

  it('expands every source into observation rows with the migrated ids', () => {
    const p = tmpDb('v4-backfill');
    const db = legacyV3Db(p);
    runMigrations(db, p, { sourceRouterMap: { yamaha: 'yamaha1', cisco: 'cisco1' } });

    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    const columns = db.prepare('PRAGMA table_info(connections)').all().map(row => row.name);
    assert.ok(!columns.includes('source'));
    const obs = db.prepare('SELECT * FROM connection_observations ORDER BY src, routerId').all();
    // yamaha:1 + cisco:1 + yamaha+cisco:2 + inspect:1 + unknown:1 = 6 rows
    assert.equal(obs.length, 6);

    const byConn = key => obs.filter(o => `${o.src}|${o.dst}` === key).map(o => o.routerId).sort();
    assert.deepEqual(byConn('192.168.1.10|8.8.8.8'), ['yamaha1']);
    assert.deepEqual(byConn('192.168.1.10|9.9.9.9'), ['cisco1']);
    assert.deepEqual(byConn('192.168.1.11|8.8.4.4'), ['cisco1', 'yamaha1']);
    assert.deepEqual(byConn('192.168.1.12|1.1.1.1'), ['yamaha1'], 'inspect maps to yamaha');
    assert.deepEqual(byConn('192.168.1.13|2.2.2.2'), ['legacy-weird-source']);

    // observation timestamps copy firstSeen/lastSeen
    const first = obs.find(o => o.dst === '8.8.8.8');
    assert.equal(first.firstObservedAt, 100);
    assert.equal(first.lastObservedAt, 200);

    // routers table: migrated ids active, placeholder tombstoned
    const routers = Object.fromEntries(db.prepare('SELECT * FROM routers').all().map(r => [r.id, r]));
    assert.equal(routers['yamaha1'].deletedAt, null);
    assert.equal(routers['cisco1'].deletedAt, null);
    assert.ok(routers['legacy-weird-source'].deletedAt, 'unknown source placeholder is tombstoned');

    db.close();
    const backups = fs.readdirSync(TMP).filter(f => f.includes('pre-migration'));
    for (const f of backups) try { fs.unlinkSync(path.join(TMP, f)); } catch {}
    try { fs.unlinkSync(p); } catch {}
  });

  it('maps sources to legacy placeholders when the config section is gone', () => {
    const p = tmpDb('v4-legacy-map');
    const db = legacyV3Db(p);
    runMigrations(db, p, { sourceRouterMap: { yamaha: 'yamaha1', cisco: 'legacy-cisco' } });

    const ciscoObs = db.prepare(`SELECT routerId FROM connection_observations WHERE dst = '9.9.9.9'`).all();
    assert.deepEqual(ciscoObs.map(o => o.routerId), ['legacy-cisco']);
    const row = db.prepare(`SELECT * FROM routers WHERE id = 'legacy-cisco'`).get();
    assert.equal(row.kind, 'cisco');
    assert.ok(row.deletedAt, 'legacy placeholder is tombstoned');

    db.close();
    const backups = fs.readdirSync(TMP).filter(f => f.includes('pre-migration'));
    for (const f of backups) try { fs.unlinkSync(path.join(TMP, f)); } catch {}
    try { fs.unlinkSync(p); } catch {}
  });

  it('creates empty v4 tables on a fresh database', () => {
    const db = openDb(':memory:');
    runMigrations(db, ':memory:');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    assert.ok(tables.includes('routers'));
    assert.ok(tables.includes('connection_observations'));
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    db.close();
  });
});

describe('db-migrate: v5 source contract', () => {
  function v4Db(p, { withObservation = true } = {}) {
    const db = openDb(p);
    db.exec(`
      CREATE TABLE connections (
        src TEXT, dst TEXT, dport INTEGER, proto TEXT,
        firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'yamaha',
        agentHost TEXT, process TEXT, pid INTEGER,
        PRIMARY KEY (src, dst, dport, proto)
      );
      CREATE TABLE routers (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, displayName TEXT NOT NULL,
        createdAt INTEGER NOT NULL, deletedAt INTEGER
      );
      CREATE TABLE connection_observations (
        src TEXT, dst TEXT, dport INTEGER, proto TEXT, routerId TEXT,
        firstObservedAt INTEGER NOT NULL, lastObservedAt INTEGER NOT NULL,
        PRIMARY KEY (src, dst, dport, proto, routerId)
      );
      INSERT INTO connections VALUES
        ('192.168.1.10', '8.8.8.8', 443, 'TCP', 100, 200, 'yamaha', NULL, NULL, NULL);
      INSERT INTO routers VALUES ('yamaha1', 'yamaha', 'Yamaha', 1, NULL);
    `);
    if (withObservation) {
      db.exec(`INSERT INTO connection_observations VALUES
        ('192.168.1.10', '8.8.8.8', 443, 'TCP', 'yamaha1', 100, 200)`);
    }
    db.pragma('user_version = 4');
    return db;
  }

  it('removes source only after preserving connection and observation data', () => {
    const p = tmpDb('v5-contract');
    const db = v4Db(p);
    runMigrations(db, p);

    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    const columns = db.prepare('PRAGMA table_info(connections)').all().map(row => row.name);
    assert.ok(!columns.includes('source'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection_observations').get().n, 1);
    assert.equal(db.prepare('SELECT lastSeen FROM connections').get().lastSeen, 200);
    db.close();
  });

  it('fails closed and retains v4 when an observation is missing', () => {
    const p = tmpDb('v5-inconsistent');
    const db = v4Db(p, { withObservation: false });

    assert.throws(() => runMigrations(db, p), /v5 consistency gate failed/);
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    const columns = db.prepare('PRAGMA table_info(connections)').all().map(row => row.name);
    assert.ok(columns.includes('source'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 1);
    db.close();
  });
});

// ─── P2-33: fail-closed backup ────────────────────────────────────────────────

describe('db-migrate: fail-closed backup (P2-33)', () => {
  it('aborts migration and leaves the DB unmodified when the backup cannot be written', () => {
    const dir = path.join(TMP, 'readonly-dir');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'locked.db');
    const db = openDb(p);
    db.exec('CREATE TABLE connections (src TEXT, dst TEXT, dport INTEGER, proto TEXT, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, PRIMARY KEY (src, dst, dport, proto))');
    db.exec(`INSERT INTO connections VALUES ('192.168.1.1','8.8.8.8',443,'TCP',1,2)`);
    db.close();

    const db2 = openDb(p);
    fs.chmodSync(dir, 0o500);  // deny writes: copyFileSync must fail
    try {
      assert.throws(() => runMigrations(db2, p));
      // fail-closed: version not advanced, data intact
      assert.equal(db2.pragma('user_version', { simple: true }), 0);
      assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 1);
    } finally {
      fs.chmodSync(dir, 0o700);
      db2.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('_verifyDbCopy rejects a file that is not a healthy SQLite DB', () => {
    const p = path.join(TMP, 'garbage.bak');
    fs.writeFileSync(p, 'this is not a sqlite database at all');
    try {
      assert.throws(() => _verifyDbCopy(p));
    } finally {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  it('_verifyDbCopy accepts a healthy SQLite DB copy', () => {
    const p = tmpDb('healthy-copy');
    const db = openDb(p);
    db.exec('CREATE TABLE t (x INTEGER)');
    db.close();
    try {
      _verifyDbCopy(p);  // must not throw
    } finally {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  it('_assertDiskSpace throws when required bytes exceed free space', () => {
    const p = tmpDb('space');
    fs.writeFileSync(p, 'x');
    try {
      assert.throws(() => _assertDiskSpace(p, Number.MAX_SAFE_INTEGER));
      _assertDiskSpace(p, 1);  // must not throw for a trivial requirement
    } finally {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  it('a failing migration rolls back its own transaction and propagates', () => {
    const p = tmpDb('failing-migration');
    const db = openDb(p);
    db.exec('CREATE TABLE connections (src TEXT, dst TEXT, dport INTEGER, proto TEXT, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, PRIMARY KEY (src, dst, dport, proto))');

    _MIGRATIONS.push({
      version: SCHEMA_VERSION + 1,
      description: 'test-only failing migration',
      up(d) {
        d.exec('CREATE TABLE half_done (x INTEGER)');
        throw new Error('boom');
      },
    });
    try {
      assert.throws(() => runMigrations(db, p), /boom/);
      // Earlier migrations committed, the failing one rolled back
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
      const half = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='half_done'`).get();
      assert.equal(half, undefined, 'partial table from the failed migration must be rolled back');
    } finally {
      _MIGRATIONS.pop();
      db.close();
      const backups = fs.readdirSync(TMP).filter(f => f.includes('pre-migration'));
      for (const f of backups) try { fs.unlinkSync(path.join(TMP, f)); } catch {}
      try { fs.unlinkSync(p); } catch {}
    }
  });

  it('backup file passes integrity verification on the success path', () => {
    const p = tmpDb('verified-backup');
    const db = openDb(p);
    db.exec('CREATE TABLE connections (src TEXT, dst TEXT, dport INTEGER, proto TEXT, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, PRIMARY KEY (src, dst, dport, proto))');
    db.exec(`INSERT INTO connections VALUES ('192.168.1.1','8.8.8.8',443,'TCP',1,2)`);
    db.close();

    const db2 = openDb(p);
    runMigrations(db2, p);
    db2.close();

    const backups = fs.readdirSync(TMP).filter(f => f.startsWith('verified-backup.db.pre-migration'));
    assert.equal(backups.length, 1, 'exactly one backup expected');
    const bak = path.join(TMP, backups[0]);
    _verifyDbCopy(bak);  // the backup itself must be a healthy DB
    // The backup preserves pre-migration data
    const bdb = new Database(bak, { readonly: true });
    assert.equal(bdb.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 1);
    bdb.close();
    try { fs.unlinkSync(bak); } catch {}
    try { fs.unlinkSync(p); } catch {}
  });
});
