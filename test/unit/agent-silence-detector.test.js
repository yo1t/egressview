'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const {
  findSilentAgents, silenceKey, silenceKeysFromLog, ROUTER_SETTLE_MS,
} = require('../../src/agent-silence-detector');

// P3-103. A Mac recorded nothing for 13h27m on 2026-08-18 and nothing said so.
const MIN = 60 * 1000;
const T = 1_800_000_000_000;

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (agentId TEXT PRIMARY KEY, hostName TEXT, revokedAt INTEGER);
    CREATE TABLE agent_ingest_batches (agentId TEXT, batchId TEXT, receivedAt INTEGER);
    CREATE TABLE agent_observations (
      agentId TEXT, observationId TEXT, localAddress TEXT, firstObservedAt INTEGER, lastObservedAt INTEGER);
    CREATE TABLE connection_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, routerId TEXT,
      firstObservedAt INTEGER, lastObservedAt INTEGER);
    INSERT INTO agents VALUES ('a1', 'JAMESBOND', NULL), ('a2', 'THUNDERBALL', NULL);
  `);
  return db;
}
let seq = 0;
function delivered(db, agentId, at) {
  db.prepare('INSERT INTO agent_ingest_batches VALUES (?, ?, ?)').run(agentId, `b${++seq}`, at);
}
function agentUsed(db, agentId, localAddress, at) {
  db.prepare('INSERT INTO agent_observations VALUES (?, ?, ?, ?, ?)').run(agentId, `o${++seq}`, localAddress, at, at);
}
function routerSaw(db, src, firstAt, lastAt = firstAt) {
  db.prepare("INSERT INTO connection_observations VALUES (?, ?, 443, 'tcp', 'r1', ?, ?)")
    .run(src, `198.51.100.${++seq % 250}`, firstAt, lastAt);
}
// JAMESBOND last reported at T from 192.168.1.50, which a router knows.
function quietAgent() {
  const db = database();
  delivered(db, 'a1', T);
  agentUsed(db, 'a1', '192.168.1.50', T - MIN);
  routerSaw(db, '192.168.1.50', T - 60 * MIN);
  return db;
}

describe('Agent silence detection', () => {
  it('Agentが15分以上届かず、その間にルーターが新しい接続を3件以上見たら見つける', () => {
    const db = quietAgent();
    for (const m of [5, 9, 14]) routerSaw(db, '192.168.1.50', T + m * MIN);
    const findings = findSilentAgents(db, { now: T + 20 * MIN });
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], {
      agentId: 'a1', hostName: 'JAMESBOND', address: '192.168.1.50', lastDeliveredAt: T,
      routerConnections: 3, firstRouterAt: T + 5 * MIN, lastRouterAt: T + 14 * MIN,
    });
  });

  it('ルーターにも新しい接続が無ければ（スリープ・電源断）見つけない', () => {
    const db = quietAgent();
    assert.deepEqual(findSilentAgents(db, { now: T + 8 * 60 * MIN }), []);
  });

  it('寝ている機械のNATセッションが残って最終時刻だけ更新されても、新しい接続とは数えない', () => {
    const db = quietAgent();
    routerSaw(db, '192.168.1.50', T - 2 * MIN, T + 30 * MIN);
    routerSaw(db, '192.168.1.50', T - 3 * MIN, T + 30 * MIN);
    routerSaw(db, '192.168.1.50', T - 4 * MIN, T + 30 * MIN);
    assert.deepEqual(findSilentAgents(db, { now: T + 30 * MIN }), []);
  });

  it('最後に届いた直後の接続は、Agentがまだ送る途中のものとして数えない', () => {
    const db = quietAgent();
    for (let i = 0; i < 5; i += 1) routerSaw(db, '192.168.1.50', T + ROUTER_SETTLE_MS - i * 1000);
    assert.deepEqual(findSilentAgents(db, { now: T + 20 * MIN }), []);
  });

  it('届かなくなってから15分未満なら、まだ知らせない', () => {
    const db = quietAgent();
    for (const m of [3, 5, 7, 9]) routerSaw(db, '192.168.1.50', T + m * MIN);
    assert.deepEqual(findSilentAgents(db, { now: T + 14 * MIN }), []);
  });

  it('ルーターの接続が2件までなら知らせない', () => {
    const db = quietAgent();
    for (const m of [5, 9]) routerSaw(db, '192.168.1.50', T + m * MIN);
    assert.deepEqual(findSilentAgents(db, { now: T + 30 * MIN }), []);
  });

  it('ルーターが一度も見ていないアドレス（仮想インターフェースなど）は飛ばし、見ているアドレスで判定する', () => {
    const db = quietAgent();
    agentUsed(db, 'a1', '172.20.0.1', T - 10 * 1000);
    for (const m of [5, 9, 14]) routerSaw(db, '192.168.1.50', T + m * MIN);
    assert.equal(findSilentAgents(db, { now: T + 20 * MIN })[0]?.address, '192.168.1.50');
  });

  it('ブロードキャストアドレスや公開アドレスはAgentのアドレスとして使わない', () => {
    const db = database();
    delivered(db, 'a1', T);
    agentUsed(db, 'a1', '192.168.1.255', T - MIN);
    agentUsed(db, 'a1', '203.0.113.9', T - MIN);
    for (const src of ['192.168.1.255', '203.0.113.9']) {
      for (const m of [-60, 5, 9, 14]) routerSaw(db, src, T + m * MIN);
    }
    assert.deepEqual(findSilentAgents(db, { now: T + 20 * MIN }), []);
  });

  it('そのアドレスを後から別のAgentが使っていれば、その機械のものとして扱わない', () => {
    // 2026-11-02: one Agent had a single row from another computer's address.
    const db = quietAgent();
    delivered(db, 'a2', T + 25 * MIN);
    agentUsed(db, 'a2', '192.168.1.50', T + 25 * MIN);
    for (const m of [5, 9, 14]) routerSaw(db, '192.168.1.50', T + m * MIN);
    assert.deepEqual(findSilentAgents(db, { now: T + 30 * MIN }), []);
  });

  it('無効にしたAgentと、一度も届いていないAgentは見ない', () => {
    const db = quietAgent();
    db.exec("UPDATE agents SET revokedAt = 1 WHERE agentId = 'a1'");
    for (const m of [5, 9, 14]) routerSaw(db, '192.168.1.50', T + m * MIN);
    assert.deepEqual(findSilentAgents(db, { now: T + 20 * MIN }), []);
  });

  it('24時間より長く届いていないAgentは見ない（アドレスが別の機器に移っているかもしれない）', () => {
    const db = quietAgent();
    for (const m of [5, 9, 14]) routerSaw(db, '192.168.1.50', T + 25 * 60 * MIN + m * MIN);
    assert.deepEqual(findSilentAgents(db, { now: T + 25 * 60 * MIN + 20 * MIN }), []);
  });

  it('ルーターもAgentの表も無いHubでは何もしない', () => {
    const db = new Database(':memory:');
    assert.deepEqual(findSilentAgents(db, { now: T }), []);
  });
});

describe('Agent silence announcements', () => {
  it('1回の沈黙は最後に届いた時刻で決まり、また届いてから止まれば別の沈黙になる', () => {
    assert.equal(silenceKey({ agentId: 'a1', lastDeliveredAt: T }), silenceKey({ agentId: 'a1', lastDeliveredAt: T }));
    assert.notEqual(silenceKey({ agentId: 'a1', lastDeliveredAt: T }), silenceKey({ agentId: 'a1', lastDeliveredAt: T + MIN }));
  });

  it('再起動しても同じ沈黙を知らせ直さないよう、検出ログから知らせ済みを読み戻す', () => {
    const tag = JSON.stringify({ kind: 'agent-silent', agentId: 'a1', host: 'JAMESBOND', lastDeliveredAt: T, minutes: 17, routerConnections: 3 });
    assert.deepEqual(silenceKeysFromLog([
      { threatTag: tag },
      { threatTag: 'not json' },
      { threatTag: JSON.stringify({ kind: 'agent-silent' }) },
    ]), [silenceKey({ agentId: 'a1', lastDeliveredAt: T })]);
  });
});
