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
      bucketStart INTEGER NOT NULL, dst TEXT NOT NULL, flows INTEGER NOT NULL,
      PRIMARY KEY (bucketStart, dst)
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
const flowsIn = (bucket) => db.prepare('SELECT dst, flows FROM connection_buckets WHERE bucketStart = ? ORDER BY dst')
  .all(bucket * BUCKET_MS);

describe('通信があった時刻を記録する（P3-155）', () => {
  it('閉じた窓だけを畳む。いまの窓はまだ動くので触らない', () => {
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);           // bucket 2 is open, bucket 1 has closed
    const result = buckets.fold();
    assert.equal(result.folded >= 1, true);
    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.1', flows: 1 }]);
    assert.deepEqual(flowsIn(2), [], 'まだ動いている窓を数えてはいけない');
  });

  it('同じフローが続けば、居た窓それぞれに1件ずつ数える', () => {
    // One flow, seen in bucket 1 and again in bucket 2. By lastSeen alone it
    // would only ever appear in the newest one -- that is the whole defect.
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.fold();
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(2) }]);
    clock = at(3, 30_000);
    buckets.fold();
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
    buckets.fold();
    assert.deepEqual(flowsIn(1), [
      { dst: '203.0.113.1', flows: 2 },
      { dst: '203.0.113.9', flows: 1 },
    ]);
  });

  it('二度畳んでも二重に数えない', () => {
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.fold();
    buckets._resetForTest();
    buckets.fold();
    assert.deepEqual(flowsIn(1), [{ dst: '203.0.113.1', flows: 1 }]);
  });

  it('止まっていた間の窓は、数えずに飛ばす', () => {
    // A window that closed while the Hub was down cannot be counted any more:
    // every flow that kept running has moved its lastSeen to now, so what is
    // left in that window is only the flows that stopped. Counting it would
    // put the original defect back into the table one window at a time.
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.fold();
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(500) }]);
    clock = at(501, 30_000);         // back after nearly two days off
    const result = buckets.fold();
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
    buckets.fold();
    assert.deepEqual(flowsIn(1), [], '過去の窓を lastSeen で数え直してはいけない');
    assert.equal(buckets.earliestBucket() >= at(18, 0), true, '記録はいま始まる');
  });

  it('保持期間を過ぎた窓は捨てる', () => {
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(1) }]);
    clock = at(2, 30_000);
    buckets.fold();
    clock = at(1) + 15 * 24 * 3600e3;
    assert.equal(buckets.prune(), 1);
    assert.deepEqual(flowsIn(1), []);
  });

  it('記録の始まりを言える。無い期間を描いてはいけないので', () => {
    assert.equal(buckets.earliestBucket(), null, '何も畳んでいなければ null');
    seed([{ src: '10.0.0.1', dst: '203.0.113.1', dport: 443, lastSeen: at(7) }]);
    clock = at(8, 30_000);
    buckets.fold();
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
      buckets.fold();
    }

    const summary = queriesOn(db).summarizeByTimeRange(b(4), null, { buckets: 60 });
    const total = summary.timeline.reduce((sum, r) => sum + r.count, 0);
    assert.equal(total, 3, '3つの窓それぞれに1件ずつ出るべき');
    assert.equal(new Set(summary.timeline.map(r => r.bucket)).size, 3,
      '同じ窓にまとまってはいけない');
    assert.ok(summary.timelineFrom <= b(3), '記録の始まりを返す');
  });

  it('宛先の名前は、いまの enrichment で解決する', () => {
    const now = Date.now();
    const at = Math.floor(now / BUCKET_MS) * BUCKET_MS - BUCKET_MS;
    db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
      VALUES ('10.0.0.1', '203.0.113.1', 443, 'TCP', ?, ?)`).run(at, at);
    clock = at + BUCKET_MS + 1000;
    buckets.fold();
    // The name arrives after the fold, which is why the label is not frozen.
    db.prepare("UPDATE connections SET org = 'Example Network' WHERE dst = '203.0.113.1'").run();

    const summary = queriesOn(db).summarizeByTimeRange(at - BUCKET_MS, null, { buckets: 60 });
    assert.ok(summary.timeline.some(r => r.key === 'Example Network'),
      '畳んだ後に付いた名前が反映されるべき');
  });
});
