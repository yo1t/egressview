'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const progress = require('../../src/startup-progress');
const { progressLine } = require('../../src/startup-listener');

// How far a long database check has got, for the startup page (P3-173).
let dir;
let db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-progress-'));
  db = path.join(dir, 'hub.db');
  fs.writeFileSync(db, Buffer.alloc(1000));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('読み込んだ量', () => {
  it('/proc/self/io の rchar を読む', () => {
    const text = 'rchar: 123456\nwchar: 1\nsyscr: 2\n';
    assert.equal(progress.bytesRead({ readFileSync: () => text }), 123456);
  });

  it('読めない環境（macOS）では null を返し、止まらない', () => {
    assert.equal(progress.bytesRead({ readFileSync: () => { throw new Error('ENOENT'); } }), null);
    assert.equal(progress.bytesRead({ readFileSync: () => 'nothing useful' }), null);
  });

  it('-wal も数に入れる', () => {
    fs.writeFileSync(`${db}-wal`, Buffer.alloc(200));
    assert.equal(progress.databaseBytes(db), 1200);
  });
});

describe('目安', () => {
  it('前回の同じ種類の検査が読んだ量を、今のファイルの大きさに合わせて使う', () => {
    progress.recordCheck(db, 'quick', { bytesRead: 1900, dbBytes: 1000, ms: 5 });
    assert.equal(progress.expectedBytes(db, 'quick', 2000), 3800);
  });

  it('種類が違う検査の記録は使わない', () => {
    progress.recordCheck(db, 'quick', { bytesRead: 1900, dbBytes: 1000, ms: 5 });
    assert.equal(progress.expectedBytes(db, 'full', 1000), null);
  });

  it('記録が無いか壊れていれば、目安は無い', () => {
    assert.equal(progress.expectedBytes(db, 'quick', 1000), null);
    fs.writeFileSync(progress.recordPath(db), '{not json');
    assert.equal(progress.expectedBytes(db, 'quick', 1000), null);
  });
});

describe('検査を外から追う', () => {
  function reader(values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  }

  it('始める前に起点と目安を知らせ、終わったら読んだ量を記録する', () => {
    progress.recordCheck(db, 'quick', { bytesRead: 1500, dbBytes: 1000, ms: 1 });
    const seen = [];
    const result = progress.followCheck(
      { dbPath: db, mode: 'quick', phase: 'database', onProgress: (phase, detail) => seen.push([phase, detail]), read: reader([100, 2100]) },
      () => 'ok',
      r => r === 'ok'
    );
    assert.equal(result, 'ok');
    assert.deepEqual(seen, [['database', { mode: 'quick', readBase: 100, expectedBytes: 1500 }]]);
    const record = JSON.parse(fs.readFileSync(progress.recordPath(db), 'utf8'));
    assert.equal(record.quick.bytesRead, 2000);
    assert.equal(record.quick.dbBytes, 1000);
  });

  // A check that found damage is no guide to how long a sound one takes.
  it('失敗した検査は記録しない', () => {
    progress.followCheck(
      { dbPath: db, mode: 'quick', phase: 'database', read: reader([0, 500]) },
      () => 'corrupt',
      r => r === 'ok'
    );
    assert.equal(fs.existsSync(progress.recordPath(db)), false);
  });

  it('読んだ量が分からない環境では、検査は今どおり走り、記録だけしない', () => {
    const result = progress.followCheck(
      { dbPath: db, mode: 'full', phase: 'database', read: () => null },
      () => 'ok',
      r => r === 'ok'
    );
    assert.equal(result, 'ok');
    assert.equal(fs.existsSync(progress.recordPath(db)), false);
  });
});

describe('起動中の画面の一行', () => {
  it('目安があれば、読んだ量と割合を出す', () => {
    assert.equal(
      progressLine('database', { readBase: 1e9, expectedBytes: 4e9 }, 'ja', 3.2e9),
      '読み込んだデータ: 2.2 GB／目安 4.0 GB（約55%）'
    );
  });

  // Never done before it is: a check reading more than last time is still
  // running.
  it('目安を超えても 99% で止め、100% とは言わない', () => {
    assert.match(progressLine('database', { readBase: 0, expectedBytes: 1e9 }, 'en', 5e9), /about 99%\)$/);
  });

  it('目安が無ければ、読んだ量だけを出す', () => {
    assert.equal(progressLine('database', { readBase: 0, expectedBytes: null }, 'ja', 1.5e9), '読み込んだデータ: 1.5 GB');
  });

  it('読んだ量が分からなければ、何も足さない', () => {
    assert.equal(progressLine('database', { readBase: null, expectedBytes: 1e9 }, 'ja', null), '');
    assert.equal(progressLine('database', null, 'ja', 1), '');
  });

  it('移行は何段目かを出す', () => {
    assert.equal(progressLine('migration', { step: 2, total: 3, version: 30 }, 'ja'), '3段中2段目（v30）');
    assert.equal(progressLine('migration', { step: 2, total: 3, version: 30 }, 'en'), 'Step 2 of 3 (v30)');
  });
});

describe('起動時の検査とのつながり', () => {
  it('起動時の検査は、種類と起点を知らせてから走る', () => {
    const history = require('../../src/history');
    const seen = [];
    history._initForTest(db.replace(/hub\.db$/, 'history.db'), {
      onProgress: (phase, detail) => { if (phase === 'database') seen.push(detail); },
    });
    try {
      assert.equal(seen.length, 1);
      assert.equal(seen[0].mode, 'full');
      assert.ok('readBase' in seen[0] && 'expectedBytes' in seen[0]);
    } finally {
      history.closeDb();
    }
  });

  // Only where the kernel reports it, which is where the Hub runs in
  // production. CI runs on Linux; on a Mac this is skipped.
  it('Linuxでは、実際の検査が読んだ量を記録する', { skip: progress.bytesRead() == null }, () => {
    const Database = require('better-sqlite3');
    const file = path.join(dir, 'real.db');
    const d = new Database(file);
    d.exec('CREATE TABLE t (v TEXT)');
    const insert = d.prepare('INSERT INTO t VALUES (?)');
    d.transaction(() => { for (let i = 0; i < 20000; i++) insert.run('x'.repeat(200)); })();
    d.close();
    const check = new Database(file, { readonly: true });
    try {
      progress.followCheck({ dbPath: file, mode: 'quick', phase: 'database' },
        () => check.pragma('quick_check')[0].quick_check, r => r === 'ok');
    } finally {
      check.close();
    }
    const record = JSON.parse(fs.readFileSync(progress.recordPath(file), 'utf8'));
    assert.ok(record.quick.bytesRead >= record.quick.dbBytes * 0.5,
      `read ${record.quick.bytesRead} of a ${record.quick.dbBytes}-byte file`);
  });
});
