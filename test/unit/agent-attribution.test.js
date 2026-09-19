'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAgentAttribution } = require('../../src/agent-attribution');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (agentId TEXT PRIMARY KEY, hostName TEXT NOT NULL);
    CREATE TABLE agent_observations (
      agentId TEXT, observationId TEXT, processId INTEGER, processName TEXT,
      bundleId TEXT, firstObservedAt INTEGER, lastObservedAt INTEGER,
      bytesIn TEXT, bytesOut TEXT, localAddress TEXT, remoteAddress TEXT,
      remotePort INTEGER, networkProtocol TEXT,
      PRIMARY KEY (agentId, observationId)
    );
    CREATE TABLE connection_agent_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, agentId TEXT,
      observationId TEXT, matchKind TEXT
    );
    -- attach() names this index to keep the planner from entering the join by
    -- agentId, so the query does not even prepare without it.
    CREATE INDEX idx_connection_agent_connection
      ON connection_agent_observations(src, dst, dport, proto);
    INSERT INTO agents VALUES ('agent-a', 'macbook');
  `);
  const observation = db.prepare(`
    INSERT INTO agent_observations VALUES (
      'agent-a', ?, ?, ?, ?, 1000, 2000, ?, ?,
      '192.0.2.10', '198.51.100.10', 443, 'tcp'
    )
  `);
  const link = db.prepare(`
    INSERT INTO connection_agent_observations VALUES (
      '192.0.2.10', '198.51.100.10', 443, 'TCP', 'agent-a', ?, 'exact-5tuple'
    )
  `);
  return { db, observation, link };
}

describe('Agent application attribution join order', () => {
  // The connection log went from unusable to instant on this one line, so it is
  // worth pinning.
  //
  // Scoping to one agent adds an equality on o.agentId, and that alone flipped
  // the planner into entering through link's (agentId, observationId) index:
  // every correlation that agent ever recorded -- 1.46M rows on the Hub -- with
  // the page's 200 constant rows rescanned for each. Measured there: 34,651ms
  // that way, 15ms entering by the address tuple, identical 475 rows out.
  //
  // This asserts the statement asks for that index, not that a plan came out
  // right. Checking the plan here would prove nothing: on a fixture this size
  // SQLite picks the good order with or without the hint, so such a test passes
  // while the hint is missing -- verified by deleting it and watching the plan
  // assertion still pass. Only production-scale statistics reproduce the bad
  // choice, and the hint is what makes the choice not matter.
  it('asks for the address-tuple index so the planner cannot enter by agentId', () => {
    const { db, observation, link } = fixture();
    observation.run('safari-1', 10, 'Safari', 'com.apple.Safari', '1', '2');
    link.run('safari-1');

    const prepared = [];
    const realPrepare = db.prepare.bind(db);
    const attribution = createAgentAttribution({
      getDb: () => ({ prepare: (sql) => { prepared.push(sql); return realPrepare(sql); } }),
    });
    const [row] = attribution.attach([{
      src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
      firstSeen: 1000, lastSeen: 2000, observedBy: ['router-a'],
    }], { sourceScope: { sourceKind: 'agent', sourceId: 'agent-a' } });

    assert.equal(prepared.length, 1);
    assert.match(
      prepared[0],
      /connection_agent_observations AS link\s+INDEXED BY idx_connection_agent_connection/,
      'the correlation join must name the address-tuple index'
    );
    // The hint must not change the answer, only the route to it.
    assert.equal(row.applicationCount, 1);
    assert.equal(row.applications[0].processName, 'Safari');
    db.close();
  });
});

describe('Agent-only 行の枝', () => {
  // The agent-only rows used to ride in the same CTE, picked out by an
  // `r.agentOnly = 1` condition inside the join. SQLite answered that by
  // scanning agent_observations -- 1,536,341 rows on the Hub this was measured
  // against -- and checking the 200 constant rows afterwards. It cost 3,759 ms
  // per page of the connection log to return nothing, because on a typical page
  // nothing is agent-only, and 31,461 ms when everything was. An index hint did
  // not move it. Passing only the qualifying rows did: 0.5 ms for 4 of 200.
  function prepareSpy(db) {
    const prepared = [];
    const realPrepare = db.prepare.bind(db);
    return {
      prepared,
      getDb: () => ({ prepare: (sql) => { prepared.push(sql); return realPrepare(sql); } }),
    };
  }

  it('router が見た行しかないページでは、その枝を作らない', () => {
    const { db, observation, link } = fixture();
    observation.run('safari-1', 10, 'Safari', 'com.apple.Safari', '1', '2');
    link.run('safari-1');
    const spy = prepareSpy(db);

    createAgentAttribution({ getDb: spy.getDb }).attach([{
      src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
      firstSeen: 1000, lastSeen: 2000, observedBy: ['router-a'],
    }]);

    assert.equal(spy.prepared.length, 1);
    assert.doesNotMatch(spy.prepared[0], /agentOnlyRows/,
      'agent-only の行が無いのに枝を作っている');
    assert.doesNotMatch(spy.prepared[0], /agent-only/,
      'agent-only の枝そのものを外していない');
    db.close();
  });

  it('agent-only の行だけを、専用のCTEに渡す', () => {
    const { db, observation } = fixture();
    observation.run('solo-1', 11, 'Mail', 'com.apple.mail', '3', '4');
    const spy = prepareSpy(db);

    const rows = createAgentAttribution({ getDb: spy.getDb }).attach([
      { src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
        firstSeen: 1000, lastSeen: 2000, observedBy: [] },
      { src: '192.0.2.99', dst: '198.51.100.99', dport: 80, proto: 'TCP',
        firstSeen: 1000, lastSeen: 2000, observedBy: ['router-a'] },
    ]);

    assert.match(spy.prepared[0], /agentOnlyRows\(rowIndex, src, dst, dport, proto, firstSeen, lastSeen\)/);
    // One row qualifies, so the branch carries one tuple while `requested`
    // carries both. Counting the placeholders is what proves the filtering
    // happened before SQLite saw the rows.
    const sql = spy.prepared[0];
    const cte = sql.slice(sql.indexOf('agentOnlyRows('), sql.indexOf(', attributions AS'));
    const tuples = cte.match(/\(\?, \?, \?, \?, \?, \?, \?\)/g) || [];
    assert.equal(tuples.length, 1, `渡した組数が合わない: ${tuples.length}\n${cte}`);
    const all = sql.match(/\(\?, \?, \?, \?, \?, \?, \?\)/g) || [];
    assert.equal(all.length, 3, 'requested に2行、agent-only に1行のはず');
    // And the answer is still the agent-only attribution.
    assert.equal(rows[0].applications[0].processName, 'Mail');
    assert.equal(rows[0].applications[0].matchKind, 'agent-only');
    db.close();
  });

  it('router が見ていない行を、取りこぼさない', () => {
    const { db, observation } = fixture();
    observation.run('solo-1', 11, 'Mail', 'com.apple.mail', '3', '4');
    const attribution = createAgentAttribution({ getDb: () => db });

    const rows = attribution.attach([{
      src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
      firstSeen: 1000, lastSeen: 2000, observedBy: [],
    }]);

    assert.equal(rows[0].applicationCount, 1);
    assert.equal(rows[0].applications[0].processName, 'Mail');
    db.close();
  });
});

describe('Agent application byte attribution', () => {
  it('adds decimal uint64 values without Number precision loss or replay duplication', () => {
    const { db, observation, link } = fixture();
    observation.run('safari-1', 10, 'Safari', 'com.apple.Safari', '18446744073709551615', '20');
    observation.run('safari-2', 11, 'Safari', 'com.apple.Safari', '1', '22');
    link.run('safari-1');
    link.run('safari-2');

    const attribution = createAgentAttribution({ getDb: () => db });
    const [row] = attribution.attach([{
      src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
      firstSeen: 1000, lastSeen: 2000, observedBy: ['router-a'],
    }]);

    assert.equal(row.applicationCount, 1);
    assert.deepEqual(row.applications[0].processIds, [10, 11]);
    assert.equal(row.applications[0].bytesIn, '18446744073709551616');
    assert.equal(row.applications[0].bytesOut, '42');
    assert.equal(row.applications[0].byteObservationCount, 2);
    assert.equal(row.applications[0].byteCompleteness, 'complete');
    db.close();
  });

  it('marks known one-direction values partial and missing values unavailable', () => {
    const { db, observation, link } = fixture();
    observation.run('slack', 20, 'Slack', 'com.tinyspeck.slackmacgap', '512', null);
    observation.run('unknown', 30, 'Legacy App', null, null, null);
    link.run('slack');
    link.run('unknown');

    const attribution = createAgentAttribution({ getDb: () => db });
    const [row] = attribution.attach([{
      src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
      firstSeen: 1000, lastSeen: 2000, observedBy: ['router-a'],
    }]);
    const slack = row.applications.find(app => app.processName === 'Slack');
    const unavailable = row.applications.find(app => app.processName === 'Legacy App');

    assert.equal(slack.bytesIn, '512');
    assert.equal(slack.bytesOut, null);
    assert.equal(slack.byteCompleteness, 'partial');
    assert.equal(unavailable.bytesIn, null);
    assert.equal(unavailable.bytesOut, null);
    assert.equal(unavailable.byteCompleteness, 'unavailable');
    db.close();
  });
});
