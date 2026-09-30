'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const { DbWorkerHost } = require('../../src/db-worker-host');
const store = require('../../src/agent-ingest-store');
const { openHandlesTo } = require('../../src/db-startup-check');

class FakeWorker extends EventEmitter {
  constructor({ answer = true } = {}) {
    super();
    this.answer = answer;
    this.sent = [];
    this.terminated = false;
  }

  postMessage(message) {
    this.sent.push(message);
    if (message.op === 'close' && this.answer) {
      setImmediate(() => this.emit('message', { id: message.id, ok: true, result: { closed: true } }));
    }
  }

  reply(index, body) {
    this.emit('message', { id: this.sent[index].id, ...body });
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

const quietLogger = { error() {}, warn() {}, info() {} };

// The host unrefs its thread and timers so they never keep the Hub from
// exiting. In the Hub the HTTP server keeps the loop alive; here nothing
// else does, and a test awaiting a reply would end with the loop.
let keepAlive;
before(() => { keepAlive = setInterval(() => {}, 60_000); });
after(() => clearInterval(keepAlive));

function hostWith(workers, options = {}) {
  const spawned = [];
  const host = new DbWorkerHost({
    logger: quietLogger,
    workerFactory: data => {
      const worker = workers.shift() || new FakeWorker();
      spawned.push({ worker, data });
      return worker;
    },
    ...options,
  });
  return { host, spawned };
}

describe('DbWorkerHost', () => {
  it('依頼を送り、返事でPromiseを解決する。待っている間もイベントループは進む', async () => {
    const worker = new FakeWorker();
    const { host, spawned } = hostWith([worker]);
    host.open('/tmp/egressview-test.db');
    assert.deepEqual(spawned[0].data, { dbPath: '/tmp/egressview-test.db' });

    let advanced = false;
    const pending = host.run('agentIngest.prune', { before: 1 });
    setImmediate(() => { advanced = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(advanced, true);
    assert.deepEqual(worker.sent[0].args, { before: 1 });

    worker.reply(0, { ok: true, result: { observations: 3 } });
    assert.deepEqual(await pending, { observations: 3 });
  });

  it('失敗の返事はエラーコードつきで拒否する', async () => {
    const worker = new FakeWorker();
    const { host } = hostWith([worker]);
    host.open('/tmp/x.db');
    const pending = host.run('agentIngest.prune');
    worker.reply(0, { ok: false, error: 'database is locked', code: 'SQLITE_BUSY' });
    await assert.rejects(pending, error => error.code === 'SQLITE_BUSY' && /locked/.test(error.message));
  });

  it('開く前と閉じた後の依頼は、スレッドを起こさずに拒否する', async () => {
    const { host, spawned } = hostWith([]);
    await assert.rejects(host.run('agentIngest.prune'), { code: 'DB_WORKER_CLOSED' });
    host.open('/tmp/x.db');
    await host.close();
    await assert.rejects(host.run('agentIngest.prune'), { code: 'DB_WORKER_CLOSED' });
    assert.equal(spawned.length, 1);
  });

  it('スレッドが途中で終わったら待っている依頼を失敗させ、次の依頼では新しいスレッドを起こす', async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const { host, spawned } = hostWith([first, second]);
    host.open('/tmp/x.db');
    const pending = host.run('agentIngest.prune');
    first.emit('exit', 1);
    await assert.rejects(pending, { code: 'DB_WORKER_GONE' });

    const next = host.run('agentIngest.prune');
    assert.equal(spawned.length, 2);
    second.reply(0, { ok: true, result: { observations: 0 } });
    assert.deepEqual(await next, { observations: 0 });
  });

  it('時間内に答えない依頼は失敗させ、そのスレッドは捨てる', async () => {
    const worker = new FakeWorker();
    const { host } = hostWith([worker], { requestTimeoutMs: 5 });
    host.open('/tmp/x.db');
    await assert.rejects(host.run('agentIngest.prune'), { code: 'DB_WORKER_TIMEOUT' });
    assert.equal(worker.terminated, true);
    assert.equal(host.worker, null);
  });

  it('閉じるときは接続を閉じるよう頼み、答えを待ってからスレッドを止める', async () => {
    const worker = new FakeWorker();
    const { host } = hostWith([worker]);
    host.open('/tmp/x.db');
    await host.close();
    assert.equal(worker.sent.at(-1).op, 'close');
    assert.equal(worker.terminated, true);
  });

  it('答えないスレッドも、閉じる時間切れで止める', async () => {
    const worker = new FakeWorker({ answer: false });
    const { host } = hostWith([worker], { closeTimeoutMs: 5 });
    host.open('/tmp/x.db');
    await host.close();
    assert.equal(worker.terminated, true);
  });

  it('resume は前のファイルで開き直す。一度も開いていなければ何もしない', async () => {
    const { host, spawned } = hostWith([]);
    host.resume();
    assert.equal(spawned.length, 0);
    host.open('/tmp/a.db');
    await host.close();
    host.resume();
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[1].data, { dbPath: '/tmp/a.db' });
  });
});

describe('データベーススレッド（実スレッド）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-db-worker-'));
  const dbPath = path.join(dir, 'hub.db');
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const golden = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../protocol/agent-ingest/v1/golden.json'), 'utf8'
  ));
  const agentId = '00000000-0000-4000-8000-000000000001';
  const base = Date.parse('2026-08-11T12:00:00Z');

  it('期限切れの観測を別スレッドで消し、書き戻しの結果を返す', async () => {
    store._initForTest(dbPath);
    store._dbForTest().pragma('journal_mode = WAL');
    const envelope = structuredClone(golden);
    envelope.observations = Array.from({ length: 30 }, (_, index) => ({
      ...golden.observations[0],
      observationId: randomUUID(),
      localPort: 40000 + index,
      firstObservedAt: new Date(base + index * 1000 - 500).toISOString(),
      lastObservedAt: new Date(base + index * 1000).toISOString(),
    }));
    await store.storeBatch(agentId, envelope, { receivedAt: base + 60_000 });
    store.closeDb();

    const host = new DbWorkerHost({ logger: quietLogger });
    host.open(dbPath);
    try {
      const run = await host.run('agentIngest.prune', { before: base + 3_600_000 });
      assert.equal(run.observations, 30);
      assert.equal(run.batches, 1);
      assert.equal(run.more, false);
      assert.ok(run.passes >= 1);
      for (const key of ['observationsMs', 'hourlyMs', 'receiptsMs', 'slowestTransactionMs',
        'checkpointMs', 'slowestCheckpointMs']) {
        assert.equal(typeof run[key], 'number', key);
      }
      assert.equal(typeof run.logFramesAtEnd, 'number');
    } finally {
      await host.close();
    }

    const check = new Database(dbPath, { readonly: true });
    try {
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 0);
    } finally {
      check.close();
    }
  });

  // Shutdown refuses to record a clean stop while any handle to the file is
  // open, and the thread's handle is in this process like the others. Only
  // Linux can list them, which is what the Hub and CI run on.
  it('閉じた後、スレッドのDBへの接続は残らない（Linuxのみ確認）', async (t) => {
    const host = new DbWorkerHost({ logger: quietLogger });
    host.open(dbPath);
    await host.run('agentIngest.prune', { before: 0 });
    const whileOpen = openHandlesTo(dbPath);
    if (whileOpen === null) {
      await host.close();
      t.skip('open handles cannot be listed on this platform');
      return;
    }
    assert.ok(whileOpen.length > 0, 'スレッドが開いている間は接続が見える');
    await host.close();
    assert.deepEqual(openHandlesTo(dbPath), []);
  });

  it('知らない操作は失敗として返す', async () => {
    const host = new DbWorkerHost({ logger: quietLogger });
    host.open(dbPath);
    try {
      await assert.rejects(host.run('no.such.operation'), /Unknown database operation/);
    } finally {
      await host.close();
    }
  });
});
