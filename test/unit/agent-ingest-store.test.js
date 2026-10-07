'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../../src/agent-ingest-store');

const golden = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../protocol/agent-ingest/v1/golden.json'),
  'utf8'
));
const agentId = '00000000-0000-4000-8000-000000000001';
const receivedAt = Date.parse('2026-08-11T12:00:01Z');

function copy(value = golden) {
  return structuredClone(value);
}

beforeEach(() => store._initForTest());
after(() => store.closeDb());

describe('Agent ingest store', () => {
  it('stores one batch atomically and preserves uint64 byte counts as text', async () => {
    const ack = await store.storeBatch(agentId, copy(), { receivedAt });
    assert.deepEqual(ack, {
      batchId: golden.batchId,
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      receivedAt,
      replayed: false,
    });
    const row = store._dbForTest().prepare('SELECT * FROM agent_observations').get();
    assert.equal(row.agentId, agentId);
    assert.equal(row.processId, 42);
    assert.equal(row.bytesIn, '9007199254740993');
    assert.equal(row.bytesOut, null);
    const appRollup = store._dbForTest().prepare('SELECT * FROM agent_app_hourly').get();
    assert.equal(appRollup.agentId, agentId);
    assert.equal(appRollup.processName, golden.observations[0].processName);
    assert.equal(appRollup.appIdentity, golden.observations[0].bundleID);
  });

  it('accepts the Windows ETW collector under the production DB contract', async () => {
    const envelope = copy();
    envelope.agent.platform = 'windows';
    envelope.observations[0].collector = 'etw';

    const ack = await store.storeBatch(agentId, envelope, { receivedAt });

    assert.equal(ack.accepted, 1);
    assert.equal(ack.duplicate, 0);
    assert.equal(ack.rejected, 0);
    assert.equal(store._dbForTest().prepare(
      'SELECT collector FROM agent_observations'
    ).get().collector, 'etw');
  });

  it('separates accepted, duplicate, and DB-rejected observations', async () => {
    await store.storeBatch(agentId, copy(), { receivedAt });
    const envelope = copy();
    envelope.batchId = '00000000-0000-4000-8000-000000000099';
    envelope.observations.push({
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000088',
      collector: 'unknown-collector',
    }, {
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000089',
      collector: 'etw',
    });

    const ack = await store.storeBatch(agentId, envelope, { receivedAt: receivedAt + 1 });

    assert.deepEqual(ack, {
      batchId: envelope.batchId,
      accepted: 1,
      duplicate: 1,
      rejected: 1,
      receivedAt: receivedAt + 1,
      replayed: false,
    });
    assert.deepEqual(ack.acceptedObservationIds, [
      '00000000-0000-4000-8000-000000000089',
    ]);
    assert.equal(JSON.stringify(ack).includes('acceptedObservationIds'), false);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 2);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_app_hourly').get().n, 1);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 1);

    const retry = await store.storeBatch(agentId, envelope, { receivedAt: receivedAt + 2 });
    assert.equal(retry.replayed, false);
    assert.equal(retry.accepted, 0);
    assert.equal(retry.duplicate, 2);
    assert.equal(retry.rejected, 1);
  });

  it('returns the original ACK for 100 retries without duplicating storage', async () => {
    const first = await store.storeBatch(agentId, copy(), { receivedAt });
    for (let index = 0; index < 100; index += 1) {
      const replay = await store.storeBatch(agentId, copy(), { receivedAt: receivedAt + index + 1 });
      assert.deepEqual(replay, { ...first, replayed: true });
    }
    const database = store._dbForTest();
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_app_hourly').get().n, 1);
  });

  it('folds the same hourly app identity but preserves a second app on the same flow', async () => {
    const envelope = copy();
    const original = envelope.observations[0];
    envelope.observations = [
      original,
      {
        ...structuredClone(original),
        observationId: '00000000-0000-4000-8000-000000000088',
        processID: 43,
        firstObservedAt: '2026-08-11T12:00:02.000Z',
        lastObservedAt: '2026-08-11T12:00:03.000Z',
      },
      {
        ...structuredClone(original),
        observationId: '00000000-0000-4000-8000-000000000089',
        processID: 44,
        processName: 'Second App',
        bundleID: 'com.example.second',
      },
    ];

    const ack = await store.storeBatch(agentId, envelope, { receivedAt });
    const rows = store._dbForTest().prepare(
      'SELECT * FROM agent_app_hourly ORDER BY appIdentity'
    ).all();

    assert.equal(ack.accepted, 3);
    assert.equal(rows.length, 2);
    const example = rows.find(row => row.appIdentity === original.bundleID);
    assert.equal(example.firstObservedAt, Date.parse(original.firstObservedAt));
    assert.equal(example.lastObservedAt, Date.parse('2026-08-11T12:00:03.000Z'));
    assert(rows.some(row => row.appIdentity === 'com.example.second'));
  });

  it('counts an observation reused by a different batch as a duplicate', async () => {
    await store.storeBatch(agentId, copy(), { receivedAt });
    const second = copy();
    second.batchId = '00000000-0000-4000-8000-000000000099';
    const ack = await store.storeBatch(agentId, second, { receivedAt: receivedAt + 1 });
    assert.equal(ack.accepted, 0);
    assert.equal(ack.duplicate, 1);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);
  });

  it('keeps the same observationId independent across Agents', async () => {
    await store.storeBatch(agentId, copy(), { receivedAt });
    const otherAgent = '00000000-0000-4000-8000-000000000002';
    const ack = await store.storeBatch(otherAgent, copy(), { receivedAt });
    assert.equal(ack.accepted, 1);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 2);
  });

  it('大きなバッチでも、1回に書くのは50件まで', async () => {
    // A whole batch in one transaction was 71 to 149 ms on the Hub, and that
    // figure is set by the batch size, not by how many agents there are. The
    // loop gets a turn between chunks so nothing waits that long for it.
    const envelope = copy();
    const original = envelope.observations[0];
    envelope.observations = Array.from({ length: 120 }, (_, i) => ({
      ...structuredClone(original),
      observationId: `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
      localPort: 1024 + i,
    }));

    let turns = 0;
    const tick = setInterval(() => { turns += 1; }, 1);
    const ack = await store.storeBatch(agentId, envelope, { receivedAt });
    clearInterval(tick);

    assert.equal(ack.accepted, 120);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 120);
    assert.equal(turns > 0, true, '書いている間、他が一度も走れていない');
  });

  it('途中で落ちても、再送で完成する', async () => {
    // The batch is no longer written atomically, and that is safe by
    // construction: an observation carries its own primary key, and the batch
    // row is written only once every chunk is in. A Hub that dies halfway
    // leaves observations with no batch row; the agent resends the same
    // batchId and the second attempt counts them as duplicates and finishes.
    const database = store._dbForTest();
    const envelope = copy();
    const original = envelope.observations[0];
    envelope.observations = Array.from({ length: 60 }, (_, i) => ({
      ...structuredClone(original),
      observationId: `00000000-0000-4000-8000-${String(i + 200).padStart(12, '0')}`,
      localPort: 2048 + i,
      // The 55th cannot be stored, which is in the second chunk.
      processName: i === 55 ? 'RejectThisObservation' : original.processName,
    }));
    database.exec(`
      CREATE TRIGGER reject_test_observation
      BEFORE INSERT ON agent_observations
      WHEN NEW.processName = 'RejectThisObservation'
      BEGIN SELECT RAISE(ABORT, 'test rejection'); END;
    `);

    await assert.rejects(
      () => store.storeBatch(agentId, envelope, { receivedAt }),
      /test rejection/
    );
    // The first chunk stands; the batch does not.
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 50);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 0);

    database.exec('DROP TRIGGER reject_test_observation');
    const retry = await store.storeBatch(agentId, envelope, { receivedAt: receivedAt + 1 });
    assert.equal(retry.duplicate, 50, '入っている分は重複として数える');
    assert.equal(retry.accepted, 10);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 60);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 1);
  });

  it('rolls back the whole batch when any observation cannot be stored', async () => {
    const database = store._dbForTest();
    database.exec(`
      CREATE TRIGGER reject_test_observation
      BEFORE INSERT ON agent_observations
      WHEN NEW.processName = 'RejectThisObservation'
      BEGIN SELECT RAISE(ABORT, 'test rejection'); END;
    `);
    const envelope = copy();
    envelope.observations.push({
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000088',
      processName: 'RejectThisObservation',
    });
    await assert.rejects(
      () => store.storeBatch(agentId, envelope, { receivedAt }),
      /test rejection/
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
  });

  // Ingest used to correlate inline, which is what made this test necessary:
  // the point was that a broken correlation table could not lose an accepted
  // batch. Ingest no longer touches correlation at all, so the stronger
  // property is asserted instead -- it does not even look.
  it('does not correlate on the ingest path', async () => {
    const database = store._dbForTest();
    database.exec('DROP TABLE connection_agent_observations');

    const ack = await store.storeBatch(agentId, copy(), { receivedAt });

    assert.equal(ack.accepted, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);
  });

  it('prunes expired originals and their orphaned batch receipts', async () => {
    await store.storeBatch(agentId, copy(), { receivedAt });
    const result = store.pruneObservations({ before: receivedAt + 1 });
    const { timings, ...counts } = result;
    assert.deepEqual(counts, { correlations: 0, observations: 1, hourly: 1, batches: 1, more: false });
    assert.deepEqual(Object.keys(timings).sort(),
      ['hourlyMs', 'observationsMs', 'receiptsMs', 'slowestTransactionMs']);
    assert.ok(timings.slowestTransactionMs <= timings.observationsMs + timings.hourlyMs + timings.receiptsMs);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_app_hourly').get().n, 0);
  });
});

// P3-14 stage 2: the name the client actually used, carried from the agent
// rather than guessed by a reverse lookup.
describe('観測に付いてきた宛先名', () => {
  it('送られてきた名前を保存する', async () => {
    const envelope = copy();
    envelope.observations[0].remoteHostname = 'api.example.com';
    await store.storeBatch(agentId, envelope, { receivedAt });
    const row = store._dbForTest()
      .prepare('SELECT remoteHostname FROM agent_observations WHERE observationId = ?')
      .get(envelope.observations[0].observationId);
    assert.equal(row.remoteHostname, 'api.example.com');
  });

  it('名前が無い観測はNULLで保存され、拒否されない', async () => {
    // An agent that does not send the field, and a flow the Network Extension
    // could not name, must both keep working -- that is the whole point of the
    // field being optional.
    const envelope = copy();
    delete envelope.observations[0].remoteHostname;
    const ack = await store.storeBatch(agentId, envelope, { receivedAt });
    assert.equal(ack.rejected, 0);
    const row = store._dbForTest()
      .prepare('SELECT remoteHostname FROM agent_observations WHERE observationId = ?')
      .get(envelope.observations[0].observationId);
    assert.equal(row.remoteHostname, null);
  });
});

// A flow's closing report, sent under the observation id of its opening
// report, completes the stored row instead of being dropped as a duplicate
// (P3-170). One row per connection, with its byte counts.
describe('終了時の報告で、開始時の行を完成させる', () => {
  const secondBatch = '00000000-0000-4000-8000-0000000000b2';

  function opening() {
    const envelope = copy();
    Object.assign(envelope.observations[0], {
      localPort: 0, bytesIn: null, bytesOut: null,
      lastObservedAt: '2026-08-11T11:59:58Z', remoteHostname: 'api.example',
    });
    return envelope;
  }
  function closing(changes = {}) {
    const envelope = copy();
    envelope.batchId = secondBatch;
    Object.assign(envelope.observations[0], {
      bytesIn: '5000', bytesOut: '700', lastObservedAt: '2026-08-11T13:00:05Z',
    }, changes);
    return envelope;
  }
  function rows() {
    return store._dbForTest().prepare(`SELECT localPort, bytesIn, bytesOut, lastObservedAt, remoteHostname
      FROM agent_observations`).all();
  }

  it('同じ observationId で届いたバイト数を、バイト数の無い行に書き込む', async () => {
    await store.storeBatch(agentId, opening(), { receivedAt });
    const ack = await store.storeBatch(agentId, closing(), { receivedAt: receivedAt + 1 });

    // The agent checks accepted + duplicate against what it sent.
    assert.equal(ack.accepted, 0);
    assert.equal(ack.duplicate, 1);
    assert.equal(ack.completed, 1);
    // The opening report knew its address; only the port was missing. Nothing to move.
    assert.deepEqual([...ack.relocated], []);
    assert.deepEqual(rows(), [{
      localPort: 49152, bytesIn: '5000', bytesOut: '700',
      lastObservedAt: Date.parse('2026-08-11T13:00:05Z'), remoteHostname: 'api.example',
    }]);
  });

  it('同じ終了時の報告を再送しても、行は変わらない', async () => {
    await store.storeBatch(agentId, opening(), { receivedAt });
    await store.storeBatch(agentId, closing(), { receivedAt: receivedAt + 1 });
    const retry = closing({ bytesIn: '9999' });
    retry.batchId = '00000000-0000-4000-8000-0000000000b3';
    const ack = await store.storeBatch(agentId, retry, { receivedAt: receivedAt + 2 });

    assert.equal(ack.completed, 0);
    assert.equal(rows()[0].bytesIn, '5000');
    assert.equal(rows().length, 1);
  });

  it('宛先・プロトコル・プロセスが違えば、別の接続の行を書き換えない', async () => {
    for (const change of [
      { remoteAddress: '198.51.100.99' }, { remotePort: 8443 }, { processID: 43 }, { networkProtocol: 'udp' },
    ]) {
      store._initForTest();
      await store.storeBatch(agentId, opening(), { receivedAt });
      const ack = await store.storeBatch(agentId, closing(change), { receivedAt: receivedAt + 1 });
      assert.equal(ack.completed, 0, `書き換えた: ${JSON.stringify(change)}`);
      assert.equal(rows()[0].bytesIn, null);
    }
  });

  it('開始時の行が実際のポートを持っていれば、別のポートの報告では書き換えない', async () => {
    const withPort = opening();
    withPort.observations[0].localPort = 50000;
    await store.storeBatch(agentId, withPort, { receivedAt });
    const ack = await store.storeBatch(agentId, closing({ localPort: 50001 }), { receivedAt: receivedAt + 1 });

    assert.equal(ack.completed, 0);
    assert.equal(rows()[0].bytesIn, null);
  });

  it('終わった時刻が後の時間帯なら、アプリ別の時間集計にもその時間帯が入る', async () => {
    await store.storeBatch(agentId, opening(), { receivedAt });
    await store.storeBatch(agentId, closing(), { receivedAt: receivedAt + 1 });

    const hours = store._dbForTest().prepare('SELECT hourStart FROM agent_app_hourly ORDER BY hourStart').all()
      .map(row => new Date(row.hourStart).toISOString());
    assert.deepEqual(hours, ['2026-08-11T11:00:00.000Z', '2026-08-11T13:00:00.000Z']);
  });

  it('開始時にローカルのアドレスが未定（0.0.0.0:0）なら、終了時の報告のアドレスとポートで埋める', async () => {
    const unbound = opening();
    unbound.observations[0].localAddress = '0.0.0.0';
    await store.storeBatch(agentId, unbound, { receivedAt });
    const ack = await store.storeBatch(agentId, closing({ localAddress: '192.0.2.10', localPort: 49152 }),
      { receivedAt: receivedAt + 1 });

    assert.equal(ack.completed, 1);
    const [row] = store._dbForTest().prepare('SELECT localAddress, localPort FROM agent_observations').all();
    assert.deepEqual({ ...row }, { localAddress: '192.0.2.10', localPort: 49152 });
    // P3-185: the connection row built from the opening report is keyed on
    // 0.0.0.0, and the route needs to know where it belongs.
    const stored = copy().observations[0];
    assert.deepEqual(ack.relocated.map(move => ({ ...move })), [{
      fromSrc: '0.0.0.0', toSrc: '192.0.2.10', toSport: 49152,
      dst: stored.remoteAddress, dport: stored.remotePort, proto: stored.networkProtocol,
    }]);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(ack)), 'relocated'), false);
    // The hour the flow ended in is counted under the address it left from.
    const hourly = store._dbForTest().prepare(`SELECT localAddress FROM agent_app_hourly
      WHERE hourStart = ?`).get(Date.parse('2026-08-11T13:00:00Z'));
    assert.equal(hourly.localAddress, '192.0.2.10');
  });

  it('IPv6 の未定アドレス（::）も埋める', async () => {
    const unbound = opening();
    Object.assign(unbound.observations[0], { localAddress: '::', remoteAddress: '2001:db8::5' });
    await store.storeBatch(agentId, unbound, { receivedAt });
    await store.storeBatch(agentId, closing({ localAddress: '2001:db8::10', localPort: 49152, remoteAddress: '2001:db8::5' }),
      { receivedAt: receivedAt + 1 });

    const [row] = store._dbForTest().prepare('SELECT localAddress, localPort FROM agent_observations').all();
    assert.deepEqual({ ...row }, { localAddress: '2001:db8::10', localPort: 49152 });
  });

  it('終了時の報告も未定なら、保存済みのアドレスを消さない', async () => {
    await store.storeBatch(agentId, opening(), { receivedAt });
    await store.storeBatch(agentId, closing({ localAddress: '0.0.0.0', localPort: 0 }), { receivedAt: receivedAt + 1 });

    const [row] = store._dbForTest().prepare('SELECT localAddress, localPort, bytesIn FROM agent_observations').all();
    assert.equal(row.localAddress, copy().observations[0].localAddress);
    assert.equal(row.localPort, 0);
    assert.equal(row.bytesIn, '5000');
  });

  it('JSONの応答には completed を出さない（Agentが読む形を変えない）', async () => {
    await store.storeBatch(agentId, opening(), { receivedAt });
    const ack = await store.storeBatch(agentId, closing(), { receivedAt: receivedAt + 1 });

    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(ack)), 'completed'), false);
  });
});

// A day of observations deleted in one transaction held the Hub's event loop
// past the watchdog's 120 seconds every night (2026-09-28 and 09-29): the Hub
// was killed, the delete rolled back, and the restart's integrity check kept
// it down for about eleven minutes.
describe('期限切れの観測は、少しずつ消す', () => {
  const { randomUUID } = require('node:crypto');
  const hour = 3600 * 1000;

  async function deliver(agent, times, batchId = randomUUID()) {
    const envelope = copy();
    envelope.batchId = batchId;
    envelope.observations = times.map((at, index) => ({
      ...golden.observations[0],
      observationId: randomUUID(),
      localPort: 40000 + index,
      firstObservedAt: new Date(at - 1000).toISOString(),
      lastObservedAt: new Date(at).toISOString(),
    }));
    await store.storeBatch(agent, envelope, { receivedAt: Math.max(...times) + 1000 });
  }
  const count = table => store._dbForTest().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  it('時間の予算を使い切ったら残りがあると言い、次の呼び出しで続きを消す', async () => {
    const base = receivedAt;
    await deliver(agentId, Array.from({ length: 25 }, (_, i) => base + i));

    const first = store.pruneObservations({ before: base + hour, batchSize: 10, budgetMs: 0 });
    assert.equal(first.observations, 10, '1回目は1バッチだけ消す');
    assert.equal(first.more, true);
    assert.equal(count('agent_observations'), 15);

    let pass = first;
    let calls = 1;
    while (pass.more) {
      pass = store.pruneObservations({ before: base + hour, batchSize: 10, budgetMs: 0 });
      calls += 1;
      assert.ok(calls < 20, '有限回で終わる');
    }
    assert.equal(count('agent_observations'), 0);
    assert.equal(count('agent_app_hourly'), 0);
    assert.equal(count('agent_ingest_batches'), 0);
  });

  it('期限より新しい観測と、それが入っている時間の集計と受領記録は残す', async () => {
    const base = receivedAt - (receivedAt % hour);
    // One hour row holds an old observation and a newer one: the hour began
    // before the cutoff, but its row was touched after it.
    await deliver(agentId, [base + 60_000, base + 10 * 60_000], 'old-and-new');
    await deliver(agentId, [base - 2 * hour], 'all-old');

    const result = store.pruneObservations({ before: base + 5 * 60_000 });

    assert.equal(result.more, false);
    assert.equal(result.observations, 2);
    assert.equal(count('agent_observations'), 1, '新しい観測は残る');
    assert.equal(result.hourly, 1, '古い時間の行だけ消す');
    assert.equal(count('agent_app_hourly'), 1, '新しい観測が入っている時間の行は残る');
    assert.equal(result.batches, 1, 'まだ観測が参照している受領記録は残す');
    assert.equal(count('agent_ingest_batches'), 1);
  });

  it('エージェントごとに、参照されなくなった受領記録を消す', async () => {
    const other = '00000000-0000-4000-8000-000000000002';
    await deliver(agentId, [receivedAt]);
    await deliver(other, [receivedAt]);

    const result = store.pruneObservations({ before: receivedAt + hour });

    assert.equal(result.observations, 2);
    assert.equal(result.batches, 2);
    assert.equal(count('agent_ingest_batches'), 0);
  });
});

describe('遅い受け取りの書き込みは、どこに時間がかかったかを言う', () => {
  const logger = require('../../src/logger');
  it('ロック待ち・書き込み・確定の時間を分けてログに出す。拒否された時は取り消す', async () => {
    store._initForTest();
    const warned = [];
    const originalWarn = logger.warn;
    logger.warn = (...args) => warned.push(args.join(' '));
    store._setSlowWriteMsForTest(-1);
    try {
      await store.storeBatch(agentId, copy(), { receivedAt });
    } finally {
      logger.warn = originalWarn;
      store._setSlowWriteMsForTest(1000);
    }
    const lines = warned.filter(line => line.startsWith('[agent-ingest] slow write '));
    assert.deepEqual(lines.map(line => JSON.parse(line.slice('[agent-ingest] slow write '.length)).step),
      ['chunk', 'finish']);
    const parts = JSON.parse(lines[0].slice('[agent-ingest] slow write '.length));
    for (const key of ['totalMs', 'lockWaitMs', 'writeMs', 'commitMs']) assert.equal(typeof parts[key], 'number', key);
    assert.equal(store._dbForTest().inTransaction, false);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);
  });
});

describe('削除の件数は、ディスクの速さに合わせて変わる', () => {
  const adapt = store._adaptPruneBatchForTest;
  it('目標の100msを超えたら半分にし、十分短ければ倍にする', () => {
    assert.equal(adapt(1000, 250), 500);
    assert.equal(adapt(1000, 10), 2000);
    assert.equal(adapt(1000, 60), 1000);
  });
  it('50行から5000行の範囲に収める', () => {
    assert.equal(adapt(60, 5000), 50);
    assert.equal(adapt(4000, 1), 5000);
  });
  // The database thread holds the write lock against the main thread's
  // uploads, so it asks for smaller transactions (P3-184).
  it('上限と目標を指定されたら、それに合わせる', () => {
    assert.equal(adapt(400, 5, { maxBatch: 500 }), 500);
    assert.equal(adapt(400, 60, { targetMs: 50 }), 200);
    assert.equal(adapt(400, 30, { targetMs: 50 }), 400);
  });
});

describe('時間集計の削除は、1時間分を一度に消さない', () => {
  beforeEach(() => store._initForTest());
  it('指定した件数ずつ消し、時間の予算を使い切ったら続きを残す', () => {
    const database = store._dbForTest();
    const hourStart = Date.parse('2026-08-11T12:00:00Z');
    const insert = database.prepare(`INSERT INTO agent_app_hourly (
      hourStart, agentId, appIdentity, processName, localAddress, remoteAddress,
      remotePort, networkProtocol, firstObservedAt, lastObservedAt
    ) VALUES (?, 'agent-a', 'app', 'app', '192.0.2.1', ?, 443, 'tcp', ?, ?)`);
    for (let i = 0; i < 25; i += 1) insert.run(hourStart, `198.51.100.${i}`, hourStart, hourStart + 1000);
    const before = hourStart + 7_200_000;

    const first = store.pruneObservations({ before, batchSize: 10, budgetMs: 0 });
    assert.equal(first.hourly, 10, '1回の書き込みで消すのは10件まで');
    assert.equal(first.more, true);
    // Not `slowestTransactionMs <= hourlyMs`: the empty observation batch that
    // runs first is a transaction too, and on a busy runner it can take longer
    // than the hourly piece. That assertion failed CI on Node 22 once.
    assert.ok(first.timings.slowestTransactionMs
      <= first.timings.observationsMs + first.timings.hourlyMs + first.timings.receiptsMs);

    let total = first.hourly;
    for (let calls = 0; calls < 10; calls += 1) {
      const pass = store.pruneObservations({ before, batchSize: 10, budgetMs: 0 });
      total += pass.hourly;
      if (!pass.more) break;
    }
    assert.equal(total, 25);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_app_hourly').get().n, 0);
  });
});
