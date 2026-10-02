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

  it('書き戻しの依頼に答える', async () => {
    const host = new DbWorkerHost({ logger: quietLogger });
    host.open(dbPath, { role: 'maintenance' });
    try {
      const result = await host.run('wal.checkpoint');
      assert.equal(typeof result.ms, 'number');
      assert.ok('logFrames' in result && 'checkpointedFrames' in result);
    } finally {
      await host.close();
    }
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

describe('読み取り用スレッド', () => {
  const history = require('../../src/history');
  const { createHistoryReader } = require('../../src/history-reader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-db-read-'));
  const dbPath = path.join(dir, 'hub.db');
  after(() => {
    history.closeDb();
    history._initForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('スレッドで読んだ結果は、このスレッドで読んだ結果と同じ', async () => {
    history._initForTest(dbPath);
    const now = Date.now();
    for (let i = 0; i < 30; i += 1) {
      history.appendHistoryLog({
        src: `192.0.2.${10 + (i % 3)}`, dst: `198.51.100.${i % 7}`, dport: 443 + (i % 2), proto: 'TCP',
        source: i % 2 ? 'yamaha' : 'cisco', firstSeen: now - i * 60_000, lastSeen: now - i * 60_000,
      });
    }
    const host = new DbWorkerHost({ logger: quietLogger });
    host.open(dbPath, { role: 'read', sourceRouterMap: {} });
    const reader = createHistoryReader({ history, host, logger: quietLogger });
    try {
      const from = now - 20 * 60_000;
      const opts = { sort: 'lastSeen', sortDir: 'desc', filters: {} };
      assert.deepEqual(
        await reader.read('queryByTimeRangePaged', from, null, 10, 2, opts),
        history.queryByTimeRangePaged(from, null, 10, 2, opts),
      );
      assert.equal(await reader.read('countByTimeRange', from, null, { filters: {} }),
        history.countByTimeRange(from, null, { filters: {} }));
      assert.deepEqual(await reader.read('groupDstByTimeRange', from, null, {}),
        history.groupDstByTimeRange(from, null, {}));
      const onThread = await reader.read('summarizeByTimeRange', from, null, { buckets: 10 });
      const here = history.summarizeByTimeRange(from, null, { buckets: 10 });
      assert.deepEqual(onThread.byDst, here.byDst);
      assert.deepEqual(onThread.byDevice, here.byDevice);
      assert.equal(onThread.total, here.total);
      const page = history.queryByTimeRangePaged(from, null, 10, 0, opts);
      assert.deepEqual(
        await reader.read('attachAgentAttributions', page, { sourceScope: null, from, to: null }),
        history.attachAgentAttributions(page, { sourceScope: null, from, to: null }),
      );
      assert.deepEqual(await reader.read('countFactsByTimeRange', from, null, {}),
        history.countFactsByTimeRange(from, null, {}));
      const routerScope = { sourceKind: 'router', sourceId: 'yamaha1' };
      assert.deepEqual(await reader.read('listSourceDeviceKeys', routerScope),
        history.listSourceDeviceKeys(routerScope));
    } finally {
      await host.close();
    }
  });

  it('アプリの帰属も、スレッドで付けた結果はこのスレッドと同じ', async () => {
    history._initForTest(dbPath);
    const now = Date.now();
    history.appendHistoryLog({
      src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
      source: 'yamaha', firstSeen: now, lastSeen: now,
    });
    history.appendHistoryLog({
      src: '192.0.2.30', dst: '203.0.113.53', dport: 53, proto: 'UDP',
      source: 'agent', observedBy: [], firstSeen: now, lastSeen: now,
    });
    const writer = new Database(dbPath);
    try {
      writer.prepare(`INSERT INTO agents (
        agentId, platform, hostName, osVersion, agentVersion, tokenHash,
        createdAt, updatedAt, lastSeenAt, revokedAt
      ) VALUES ('agent-a', 'macos', 'macbook', '15', '1.0', 'h', ?, ?, ?, NULL)`).run(now, now, now);
      const observe = writer.prepare(`INSERT INTO agent_observations (
        agentId, observationId, batchId, networkProtocol, localAddress, localPort,
        remoteAddress, remotePort, processId, processName, bundleId,
        firstObservedAt, lastObservedAt, bytesIn, bytesOut, collector, confidence, receivedAt
      ) VALUES ('agent-a', ?, 'b1', ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, '10', '20', 'network-extension', 'exact', ?)`);
      observe.run('linked', 'tcp', '192.0.2.10', 51000, '198.51.100.10', 443, 'Safari', now, now, now);
      observe.run('agent-only', 'udp', '192.0.2.30', 52000, '203.0.113.53', 53, 'mDNSResponder', now, now, now);
      writer.prepare(`INSERT INTO connection_agent_observations (
        src, dst, dport, proto, agentId, observationId, matchKind, matchedAt, timeDeltaMs
      ) VALUES ('192.0.2.10', '198.51.100.10', 443, 'TCP', 'agent-a', 'linked', 'exact-5tuple', ?, 0)`).run(now);
    } finally {
      writer.close();
    }
    const host = new DbWorkerHost({ logger: quietLogger });
    host.open(dbPath, { role: 'read', sourceRouterMap: {} });
    const reader = createHistoryReader({ history, host, logger: quietLogger });
    try {
      const scope = { sourceKind: 'agent', sourceId: 'agent-a' };
      const page = history.queryByTimeRangePaged(now - 60_000, null, 10, 0, {
        sort: 'lastSeen', sortDir: 'desc', filters: {}, sourceScope: scope,
      });
      assert.equal(page.length, 2);
      const options = { sourceScope: scope, from: now - 60_000, to: null };
      const here = history.attachAgentAttributions(page, options);
      assert.deepEqual(await reader.read('attachAgentAttributions', page, options), here);
      assert.deepEqual(new Set(here.flatMap(row => row.applications.map(app => app.processName))),
        new Set(['Safari', 'mDNSResponder']), 'the comparison covers both kinds of attribution');
    } finally {
      await host.close();
    }
  });

  it('スレッドが閉じていれば、このスレッドで読む', async () => {
    const host = new DbWorkerHost({ logger: quietLogger });
    const reader = createHistoryReader({ history, host, logger: quietLogger });
    assert.equal(await reader.read('countByTimeRange', null, null, { filters: {} }),
      history.countByTimeRange(null, null, { filters: {} }));
  });

  it('スレッドでの失敗は、このスレッドで読み直さずに返す', async () => {
    const failing = { run: () => Promise.reject(Object.assign(new Error('no such table'), { code: 'SQLITE_ERROR' })) };
    let ranHere = false;
    const reader = createHistoryReader({
      history: { countByTimeRange: () => { ranHere = true; return 0; } },
      host: failing,
      logger: quietLogger,
    });
    await assert.rejects(reader.read('countByTimeRange', null, null, {}), /no such table/);
    assert.equal(ranHere, false);
  });

  it('決めた読み取り以外は、スレッドが断る', async () => {
    const worker = require('../../src/db-worker');
    const reply = worker.handle({ id: 1, op: 'history.read', args: { fn: 'appendHistoryLog', args: [] } });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Not a history read: appendHistoryLog/);
  });
});

describe('共有の読み取り（createSharedReader）', () => {
  const { createSharedReader } = require('../../src/history-reader');
  function counting() {
    const calls = [];
    const pending = [];
    return {
      calls,
      finishAll: value => pending.splice(0).forEach(resolve => resolve(value)),
      reader: { read: (fn, ...args) => { calls.push([fn, ...args]); return new Promise(resolve => pending.push(resolve)); } },
    };
  }

  it('同時に届いた同じ読み取りは、1回の読み取りを待ち合わせる', async () => {
    const { calls, finishAll, reader } = counting();
    const shared = createSharedReader({ reader, now: () => 1_000_000 });
    const scope = { sourceScope: { sourceKind: 'agent', sourceId: 'a' } };
    const both = Promise.all([
      shared.read('countFactsByTimeRange', 1_000_000 - 7 * 86_400_000, null, scope),
      shared.read('countFactsByTimeRange', 1_000_000 - 7 * 86_400_000 + 5, null, scope),
    ]);
    finishAll({ connections: 3 });
    assert.deepEqual(await both, [{ connections: 3 }, { connections: 3 }]);
    assert.equal(calls.length, 1);
    assert.equal(shared.stats().joined, 1);
  });

  it('1分以内は同じ答えを返し、1分を過ぎたら読み直す', async () => {
    let clock = 10_000_000;
    const calls = [];
    const shared = createSharedReader({
      reader: { read: async (fn, from) => { calls.push(from); return { n: calls.length }; } },
      now: () => clock,
    });
    const from = () => clock - 86_400_000;
    assert.deepEqual(await shared.read('groupDstByTimeRange', from(), null, {}), { n: 1 });
    clock += 30_000;
    assert.deepEqual(await shared.read('groupDstByTimeRange', clock - 86_400_000 - 30_000, null, {}), { n: 1 });
    clock += 31_000;
    assert.deepEqual(await shared.read('groupDstByTimeRange', from(), null, {}), { n: 2 });
  });

  it('期間が短くても、今の期間と前の期間を同じ答えにしない', async () => {
    const calls = [];
    const shared = createSharedReader({
      reader: { read: async (fn, from, to) => { calls.push([from, to]); return { from, to }; } },
      now: () => 5_000,
    });
    assert.deepEqual(await shared.read('countFactsByTimeRange', 1000, 2000, {}), { from: 1000, to: 2000 });
    assert.deepEqual(await shared.read('countFactsByTimeRange', 0, 1000, {}), { from: 0, to: 1000 });
    assert.equal(calls.length, 2);
  });

  it('絞り込みが違えば別に読む', async () => {
    const calls = [];
    const shared = createSharedReader({
      reader: { read: async (fn, from, to, options) => { calls.push(options); return calls.length; } },
      now: () => 100_000_000,
    });
    await shared.read('countFactsByTimeRange', 1_000, null, { sourceScope: null });
    await shared.read('countFactsByTimeRange', 1_000, null, { sourceScope: { sourceKind: 'agent', sourceId: 'a' } });
    assert.equal(calls.length, 2);
  });
});
