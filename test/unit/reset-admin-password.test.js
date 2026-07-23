'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { reset } = require('../../scripts/reset-admin-password');
const authPassword = require('../../src/auth-password');

let dir;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('TTY administrator recovery', () => {
  it('atomically resets the password, revokes sessions, and can rotate the API token', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-reset-'));
    const configPath = path.join(dir, 'config.json');
    const dbPath = path.join(dir, 'runtime.db');
    fs.writeFileSync(configPath, JSON.stringify({ adminToken: 'old-token' }), { mode: 0o600 });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY, tokenHash TEXT, deviceLabel TEXT,
        createdAt INTEGER, lastSeenAt INTEGER, expiresAt INTEGER
      );
      INSERT INTO sessions VALUES (1, 'hash', 'browser', 1, 1, 9999999999999);
    `);
    db.close();

    const result = reset({ configPath, dbPath, regenerateApiToken: true });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const reopened = new Database(dbPath, { readonly: true });
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    reopened.close();
    assert.equal(authPassword.verifyPassword(result.password, config.auth.password), true);
    assert.notEqual(config.adminToken, 'old-token');
    assert.equal((fs.statSync(configPath).mode & 0o777), 0o600);
  });
});
