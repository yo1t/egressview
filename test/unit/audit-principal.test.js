// Stable audit principal identifier (P2-61 Phase 3b).
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const authAudit = require('../../src/auth-audit');
const { principalFor } = require('../../src/roles');
const { runMigrations, SCHEMA_VERSION } = require('../../src/db-migrate');

let dir;

// Use the real migration so the test exercises v12 within the shipped schema.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-principal-'));
  const dbPath = path.join(dir, 'audit.db');
  const migrationDb = new Database(dbPath);
  runMigrations(migrationDb, dbPath);
  migrationDb.close();
  authAudit.initDb(dbPath, { hashKey: 'test-audit-key' });
});

afterEach(() => {
  authAudit.closeDb();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function rows() {
  const result = authAudit.list({ limit: 10 });
  return result.events || result;
}

describe('principal derivation', () => {
  it('is stable for the same federated subject across sessions', () => {
    const first = principalFor({ authMethod: 'oidc', subject: 'sub-hash-abc' });
    const second = principalFor({ authMethod: 'oidc', subject: 'sub-hash-abc' });
    assert.equal(first, second);
    assert.equal(first, 'federated:sub-hash-abc');
  });

  it('distinguishes different federated subjects', () => {
    assert.notEqual(
      principalFor({ authMethod: 'oidc', subject: 'a' }),
      principalFor({ authMethod: 'oidc', subject: 'b' })
    );
  });

  it('maps the local administrator and legacy token to one principal', () => {
    assert.equal(principalFor({ authMethod: 'local' }), 'local:admin');
    assert.equal(principalFor({ authMethod: 'api-token' }), 'local:admin');
  });

  it('gives each API identity its own principal', () => {
    assert.equal(principalFor({ authMethod: 'api-identity', apiIdentityId: 'uuid-1' }), 'api:uuid-1');
    assert.notEqual(
      principalFor({ authMethod: 'api-identity', apiIdentityId: 'uuid-1' }),
      principalFor({ authMethod: 'api-identity', apiIdentityId: 'uuid-2' })
    );
  });

  it('returns null rather than inventing an identity', () => {
    assert.equal(principalFor(), null);
    assert.equal(principalFor({}), null);
    assert.equal(principalFor({ authMethod: 'oidc' }), null, 'OIDC without a subject has no principal');
    assert.equal(principalFor({ authMethod: 'unknown-method' }), null);
  });
});

describe('audit principalHash storage', () => {
  it('stores a hash, never the raw principal', () => {
    authAudit.append({
      eventType: 'login', outcome: 'success', authMethod: 'oidc',
      actor: 'session:1', principal: 'federated:https://accounts.google.com|12345',
    });
    const row = rows()[0];
    assert.ok(row.principalHash, 'principalHash should be populated');
    assert.match(row.principalHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(row).includes('accounts.google.com'), false);
    assert.equal(JSON.stringify(row).includes('12345'), false);
  });

  it('gives the same hash to the same principal across separate sessions', () => {
    authAudit.append({ eventType: 'login', outcome: 'success', actor: 'session:1', principal: 'federated:s' });
    authAudit.append({ eventType: 'login', outcome: 'success', actor: 'session:2', principal: 'federated:s' });
    const all = rows();
    assert.equal(all[0].principalHash, all[1].principalHash, 'same identity must correlate');
    assert.notEqual(all[0].actorHash, all[1].actorHash, 'credential instances stay distinct');
  });

  it('leaves principalHash null when no stable principal exists', () => {
    authAudit.append({ eventType: 'login', outcome: 'failure', actor: 'session:9' });
    const row = rows()[0];
    assert.equal(row.principalHash, null);
  });

  it('does not change how actorHash is produced', () => {
    authAudit.append({ eventType: 'login', outcome: 'success', actor: 'session:1' });
    authAudit.append({ eventType: 'login', outcome: 'success', actor: 'session:1', principal: 'local:admin' });
    const all = rows();
    assert.equal(all[0].actorHash, all[1].actorHash,
      'adding a principal must not alter the actor hash of the same credential');
  });
});

describe('existing audit rows stay untouched by the v12 migration', () => {
  it('keeps pre-upgrade rows readable with actorHash intact and principalHash NULL', () => {
    // Build a v11 audit trail, then run v12 and later additive migrations and
    // confirm nothing about the older rows changed.
    const upgradeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-audit-upgrade-'));
    try {
      const dbPath = path.join(upgradeDir, 'audit.db');
      const db = new Database(dbPath);
      runMigrations(db, dbPath);
      db.exec('DROP INDEX IF EXISTS idx_audit_events_principal');
      // Simulate the pre-v12 shape by removing the new column from a copy.
      db.exec(`
        CREATE TABLE audit_v11 AS
          SELECT eventId, createdAt, eventType, outcome, authMethod, actorHash,
                 requestId, clientIpHash, httpMethod, path, metadata
          FROM audit_events;
        DROP TABLE audit_events;
        ALTER TABLE audit_v11 RENAME TO audit_events;
      `);
      db.prepare(`
        INSERT INTO audit_events
          (eventId, createdAt, eventType, outcome, authMethod, actorHash,
           requestId, clientIpHash, httpMethod, path, metadata)
        VALUES ('legacy-1', 1000, 'login', 'success', 'local', 'legacy-actor-hash',
                'req-1', 'ip-hash', 'POST', '/api/login', NULL)
      `).run();
      db.pragma('user_version = 11');
      db.close();

      const upgraded = new Database(dbPath);
      runMigrations(upgraded, dbPath);
      assert.equal(upgraded.pragma('user_version', { simple: true }), SCHEMA_VERSION);
      const row = upgraded.prepare('SELECT * FROM audit_events WHERE eventId = ?').get('legacy-1');
      assert.equal(row.actorHash, 'legacy-actor-hash', 'existing actorHash must not be rewritten');
      assert.equal(row.principalHash, null, 'existing rows must not be backfilled with a guess');
      assert.equal(row.eventType, 'login');
      assert.equal(row.createdAt, 1000);
      upgraded.close();
    } finally {
      fs.rmSync(upgradeDir, { recursive: true, force: true });
    }
  });

  it('reads a mix of pre- and post-upgrade rows through the public API', () => {
    authAudit.append({ eventType: 'login', outcome: 'success', actor: 'session:1' });
    authAudit.append({ eventType: 'login', outcome: 'success', actor: 'session:2', principal: 'local:admin' });
    const all = rows();
    assert.equal(all.length, 2);
    assert.equal(all.filter(r => r.principalHash === null).length, 1);
    assert.equal(all.filter(r => r.principalHash !== null).length, 1);
    assert.ok(all.every(r => typeof r.actorHash === 'string'));
  });
});
