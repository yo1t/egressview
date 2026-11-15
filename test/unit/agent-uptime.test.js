'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { listUptime, SLOT_MS } = require('../../src/agent-uptime');

const MIN = 60 * 1000;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_ingest_batches (agentId TEXT, batchId TEXT, receivedAt INTEGER);
    CREATE TABLE notification_log (id INTEGER PRIMARY KEY, type TEXT, threatTag TEXT);
  `);
  return db;
}

function deliver(db, agentId, times) {
  const insert = db.prepare('INSERT INTO agent_ingest_batches (agentId, batchId, receivedAt) VALUES (?, ?, ?)');
  times.forEach((at, index) => insert.run(agentId, `b${index}`, at));
}

describe('agent uptime', () => {
  // A round slot boundary keeps the slot arithmetic easy to read.
  const now = 1000 * SLOT_MS;
  const since = now - 24 * 60 * MIN;

  it('5分の区切りのうち届いた数と、15分以上の途切れを長い順に返す。検出された止まりは印を付ける', () => {
    const db = makeDb();
    const times = [];
    for (let at = since; at <= now; at += MIN) {
      // Quiet from 2h to 5h (a closed laptop) and from 10h to 10h30 (the Agent stopped).
      if (at > since + 120 * MIN && at < since + 300 * MIN) continue;
      if (at > since + 600 * MIN && at < since + 630 * MIN) continue;
      times.push(at);
    }
    deliver(db, 'a', times);
    db.prepare("INSERT INTO notification_log (type, threatTag) VALUES ('agent_silent', ?)")
      .run(JSON.stringify({ agentId: 'a', lastDeliveredAt: since + 600 * MIN }));

    const [report] = listUptime(db, { agents: [{ agentId: 'a', createdAt: 0 }], since, now });
    assert.equal(report.from, since);
    assert.equal(report.totalSlots, 24 * 12 + 1);
    // 180 + 30 minutes without a delivery leave 35 + 5 slots empty.
    assert.equal(report.deliveredSlots, report.totalSlots - 35 - 5);
    assert.equal(report.gapCount, 2);
    assert.equal(report.gapMinutes, 180 + 30);
    assert.deepEqual(report.gaps.map(gap => [gap.minutes, gap.agentStopped, gap.ongoing]), [
      [180, false, false],
      [30, true, false],
    ]);
  });

  it('登録が期間より後なら登録時刻から数え、何も届いていないAgentは期間全体を続いている途切れにする', () => {
    const db = makeDb();
    const createdAt = now - 60 * MIN;
    const [report] = listUptime(db, { agents: [{ agentId: 'b', createdAt }], since, now });
    assert.equal(report.from, createdAt);
    assert.equal(report.totalSlots, 13);
    assert.equal(report.deliveredSlots, 0);
    assert.deepEqual(report.gaps, [{ startAt: createdAt, endAt: now, minutes: 60, ongoing: true, agentStopped: false }]);
  });

  it('最後に届いてから15分以上たっていれば、今も続いている途切れとして返す。届いた区切りは全体を超えない', () => {
    const db = makeDb();
    deliver(db, 'c', [since, since + 1, now - 40 * MIN]);
    const [report] = listUptime(db, { agents: [{ agentId: 'c', createdAt: 0 }], since, now });
    assert.ok(report.deliveredSlots <= report.totalSlots);
    assert.equal(report.gaps[0].ongoing, false);
    assert.deepEqual(report.gaps.find(gap => gap.ongoing), {
      startAt: now - 40 * MIN, endAt: now, minutes: 40, ongoing: true, agentStopped: false,
    });
  });
});
