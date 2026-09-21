'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createAgentAppDaily, DAY_MS } = require('../../src/agent-app-daily');

// P3-150. The summary grouped every hourly row in range down to one row per
// flow per app, which SQLite answers with a temporary B-tree: 113 ms to read
// 674,231 rows on a Hub and 1,275 ms to group them. Rolled up by day the set of
// distinct flow-and-app pairs is the same and there is a quarter as much of it.
let db;
let clock;
let daily;

function seedHour(hourStart, rows) {
  const insert = db.prepare(`INSERT INTO agent_app_hourly
    (hourStart, agentId, appIdentity, processName, localAddress, remoteAddress,
     remotePort, networkProtocol, firstObservedAt, lastObservedAt)
    VALUES (?, 'agent-1', ?, ?, ?, ?, ?, 'tcp', ?, ?)
    ON CONFLICT DO UPDATE SET lastObservedAt = excluded.lastObservedAt`);
  for (const r of rows) {
    insert.run(hourStart, r.app, r.app, r.local, r.remote, r.port,
      r.from ?? hourStart, r.to ?? hourStart + 60_000);
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_app_hourly (
      hourStart INTEGER NOT NULL, agentId TEXT NOT NULL, appIdentity TEXT NOT NULL,
      processName TEXT NOT NULL, localAddress TEXT NOT NULL, remoteAddress TEXT NOT NULL,
      remotePort INTEGER NOT NULL, networkProtocol TEXT NOT NULL,
      firstObservedAt INTEGER NOT NULL, lastObservedAt INTEGER NOT NULL,
      PRIMARY KEY (hourStart, agentId, appIdentity, localAddress, remoteAddress, remotePort, networkProtocol)
    ) WITHOUT ROWID;
    CREATE TABLE agent_app_daily (
      dayStart INTEGER NOT NULL, agentId TEXT NOT NULL, appIdentity TEXT NOT NULL,
      processName TEXT NOT NULL, localAddress TEXT NOT NULL, remoteAddress TEXT NOT NULL,
      remotePort INTEGER NOT NULL, networkProtocol TEXT NOT NULL,
      firstObservedAt INTEGER NOT NULL, lastObservedAt INTEGER NOT NULL,
      PRIMARY KEY (dayStart, agentId, appIdentity, localAddress, remoteAddress, remotePort, networkProtocol)
    ) WITHOUT ROWID;
  `);
  clock = 0;
  daily = createAgentAppDaily({ getDb: () => db, now: () => clock, logger: { info() {}, warn() {}, debug() {} } });
});

const day = (n) => n * DAY_MS;
const hour = (d, h) => day(d) + h * 3_600_000;

describe('アプリ帰属を日ごとに畳む（P3-150）', () => {
  it('同じフローが何時間に出ても、その日の1行になる', () => {
    // This is the whole point: the count the summary reports is the number of
    // distinct flow-and-app pairs, and collapsing hours does not change it.
    for (const h of [1, 5, 9, 13, 20]) {
      seedHour(hour(3, h), [{ app: 'Firefox', local: '10.0.0.1', remote: '203.0.113.1', port: 443 }]);
    }
    clock = day(4) + 3_600_000;
    daily.fold({ daysPerTick: 10 });

    const rows = db.prepare('SELECT * FROM agent_app_daily WHERE dayStart = ?').all(day(3));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].firstObservedAt, hour(3, 1));
    assert.equal(rows[0].lastObservedAt, hour(3, 20) + 60_000);
  });

  it('別のフローや別のアプリは分けて数える', () => {
    seedHour(hour(2, 4), [
      { app: 'Firefox', local: '10.0.0.1', remote: '203.0.113.1', port: 443 },
      { app: 'Firefox', local: '10.0.0.1', remote: '203.0.113.9', port: 443 },
      { app: 'Mail', local: '10.0.0.1', remote: '203.0.113.1', port: 443 },
    ]);
    clock = day(3);
    daily.fold({ daysPerTick: 10 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_app_daily').get().n, 3);
  });

  it('今日は毎回畳み直す。まだ増えているので', () => {
    // A long view that stopped at midnight would answer for everything except
    // the part someone is most likely looking at.
    seedHour(hour(5, 1), [{ app: 'Firefox', local: '10.0.0.1', remote: '203.0.113.1', port: 443 }]);
    clock = hour(5, 2);
    daily.fold({ daysPerTick: 10 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_app_daily WHERE dayStart = ?').get(day(5)).n, 1);

    seedHour(hour(5, 3), [{ app: 'Mail', local: '10.0.0.1', remote: '203.0.113.1', port: 443 }]);
    clock = hour(5, 4);
    daily.fold({ daysPerTick: 10 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_app_daily WHERE dayStart = ?').get(day(5)).n, 2,
      'その日のうちに届いた分が入らなければならない');
  });

  it('1ティックで畳むのは1日だけ', () => {
    // A day is about 85,000 hourly rows on a real Hub and takes a quarter of a
    // second. Several at once is the mistake P3-139 was fought over.
    for (const d of [1, 2, 3, 4]) {
      seedHour(hour(d, 1), [{ app: 'Firefox', local: '10.0.0.1', remote: '203.0.113.1', port: 443 }]);
    }
    clock = day(5);
    const first = daily.fold();
    assert.equal(first.folded, 1);
    assert.equal(first.pending > 0, true, '残りは次のティックに回す');
  });

  it('長い期間に切り替えても、答えは同じ', () => {
    // The reason this table is allowed to exist. Measured on a Hub, fourteen
    // days read 354 applications with the same counts from either table, in
    // 1,609 ms from the hourly rows and 343 ms from these.
    const flows = [];
    for (let f = 0; f < 40; f += 1) {
      flows.push({
        app: `App${f % 7}`,
        local: `10.0.0.${f % 5}`,
        remote: `203.0.113.${f % 11}`,
        port: 443 + (f % 3),
      });
    }
    // Every flow seen in several hours across several days.
    for (let d = 1; d <= 4; d += 1) {
      for (const h of [2, 7, 15]) seedHour(hour(d, h), flows);
    }
    clock = day(5);
    daily.fold({ daysPerTick: 10 });

    const group = (table, column, from, to) => db.prepare(
      `SELECT app, COUNT(*) AS count FROM (
         SELECT localAddress, remoteAddress, remotePort, UPPER(networkProtocol) AS proto,
                agentId, appIdentity, MAX(processName) AS app
         FROM ${table} h
         WHERE h.${column} >= ? AND h.${column} <= ? AND h.lastObservedAt >= ? AND h.firstObservedAt <= ?
         GROUP BY localAddress, remoteAddress, remotePort, UPPER(networkProtocol), agentId, appIdentity
       ) GROUP BY app ORDER BY app`
    ).all(from, to, day(1), day(5));

    assert.deepEqual(
      group('agent_app_daily', 'dayStart', day(1), day(4)),
      group('agent_app_hourly', 'hourStart', day(1), hour(4, 23)),
      '日次に切り替えたら別の答えになった'
    );
  });

  it('過ぎた日は捨てる', () => {
    seedHour(hour(1, 1), [{ app: 'Firefox', local: '10.0.0.1', remote: '203.0.113.1', port: 443 }]);
    clock = day(2);
    daily.fold({ daysPerTick: 10 });
    clock = day(10);
    assert.equal(daily.prune({ retentionMs: 7 * DAY_MS }), 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_app_daily').get().n, 0);
  });
});
