'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyWalPragmas, setAutoCheckpoint, SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES } = require('../../src/sqlite-wal');
const { createCheckpointOwner } = require('../../src/checkpoint-owner');

const quietLogger = { info() {}, warn() {}, error() {} };

describe('本体の接続の自動の書き戻し（sqlite-wal）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-wal-'));
  after(() => {
    setAutoCheckpoint(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pages = db => db.pragma('wal_autocheckpoint', { simple: true });

  it('止めると、開いている接続にも、後から開く接続にも効く。戻すと既定に戻る', () => {
    const first = applyWalPragmas(new Database(path.join(dir, 'a.db')));
    assert.equal(pages(first), SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES);
    setAutoCheckpoint(false);
    assert.equal(pages(first), 0);
    const later = applyWalPragmas(new Database(path.join(dir, 'a.db')));
    assert.equal(pages(later), 0);
    const closed = applyWalPragmas(new Database(path.join(dir, 'b.db')));
    closed.close();
    setAutoCheckpoint(true);
    assert.equal(pages(first), SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES);
    assert.equal(pages(later), SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES);
    first.close();
    later.close();
  });
});

describe('書き戻しの受け持ち（checkpoint-owner）', () => {
  function setup(results) {
    const switches = [];
    const queue = [];
    const owner = createCheckpointOwner({
      host: { run: async () => { const next = results.shift(); if (next instanceof Error) throw next; return next; } },
      setAutoCheckpoint: enabled => switches.push(enabled),
      logger: quietLogger,
      schedule: fn => { queue.push(fn); return { unref() {} }; },
      cancel: () => {},
    });
    const step = async () => { await queue.shift()(); };
    return { owner, switches, step };
  }

  it('スレッドの書き戻しが成功したら、本体の自動の書き戻しを止める', async () => {
    const { owner, switches, step } = setup([{ ms: 3, logFrames: 10 }, { ms: 2 }]);
    owner.start();
    await step();
    await step();
    assert.deepEqual(switches, [false], '止めるのは1回だけ');
    assert.equal(owner.state().threadOwns, true);
  });

  it('スレッドがいなければ本体に戻し、戻ってきたらまた止める', async () => {
    const gone = Object.assign(new Error('The database thread is closed'), { code: 'DB_WORKER_CLOSED' });
    const { owner, switches, step } = setup([{ ms: 1 }, gone, { ms: 1 }]);
    owner.start();
    await step();
    await step();
    assert.equal(owner.state().lastFailure, 'DB_WORKER_CLOSED');
    await step();
    assert.deepEqual(switches, [false, true, false]);
  });

  it('止めたら、本体の自動の書き戻しに戻す', async () => {
    const { owner, switches, step } = setup([{ ms: 1 }]);
    owner.start();
    await step();
    owner.stop('shutting down');
    assert.deepEqual(switches, [false, true]);
  });
});
