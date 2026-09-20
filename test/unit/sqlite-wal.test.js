'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { applyWalPragmas, WAL_SIZE_LIMIT_BYTES } = require('../../src/sqlite-wal');

function openTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-wal-'));
  const db = new Database(path.join(dir, 'test.db'));
  return { db, dir };
}

describe('先行書き込みログに上限を置く', () => {
  it('WALモードにしたうえで、ログの上限を設定する', () => {
    const { db, dir } = openTempDb();
    try {
      applyWalPragmas(db);
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(db.pragma('journal_size_limit', { simple: true }), WAL_SIZE_LIMIT_BYTES);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('既定の -1（上限なし）のままにしない', () => {
    // -1 is what left 530 MB on the production Hub: the checkpoint frees the
    // contents, and the file keeps its high-water mark for ever.
    const { db, dir } = openTempDb();
    try {
      assert.equal(db.pragma('journal_size_limit', { simple: true }), -1);
      applyWalPragmas(db);
      assert.notEqual(db.pragma('journal_size_limit', { simple: true }), -1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('チェックポイントのあと、ログは上限まで切り詰められる', () => {
    const { db, dir } = openTempDb();
    try {
      applyWalPragmas(db);
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
      const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
      const payload = 'x'.repeat(4096);
      // Enough to push the log past the limit if nothing truncated it.
      const write = db.transaction(() => {
        for (let i = 0; i < 40_000; i++) insert.run(payload);
      });
      write();
      db.pragma('wal_checkpoint(TRUNCATE)');
      const walPath = `${db.name}-wal`;
      const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      assert.ok(walBytes <= WAL_SIZE_LIMIT_BYTES,
        `WAL が上限を超えたまま: ${walBytes} > ${WAL_SIZE_LIMIT_BYTES}`);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
