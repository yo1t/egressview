'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const authAudit = require('../../src/auth-audit');
const { runMigrations } = require('../../src/db-migrate');

let dir;

afterEach(() => {
  authAudit.closeDb();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('authentication audit store', () => {
  it('appends pseudonymous bounded events and never returns raw actor or IP values', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-audit-'));
    const dbPath = path.join(dir, 'audit.db');
    const migrationDb = new Database(dbPath);
    runMigrations(migrationDb, dbPath);
    migrationDb.close();
    authAudit.initDb(dbPath, { hashKey: 'stable-test-key' });

    authAudit.append({
      eventType: 'login',
      actor: 'person@example.com',
      clientIp: '192.0.2.10',
      requestId: 'request-1',
      authMethod: 'oidc',
      metadata: { provider: 'google' },
    });
    const [event] = authAudit.list();

    assert.equal(event.eventType, 'login');
    assert.equal(event.authMethod, 'oidc');
    assert.equal(event.actorHash.length, 12);
    assert.equal(event.clientIpHash.length, 12);
    assert.doesNotMatch(JSON.stringify(event), /person@example|192\.0\.2\.10/);
  });

  it('proves writability and reports runtime write failures', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-audit-health-'));
    const dbPath = path.join(dir, 'audit.db');
    const migrationDb = new Database(dbPath);
    runMigrations(migrationDb, dbPath);
    migrationDb.close();
    authAudit.initDb(dbPath, { hashKey: 'stable-test-key' });

    const statuses = [];
    authAudit.setWriteStatusHandler(status => statuses.push(status));
    assert.doesNotThrow(() => authAudit.assertWritable());
    assert.equal(statuses.at(-1).ok, true);

    authAudit.closeDb();
    assert.equal(authAudit.append({ eventType: 'must-fail' }), null);
    assert.equal(statuses.at(-1).ok, false);
    assert.equal(authAudit.health().writeFailures, 1);
    assert.throws(() => authAudit.assertWritable(), /not initialized/);
  });
});
