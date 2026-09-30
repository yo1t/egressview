'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  buildFilterConditions,
  buildWhereAndParams,
  escapeLikeValue,
  makeLikePat,
} = require('../../src/history-queries');

describe('history query helpers', () => {
  it('escapes LIKE wildcard characters and backslashes', () => {
    assert.equal(escapeLikeValue('a%b_c\\d'), 'a\\%b\\_c\\\\d');
  });

  it('creates LIKE patterns for every supported match mode', () => {
    assert.equal(makeLikePat('startsWith', 'host'), 'host%');
    assert.equal(makeLikePat('endsWith', 'host'), '%host');
    assert.equal(makeLikePat('contains', 'host'), '%host%');
  });

  it('uses exact matching for source addresses when requested', () => {
    assert.deepEqual(buildFilterConditions({ src: { mode: 'exact', value: '192.0.2.10' } }), {
      conditions: ['src = ?'],
      params: ['192.0.2.10'],
    });
  });

  it('builds destination and source-name filters with matching parameters', () => {
    const result = buildFilterConditions({
      src: { mode: 'contains', value: 'laptop' },
      dst: { mode: 'startsWith', value: 'example' },
      srcMac: { mode: 'exact', value: '02:00:00:00:00:01' },
    });
    assert.deepEqual(result.params, [
      '%laptop%', '%laptop%', '%laptop%',
      'example%', 'example%',
      '02:00:00:00:00:01',
    ]);
    assert.equal(result.conditions.length, 3);
  });

  it('prepends time bounds to filter conditions', () => {
    assert.deepEqual(
      buildWhereAndParams(100, 200, { conditions: ['proto = ?'], params: ['TCP'] }),
      {
        where: ' WHERE lastSeen >= ? AND lastSeen <= ? AND proto = ?',
        params: [100, 200, 'TCP'],
      }
    );
  });
});

describe('エージェントで絞った一覧の下ごしらえの共有（P3-184）', () => {
  const Database = require('better-sqlite3');
  const { createHistoryQueries, connectionSource } = require('../../src/history-queries');
  const minute = 60_000;
  const base = Date.parse('2026-10-01T00:00:00Z');

  function setup() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE connections (
        src TEXT, dst TEXT, dport INTEGER, proto TEXT, sport INTEGER, ttl INTEGER,
        srcMac TEXT, srcVendor TEXT, srcDnsName TEXT, srcMdnsName TEXT, dstHost TEXT,
        country TEXT, org TEXT, lat REAL, lon REAL, city TEXT,
        firstSeen INTEGER, lastSeen INTEGER, agentHost TEXT, process TEXT, pid INTEGER,
        PRIMARY KEY (src, dst, dport, proto)
      );
      CREATE TABLE agents (agentId TEXT PRIMARY KEY, hostName TEXT);
      CREATE TABLE agent_observations (
        agentId TEXT, observationId TEXT, networkProtocol TEXT,
        localAddress TEXT, localPort INTEGER, remoteAddress TEXT, remotePort INTEGER,
        processId INTEGER, processName TEXT, firstObservedAt INTEGER, lastObservedAt INTEGER,
        PRIMARY KEY (agentId, observationId)
      );
      CREATE TABLE connection_agent_observations (
        src TEXT, dst TEXT, dport INTEGER, proto TEXT, agentId TEXT, observationId TEXT
      );
      INSERT INTO agents VALUES ('agent-a', 'macbook');
    `);
    let clock = base;
    const queries = createHistoryQueries({
      getDb: () => db,
      getDbPath: () => ':memory:',
      Database,
      connectionReadColumns: alias => `${alias}.*`,
      hydrateConnectionRows: rows => rows,
      normalizeObservedBy: value => value,
      compatibilitySource: value => value,
      summarizeAppGroups: value => value,
      now: () => clock,
    });
    let seq = 0;
    const observe = (dst, at) => db.prepare(`INSERT INTO agent_observations VALUES
      ('agent-a', ?, 'udp', '192.0.2.30', 52000, ?, 443, 1, 'app', ?, ?)`).run(`o${++seq}`, dst, at - 1000, at);
    const tempTables = () => db.prepare(
      "SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name LIKE 'agent_only_flows_%'"
    ).all().map(row => row.name);
    return { db, queries, observe, tempTables, advance: ms => { clock += ms; }, now: () => clock };
  }
  const scope = { sourceKind: 'agent', sourceId: 'agent-a' };

  it('同じ分の中の要求は、まとめ直しを1回だけ行い、1回ずつ作った場合と同じ結果を返す', () => {
    const { db, queries, observe, tempTables } = setup();
    observe('203.0.113.1', base - 10 * minute);
    observe('203.0.113.2', base - 30 * minute);
    observe('203.0.113.2', base - 2 * minute);
    observe('203.0.113.3', base - 3 * 60 * minute);
    const from = base - 60 * minute + 1234;

    const groups = queries.groupDstByTimeRange(from, null, { sourceScope: scope });
    const count = queries.countByTimeRange(from + 20, null, { sourceScope: scope });
    assert.equal(tempTables().length, 1, '4つの要求でも一時表は1つ');

    const exact = connectionSource(scope, 'c', { from });
    const expected = db.prepare(
      `${exact.cte} SELECT dst, COUNT(*) AS cnt FROM ${exact.from} WHERE c.lastSeen >= ? GROUP BY dst`
    ).all(...exact.params, from);
    assert.deepEqual(
      groups.map(({ dst, cnt }) => ({ dst, cnt })).sort((a, b) => a.dst.localeCompare(b.dst)),
      expected.sort((a, b) => a.dst.localeCompare(b.dst)),
    );
    assert.deepEqual(new Set(groups.map(row => row.dst)), new Set(['203.0.113.1', '203.0.113.2']));
    assert.equal(count, 2);
    db.close();
  });

  it('1分を過ぎたら作り直し、その間に届いた観測も数える。古い表は消す', () => {
    const { db, queries, observe, tempTables, advance, now } = setup();
    observe('203.0.113.1', base - minute);
    const first = queries.countByTimeRange(now() - 60 * minute, null, { sourceScope: scope });
    assert.equal(first, 1);
    observe('203.0.113.9', base);
    assert.equal(queries.countByTimeRange(now() - 60 * minute, null, { sourceScope: scope }), 1,
      '1分以内は同じ表を使う');
    const before = tempTables();
    advance(minute);
    assert.equal(queries.countByTimeRange(now() - 60 * minute, null, { sourceScope: scope }), 2);
    const after = tempTables();
    assert.equal(after.length, 1);
    assert.notDeepEqual(after, before);
    db.close();
  });

  it('終わりの時刻がある要求は、共有せずにそのつど組み立てる', () => {
    const { db, queries, observe, tempTables } = setup();
    observe('203.0.113.1', base - minute);
    assert.equal(queries.countByTimeRange(base - 60 * minute, base, { sourceScope: scope }), 1);
    assert.deepEqual(tempTables(), []);
    db.close();
  });

  it('一時表は8つまで。古いものから消す', () => {
    const { db, queries, observe, tempTables } = setup();
    observe('203.0.113.1', base - minute);
    for (let i = 0; i < 10; i += 1) {
      queries.countByTimeRange(base - (i + 2) * minute, null, { sourceScope: scope });
    }
    assert.equal(tempTables().length, 8);
    db.close();
  });
});
