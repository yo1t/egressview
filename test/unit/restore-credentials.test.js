'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { prepareRestoredCopy } = require('../../src/restore-credentials');

function db(p, sql) {
  const d = new Database(p);
  d.exec(sql);
  d.close();
}

describe('prepareRestoredCopy (P2-102 H2)', () => {
  it('置き換える先が無ければ、ファイルの資格情報はすべて消す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-restore-cred-'));
    const copy = path.join(dir, 'copy.db');
    db(copy, `CREATE TABLE api_identities (id TEXT, tokenHash TEXT);
      CREATE TABLE sessions (tokenHash TEXT);
      INSERT INTO api_identities VALUES ('intruder', 'h');
      INSERT INTO sessions VALUES ('s');`);
    prepareRestoredCopy(copy, { credentialSource: null });
    const d = new Database(copy, { readonly: true });
    assert.equal(d.prepare('SELECT COUNT(*) n FROM api_identities').get().n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('列が違っても、共通の列だけを移す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-restore-cred-'));
    const copy = path.join(dir, 'copy.db');
    const live = path.join(dir, 'live.db');
    db(copy, `CREATE TABLE api_identities (id TEXT, tokenHash TEXT);
      INSERT INTO api_identities VALUES ('old', 'h-old');`);
    db(live, `CREATE TABLE api_identities (id TEXT, tokenHash TEXT, permissions TEXT);
      INSERT INTO api_identities VALUES ('operator', 'h-op', 'admin');`);
    prepareRestoredCopy(copy, { credentialSource: live });
    const d = new Database(copy, { readonly: true });
    assert.deepEqual(d.prepare('SELECT id, tokenHash FROM api_identities').all(), [{ id: 'operator', tokenHash: 'h-op' }]);
    d.close();
    assert.ok(!fs.existsSync(`${copy}-wal`), 'nothing left beside the copy');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ビューも拒否する', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-restore-cred-'));
    const copy = path.join(dir, 'copy.db');
    db(copy, 'CREATE TABLE t (a); CREATE VIEW v AS SELECT a FROM t;');
    assert.throws(() => prepareRestoredCopy(copy, {}), /view v/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
