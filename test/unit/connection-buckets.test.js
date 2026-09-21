'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createConnectionBuckets, BUCKET_MS } = require('../../src/connection-buckets');

// P3-155. `connections` holds one row per flow and moves lastSeen every time
// the flow is seen again, so counting by lastSeen answers "when did each flow
// stop", not "when was there traffic". A closed window can be counted
// correctly; an open one cannot.
let db;
let clock;
let buckets;

function seed(rows) {
  const insert = db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
    VALUES (?, ?, ?, 'TCP', ?, ?)
    ON CONFLICT(src, dst, dport, proto) DO UPDATE SET lastSeen = excluded.lastSeen`);
  for (const r of rows) insert.run(r.src, r.dst, r.dport, r.firstSeen ?? r.lastSeen, r.lastSeen);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE connections (
      src TEXT NOT NULL, dst TEXT NOT NULL, dport INTEGER NOT NULL, proto TEXT NOT NULL,
      sport INTEGER, ttl INTEGER, srcMac TEXT, srcVendor TEXT, srcDnsName TEXT, srcMdnsName TEXT,
      dstHost TEXT, country TEXT, org TEXT, lat REAL, lon REAL, city TEXT,
      firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto)
    );
    CREATE TABLE connection_buckets (
      bucketStart INTEGER NOT NULL, dst TEXT NOT NULL, source TEXT NOT NULL, flows INTEGER NOT NULL,
      PRIMARY KEY (bucketStart, dst, source)
    );
    CREATE TABLE connection_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, routerId TEXT,
      firstObservedAt INTEGER, lastObservedAt INTEGER,
      PRIMARY KEY (src, dst, dport, proto, routerId)
    );
    CREATE TABLE connection_agent_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, agentId TEXT, observationId TEXT,
      PRIMARY KEY (src, dst, dport, proto, agentId, observationId)
    );
    CREATE TABLE agent_observations (
      agentId TEXT, observationId TEXT, localAddress TEXT, localPort INTEGER,
      remoteAddress TEXT, remotePort INTEGER, networkProtocol TEXT, processName TEXT,
      bundleId TEXT, processId INTEGER, firstObservedAt INTEGER, lastObservedAt INTEGER,
      PRIMARY KEY (agentId, observationId)
    );
    CREATE TABLE agents (agentId TEXT PRIMARY KEY, hostName TEXT);
    CREATE TABLE agent_app_hourly (
      hourStart INTEGER NOT NULL, agentId TEXT NOT NULL, appIdentity TEXT NOT NULL,
      processName TEXT NOT NULL, localAddress TEXT NOT NULL, remoteAddress TEXT NOT NULL,
      remotePort INTEGER NOT NULL, networkProtocol TEXT NOT NULL,
      firstObservedAt INTEGER NOT NULL, lastObservedAt INTEGER NOT NULL,
      PRIMARY KEY (hourStart, agentId, appIdentity, localAddress, remoteAddress, remotePort, networkProtocol)
    );
  `);
  clock = 0;
  buckets = createConnectionBuckets({ getDb: () => db, now: () => clock, logger: { info() {}, warn() {} } });
});

const at = (bucket, offsetMs = 1000) => bucket * BUCKET_MS + offsetMs;

// The queue is drained one window per call on purpose -- counting a window
// writes rows, and doing two dozen in one pass held the event loop for 1.3
// seconds on a real Hub. Tests drain it to the end.
function drainAll(limit = 500) {
  let rows = 0;
  for (let i = 0; i < limit; i += 1) {
    const drained = buckets.drainAgentQueue();
    rows += drained.rows;
    if (!drained.pending && !drained.folded) break;
  }
  return rows;
}

function backfillAll(limit = 500) {
  let rows = 0;
  for (let i = 0; i < limit; i += 1) {
    if (buckets.queueNextPastAgentWindow() == null) break;
    rows += buckets.drainAgentQueue().rows;
  }
  return rows;
}

function seedAgentHour(bucket, rows) {
  const hourStart = Math.floor((bucket * BUCKET_MS) / 3600000) * 3600000;
  const insert = db.prepare(`INSERT INTO agent_app_hourly
    (hourStart, agentId, appIdentity, processName, localAddress, remoteAddress, remotePort,
     networkProtocol, firstObservedAt, lastObservedAt)
    VALUES (?, 'agent-1', ?, ?, ?, ?, ?, 'TCP', ?, ?)
    ON CONFLICT DO UPDATE SET lastObservedAt = excluded.lastObservedAt`);
  for (const r of rows) {
    insert.run(hourStart, r.local, r.local, r.local, r.remote, r.port, r.from, r.to);
  }
}
const flowsIn = (bucket) => db.prepare(
  'SELECT dst, SUM(flows) AS flows FROM connection_buckets WHERE bucketStart = ? GROUP BY dst ORDER BY dst')
  .all(bucket * BUCKET_MS);

describe('通信があった時刻を記録する（P3-155）', () => {
  it('閉じた窓だけを畳む。いまの窓はまだ動くので触らない', () => {
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);           // bucket 2 is open, bucket 1 has closed
    const result = buckets.foldRouter();
    assert.equal(result.folded >= 1, true);
    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.1', flows: 1 }]);
    assert.deepEqual(flowsIn(2), [], 'まだ動いている窓を数えてはいけない');
  });

  it('同じフローが続けば、居た窓それぞれに1件ずつ数える', () => {
    // One flow, seen in bucket 1 and again in bucket 2. By lastSeen alone it
    // would only ever appear in the newest one -- that is the whole defect.
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.foldRouter();
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(2) }]);
    clock = at(3, 30_000);
    buckets.foldRouter();
    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.1', flows: 1 }]);
    assert.deepEqual(flowsIn(2), [{ dst: '203.0.113.1', flows: 1 }],
      '続いているフローが古い窓から消えてはいけない');
  });

  it('宛先ごとに数える', () => {
    seed([
      { src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) },
      { src: '10.0.0.2', dst: '203.0.113.1', dport: 443, lastSeen: at(1) },
      { src: '10.0.0.1', dst: '203.0.113.9', dport: 443, lastSeen: at(1) },
    ]);
    clock = at(2, 30_000);
    buckets.foldRouter();
    assert.deepEqual(flowsIn(1), [
      { dst: '203.0.113.1', flows: 2 },
      { dst: '203.0.113.9', flows: 1 },
    ]);
  });

  it('二度畳んでも二重に数えない', () => {
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.foldRouter();
    buckets._resetForTest();
    buckets.foldRouter();
    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.1', flows: 1 }]);
  });

  it('止まっていた間の窓は、数えずに飛ばす', () => {
    // A window that closed while the Hub was down cannot be counted any more:
    // every flow that kept running has moved its lastSeen to now, so what is
    // left in that window is only the flows that stopped. Counting it would
    // put the original defect back into the table one window at a time.
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.foldRouter();
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(500) }]);
    clock = at(501, 30_000);         // back after nearly two days off
    const result = buckets.foldRouter();
    assert.equal(result.skipped > 0, true, '飛ばした窓の数を言わなければならない');
    assert.deepEqual(flowsIn(250), [], '見ていなかった窓に数字を作ってはいけない');
    assert.deepEqual(flowsIn(500), [{ dst: '203.0.113.1', flows: 1 }],
      '閉じたばかりの窓は数える');
  });

  it('初回は過去を作らない。記録はいまから始まる', () => {
    // Sixteen buckets of history sitting in `connections`, and none of it can
    // be described: this is the first fold this Hub has ever run.
    seed([
      { src: '10.0.0.1', dst: '203.0.113.1', dport: 443, firstSeen: at(1), lastSeen: at(1) },
      { src: '10.0.0.2', dst: '203.0.113.9', dport: 443, firstSeen: at(1), lastSeen: at(19) },
    ]);
    clock = at(20, 30_000);
    buckets.foldRouter();
    assert.deepEqual(flowsIn(1), [], '過去の窓を lastSeen で数え直してはいけない');
    assert.equal(buckets.earliestBucket() >= at(18, 0), true, '記録はいま始まる');
  });

  it('閉じた直後に畳まないと、続いているフローを取りこぼす', () => {
    // Why the fold has to sit on the boundary and not merely tick at the
    // window's length. A flow keeps its lastSeen inside its window only until
    // it is seen again; fold late and only the flows that stopped are left.
    const stillRunning = { src: '10.0.0.1', dst: '203.0.113.1', dport: 443 };
    const stopped = { src: '10.0.0.2', dst: '203.0.113.9', dport: 443 };
    seed([
      { ...stillRunning, lastSeen: at(1, 200_000) },
      { ...stopped, lastSeen: at(1, 200_000) },
    ]);

    // The flow that is still running is seen again early in the next window.
    seed([{ ...stillRunning, lastSeen: at(2, 30_000) }]);
    clock = at(2, 240_000);          // and only now does a late fold run
    buckets.foldRouter();

    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.9', flows: 1 }],
      '遅れて畳むと、止まったフローしか残らない');
  });

  it('1ティックで畳むのは1窓だけ', () => {
    // 54 ms a window, measured. Two dozen of them in one pass blocked the
    // event loop for 1.3 seconds and put back the stalls P3-139 removed.
    seedAgentHour(1, [
      { remote: '203.0.113.7', local: '10.0.0.1', port: 443, from: at(1, 10_000), to: at(1, 60_000) },
    ]);
    clock = at(14, 0);
    const queued = buckets.queueRecentAgentWindows();
    assert.equal(queued > 1, true, '複数の窓が待ち行列に入る');

    const first = buckets.drainAgentQueue();
    assert.equal(first.folded, 1, '一度に1窓を超えて畳んではいけない');
    assert.equal(first.pending, queued - 1, '残りは次のティックに回す');
  });

  it('保持期間を過ぎた窓は捨てる', () => {
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.foldRouter();
    clock = at(1) + 15 * 24 * 3600e3;
    assert.equal(buckets.prune(), 1);
    assert.deepEqual(flowsIn(1), []);
  });

  it('Agentが見た通信は、あとから届いても窓に加わる', () => {
    // An Agent uploads in batches. A window folded seconds after it closed
    // holds nothing of what has not arrived yet -- measured on the Hub, 22
    // flows where the Agent's own record says 1,081. Agent observations carry
    // their times, so counting that window again later is not a guess.
    clock = at(3, 30_000);
    buckets.queueRecentAgentWindows();
    drainAll();
    assert.deepEqual(flowsIn(2), [], 'まだ何も届いていない');

    seedAgentHour(2, [
      { remote: '203.0.113.7', local: '10.0.0.1', port: 443, from: at(2, 10_000), to: at(2, 200_000) },
      { remote: '203.0.113.7', local: '10.0.0.2', port: 443, from: at(2, 20_000), to: at(2, 100_000) },
    ]);
    buckets.queueRecentAgentWindows();
    drainAll();

    assert.deepEqual(flowsIn(2), [{ dst: '203.0.113.7', flows: 2 }],
      '遅れて届いた観測が窓に入らなければならない');
  });

  it('Agentの記録からは、過去の窓も埋められる', () => {
    // Router-observed flows cannot be recovered for the past. Agent-observed
    // ones can, because the Agent wrote down when it saw them.
    seedAgentHour(1, [
      { remote: '203.0.113.7', local: '10.0.0.1', port: 443, from: at(1, 10_000), to: at(1, 60_000) },
    ]);
    clock = at(40, 0);               // long after the window closed
    const rows = backfillAll();
    assert.equal(rows > 0, true);
    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.7', flows: 1 }]);
  });

  it('同じフローをルータとAgentの両方から数えない', () => {
    seed([{ src: '10.0.0.1', dst: '203.0.113.7', dport: 443, lastSeen: at(1) }]);
    db.prepare(`INSERT INTO connection_agent_observations (src, dst, dport, proto, agentId, observationId)
      VALUES ('10.0.0.1', '203.0.113.7', 443, 'TCP', 'agent-1', 'obs-1')`).run();
    seedAgentHour(1, [
      { remote: '203.0.113.7', local: '10.0.0.1', port: 443, from: at(1, 10_000), to: at(1, 60_000) },
    ]);
    clock = at(2, 30_000);
    buckets.foldRouter();
    buckets.queueRecentAgentWindows();
    drainAll();
    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.7', flows: 1 }],
      'Agentが見ているフローをルータ側でも数えてはいけない');
  });

  it('どこから全体を答えられるかを言える', () => {
    seedAgentHour(1, [
      { remote: '203.0.113.7', local: '10.0.0.1', port: 443, from: at(1, 10_000), to: at(1, 60_000) },
    ]);
    clock = at(8, 30_000);
    backfillAll();
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(7) }]);
    buckets.foldRouter();

    const coverage = buckets.coverage();
    assert.equal(coverage.from <= at(1), true, '記録の始まりはAgent分まで遡る');
    assert.equal(coverage.routerFrom >= at(6), true,
      'ルータ分が始まる時点を別に言わなければならない');
  });

  it('記録の始まりを言える。無い期間を描いてはいけないので', () => {
    assert.equal(buckets.earliestBucket(), null, '何も畳んでいなければ null');
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(7) }]);
    clock = at(8, 30_000);
    buckets.foldRouter();
    assert.equal(buckets.earliestBucket() <= at(7), true);
  });
});

// The fold is only worth having if the chart reads it.
describe('要約の時系列が、畳んだ窓を読む（P3-155）', () => {
  const { createHistoryQueries } = require('../../src/history-queries');

  function queriesOn(database) {
    return createHistoryQueries({
      getDb: () => database,
      getDbPath: () => ':memory:',
      Database,
      connectionReadColumns: '*',
      hydrateConnectionRows: rows => rows,
      normalizeObservedBy: () => [],
      compatibilitySource: () => null,
      summarizeAppGroups: rows => rows,
    });
  }

  it('続いているフローが、居た窓すべてに現れる', () => {
    const now = Date.now();
    const b = (n) => Math.floor(now / BUCKET_MS) * BUCKET_MS - n * BUCKET_MS;
    // One flow, alive across three windows. Counted by lastSeen it would
    // appear once, in the newest.
    for (const [i, at] of [[3, b(3)], [2, b(2)], [1, b(1)]]) {
      void i;
      db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
        VALUES ('10.0.0.1', '203.0.113.1', 443, 'TCP', ?, ?)
        ON CONFLICT(src, dst, dport, proto) DO UPDATE SET lastSeen = excluded.lastSeen`).run(b(3), at);
      clock = at + BUCKET_MS + 1000;
      buckets.foldRouter();
    }

    const summary = queriesOn(db).summarizeByTimeRange(b(4), null, { buckets: 60 });
    const total = summary.timeline.reduce((sum, r) => sum + r.count, 0);
    assert.equal(total, 3, '3つの窓それぞれに1件ずつ出るべき');
    assert.equal(new Set(summary.timeline.map(r => r.bucket)).size, 3,
      '同じ窓にまとまってはいけない');
    assert.ok(summary.timelineFrom <= b(3), '記録の始まりを返す');
  });

  it('記録より細かい刻みでは描かない', () => {
    // 5-minute windows drawn into 2.5-minute bars leaves every second bar
    // empty. Measured on a Hub: 31 of 60 bars came back zero and the chart
    // drew a row of spikes, which reads as traffic stopping and restarting
    // every few minutes. The numbers were right; the shape was not.
    const now = Date.now();
    const b = (n) => Math.floor(now / BUCKET_MS) * BUCKET_MS - n * BUCKET_MS;
    for (let i = 6; i >= 1; i -= 1) {
      db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
        VALUES ('10.0.0.1', ?, 443, 'TCP', ?, ?)
        ON CONFLICT(src, dst, dport, proto) DO UPDATE SET lastSeen = excluded.lastSeen`)
        .run(`203.0.113.${i}`, b(i), b(i));
      clock = b(i) + BUCKET_MS + 1000;
      buckets.foldRouter();
    }

    // Six windows, asked for as sixty bars: about 30 seconds each.
    const summary = queriesOn(db).summarizeByTimeRange(b(7), null, { buckets: 60 });
    const counted = new Map();
    for (const row of summary.timeline) {
      counted.set(row.bucket, (counted.get(row.bucket) || 0) + row.count);
    }
    assert.equal(summary.buckets <= 8, true,
      `記録が${6}窓しかないのに${summary.buckets}本を返してはいけない`);
    assert.equal(counted.size, summary.timeline.length ? counted.size : 0);
    const emptyBars = summary.buckets - counted.size;
    assert.equal(emptyBars <= 2, true, `空の棒が${emptyBars}本もあってはいけない`);
  });

  it('まだ閉じていない窓は描かない', () => {
    // The current window is still collecting. Drawn anyway it is a bar at
    // nearly nothing on the right-hand edge of every chart, which reads as
    // traffic having just stopped.
    const now = Date.now();
    const b = (n) => Math.floor(now / BUCKET_MS) * BUCKET_MS - n * BUCKET_MS;
    for (let i = 3; i >= 1; i -= 1) {
      db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
        VALUES ('10.0.0.1', '203.0.113.1', 443, 'TCP', ?, ?)
        ON CONFLICT(src, dst, dport, proto) DO UPDATE SET lastSeen = excluded.lastSeen`)
        .run(b(3), b(i));
      clock = b(i) + BUCKET_MS + 1000;
      buckets.foldRouter();
    }

    const summary = queriesOn(db).summarizeByTimeRange(b(4), null, { buckets: 60 });
    const lastBar = Math.max(...summary.timeline.map(r => r.bucket));
    assert.equal(lastBar, summary.buckets - 1,
      '最後の棒まで値があること（空の棒で終わってはいけない）');
  });

  it('記録より短い期間でも、空のグラフにはしない', () => {
    // "live" asks for five minutes, which is shorter than one window. Drawing
    // the requested period exactly leaves nothing on screen at all.
    const now = Date.now();
    const b = (n) => Math.floor(now / BUCKET_MS) * BUCKET_MS - n * BUCKET_MS;
    db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
      VALUES ('10.0.0.1', '203.0.113.1', 443, 'TCP', ?, ?)`).run(b(1), b(1));
    clock = b(1) + BUCKET_MS + 1000;
    buckets.foldRouter();

    const summary = queriesOn(db).summarizeByTimeRange(now - 5 * 60_000, null, { buckets: 60 });
    assert.equal(summary.timeline.length > 0, true, '直近の閉じた窓を描かなければならない');
    assert.equal(summary.timelineRange.from <= b(1), true, '軸もその窓まで広げる');
  });

  it('記録の無い期間は、ゼロの棒で埋めない', () => {
    // Fourteen days asked for with one window recorded: drawing the whole
    // period is a flat line at zero for almost all of it, which says there was
    // no traffic rather than that nobody was looking.
    const now = Date.now();
    const b = (n) => Math.floor(now / BUCKET_MS) * BUCKET_MS - n * BUCKET_MS;
    db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
      VALUES ('10.0.0.1', '203.0.113.1', 443, 'TCP', ?, ?)`).run(b(2), b(2));
    clock = b(2) + BUCKET_MS + 1000;
    buckets.foldRouter();

    const summary = queriesOn(db).summarizeByTimeRange(now - 14 * 24 * 3600e3, null, { buckets: 60 });
    assert.equal(summary.timelineRange.from >= b(3), true,
      '記録の始まりより前まで軸を伸ばしてはいけない');
    assert.equal(summary.timelineFrom <= b(2), true,
      '記録がいつ始まったかは、注記のために返し続ける');
    const filled = new Set(summary.timeline.map(r => r.bucket)).size;
    assert.equal(summary.buckets - filled <= 1, true,
      `空の棒が${summary.buckets - filled}本もあってはいけない`);
  });

  it('宛先の名前は、いまの enrichment で解決する', () => {
    const now = Date.now();
    const at = Math.floor(now / BUCKET_MS) * BUCKET_MS - BUCKET_MS;
    db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
      VALUES ('10.0.0.1', '203.0.113.1', 443, 'TCP', ?, ?)`).run(at, at);
    clock = at + BUCKET_MS + 1000;
    buckets.foldRouter();
    // The name arrives after the fold, which is why the label is not frozen.
    db.prepare("UPDATE connections SET org = 'Example Network' WHERE dst = '203.0.113.1'").run();

    const summary = queriesOn(db).summarizeByTimeRange(at - BUCKET_MS, null, { buckets: 60 });
    assert.ok(summary.timeline.some(r => r.key === 'Example Network'),
      '畳んだ後に付いた名前が反映されるべき');
  });
});
