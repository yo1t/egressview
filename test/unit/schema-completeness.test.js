'use strict';

// A missing table must be said out loud at startup (P2-97).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../src/db-migrate');
const { findMissingObjects, reportSchemaCompleteness } = require('../../src/schema-completeness');

function current() {
  const db = new Database(':memory:');
  runMigrations(db, ':memory:', { sourceRouterMap: {} });
  return db;
}

function capture() {
  const lines = [];
  return { logger: { error: (line) => lines.push(String(line)) }, lines };
}

describe('スキーマの欠落を起動時に言う (P2-97)', () => {
  it('integrity_checkは、テーブルが消えていても ok を返す', () => {
    // The reason this module exists. The Hub starts, /readyz answers 200, and
    // the first attempt to record an audit event fails with `no such table`.
    const db = current();
    db.exec('DROP TABLE audit_events');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.throws(() => db.prepare('SELECT count(*) FROM audit_events').get(),
      /no such table/);
    db.close();
  });

  it('健全なDBでは何も言わない', () => {
    const db = current();
    const { logger, lines } = capture();
    const result = reportSchemaCompleteness({ db, Database, runMigrations, logger, version: 19 });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(lines, []);
    assert.ok(result.expected > 40, `expected a populated reference, got ${result.expected}`);
    db.close();
  });

  it('欠けたものを名指しで、ERRORとして出す', () => {
    // Named, not counted. "3 objects are missing" sends someone looking; the
    // names say whether it is an index they can live without or the audit
    // table. The deploy script counts ERROR lines after start, so this fails
    // deploy verification and rolls back.
    const db = current();
    db.exec('DROP TABLE audit_events');
    const { logger, lines } = capture();
    const result = reportSchemaCompleteness({ db, Database, runMigrations, logger, version: 19 });

    assert.ok(result.missing.includes('table:audit_events'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /table:audit_events/);
    assert.match(lines[0], /schema version 19/);
    db.close();
  });

  it('直さない、と述べる', () => {
    // Recreating a missing table hands back an empty one, which presents data
    // loss as a working system. The message has to say that, because the
    // obvious next thought is "why not just recreate it".
    const db = current();
    db.exec('DROP TABLE api_identities');
    const { logger, lines } = capture();
    reportSchemaCompleteness({ db, Database, runMigrations, logger, version: 19 });
    assert.match(lines[0], /Nothing here recreates them/);
    assert.match(lines[0], /Restore from a backup/);
    db.close();
  });

  it('期待一覧は手書きではなく、migrationから作る', () => {
    // A hand-written list drifts silently. APP_SCRIPT_FILES in the frontend
    // lint had two modules missing for months and nothing reported it -- they
    // were simply never checked.
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'src', 'schema-completeness.js'), 'utf8'
    );
    assert.match(source, /runMigrations\(reference/);
    const code = source.split('\n').filter((line) => !line.trim().startsWith('*')).join('\n');
    assert.doesNotMatch(code, /'table:connections'/, 'no hard-coded expected names');
  });

  it('検査自身が失敗しても、起動を巻き込まない', () => {
    // A check that can take the Hub down is worse than the fault it looks for.
    const db = current();
    const { logger, lines } = capture();
    const result = reportSchemaCompleteness({
      db,
      Database: function Broken() { throw new Error('reference database unavailable'); },
      runMigrations,
      logger,
      version: 19,
    });
    assert.equal(result.checkFailed, true);
    assert.match(lines[0], /Could not check the schema/);
    db.close();
  });

  it('欠落の判定は、名前と種類の両方で行う', () => {
    const db = current();
    db.exec('DROP INDEX idx_agents_active');
    const { missing } = findMissingObjects({ db, Database, runMigrations });
    assert.deepEqual(missing, ['index:idx_agents_active']);
    db.close();
  });
});
