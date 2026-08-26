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
