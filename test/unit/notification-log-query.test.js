'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createNotificationLogQuery } = require('../../src/notification-log-query');

// The tables and indexes the query reads, as the Hub has them.
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE notification_log (
      id INTEGER PRIMARY KEY, type TEXT, src TEXT, dst TEXT, dport INTEGER, proto TEXT, detectedAt INTEGER
    );
    CREATE INDEX idx_nlog_detectedAt ON notification_log(detectedAt);
    CREATE TABLE connections (src TEXT, dst TEXT, dport INTEGER, proto TEXT, PRIMARY KEY (src, dst, dport, proto));
    CREATE INDEX idx_src ON connections(src);
    CREATE TABLE connection_observations (
      src TEXT NOT NULL, dst TEXT NOT NULL, dport INTEGER NOT NULL, proto TEXT NOT NULL, routerId TEXT NOT NULL,
      PRIMARY KEY (src, dst, dport, proto, routerId)
    );
    CREATE INDEX idx_obs_router ON connection_observations(routerId);
    CREATE TABLE agent_observations (
      agentId TEXT, observationId TEXT, localAddress TEXT, remoteAddress TEXT, remotePort INTEGER,
      networkProtocol TEXT, lastObservedAt INTEGER, PRIMARY KEY (agentId, observationId)
    );
    CREATE INDEX idx_agent_observations_agent_flow ON agent_observations(agentId, localAddress, remoteAddress, remotePort);
    CREATE INDEX idx_agent_observations_time ON agent_observations(agentId, lastObservedAt);
  `);
  const conn = db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)');
  const obs = db.prepare('INSERT INTO connection_observations VALUES (?, ?, ?, ?, ?)');
  const agent = db.prepare('INSERT INTO agent_observations VALUES (?, ?, ?, ?, ?, ?, 0)');
  const note = db.prepare('INSERT INTO notification_log (type, src, dst, dport, proto, detectedAt) VALUES (?, ?, ?, ?, ?, ?)');
  const flows = [
    ['192.0.2.10', '198.51.100.1', 443, 'TCP', 'yamaha1'],
    ['192.0.2.10', '198.51.100.2', 53, 'UDP', 'cisco1'],
    ['192.0.2.11', '198.51.100.1', 443, 'TCP', 'cisco1'],
    ['192.0.2.12', '198.51.100.3', 80, 'TCP', 'yamaha1'],
  ];
  for (const [src, dst, dport, proto, routerId] of flows) {
    conn.run(src, dst, dport, proto);
    obs.run(src, dst, dport, proto, routerId);
  }
  agent.run('mac-a', 'o1', '192.0.2.10', '198.51.100.1', 443, 'tcp');
  agent.run('mac-a', 'o2', '192.0.2.12', '198.51.100.9', 8443, 'udp');
  agent.run('mac-b', 'o3', '192.0.2.11', '198.51.100.1', 443, 'tcp');
  // Every shape a notification can take: full key, a key with no match, a
  // protocol in another case, and the parts a notification may lack.
  const notes = [
    ['threat', '192.0.2.10', '198.51.100.1', 443, 'TCP'],
    ['threat', '192.0.2.10', '198.51.100.1', 443, 'tcp'],
    ['threat', '192.0.2.10', '198.51.100.2', 53, 'UDP'],
    ['threat', '192.0.2.10', '198.51.100.2', 53, 'TCP'],
    ['threat', '192.0.2.11', '198.51.100.1', 443, null],
    ['threat', '192.0.2.12', '198.51.100.3', 81, 'TCP'],
    ['threat', '192.0.2.12', '198.51.100.9', 8443, 'UDP'],
    ['new_device', '192.0.2.10', null, null, null],
    ['new_device', '192.0.2.12', null, null, null],
    ['threat', '192.0.2.11', '198.51.100.1', null, 'TCP'],
    ['threat', '192.0.2.10', null, 53, null],
    ['threat', '192.0.2.99', '198.51.100.1', 443, 'TCP'],
  ];
  notes.forEach((row, index) => note.run(...row, 1000 + index));
  return db;
}

// The query as it was before P3-184 split it: one condition, every part
// optional. The rewrite has to return exactly what this returned.
function original(db, from, to, sourceScope) {
  const conditions = [];
  const params = [];
  if (from != null) { conditions.push('detectedAt >= ?'); params.push(from); }
  if (to != null) { conditions.push('detectedAt <= ?'); params.push(to); }
  if (sourceScope.sourceKind === 'router') {
    conditions.push(`EXISTS (
      SELECT 1 FROM connections c
      JOIN connection_observations o
        ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
      WHERE c.src = notification_log.src
        AND (notification_log.dst IS NULL OR c.dst = notification_log.dst)
        AND (notification_log.dport IS NULL OR c.dport = notification_log.dport)
        AND (notification_log.proto IS NULL OR LOWER(c.proto) = LOWER(notification_log.proto))
        AND o.routerId = ?)`);
  } else {
    conditions.push(`EXISTS (
      SELECT 1 FROM agent_observations o
      WHERE o.agentId = ? AND o.localAddress = notification_log.src
        AND (notification_log.dst IS NULL OR o.remoteAddress = notification_log.dst)
        AND (notification_log.dport IS NULL OR o.remotePort = notification_log.dport)
        AND (notification_log.proto IS NULL OR LOWER(o.networkProtocol) = LOWER(notification_log.proto)))`);
  }
  params.push(sourceScope.sourceId);
  return db.prepare(`SELECT * FROM notification_log WHERE ${conditions.join(' AND ')}
    ORDER BY detectedAt DESC LIMIT 2000`).all(...params);
}

describe('notification log query (P3-184)', () => {
  const scopes = [
    { sourceKind: 'router', sourceId: 'yamaha1' },
    { sourceKind: 'router', sourceId: 'cisco1' },
    { sourceKind: 'router', sourceId: 'nobody' },
    { sourceKind: 'agent', sourceId: 'mac-a' },
    { sourceKind: 'agent', sourceId: 'mac-b' },
    { sourceKind: 'agent', sourceId: 'nobody' },
  ];

  it('絞り込みの結果は、分ける前の書き方と同じ', () => {
    const db = fixture();
    const query = createNotificationLogQuery({ getDb: () => db });
    let matched = 0;
    for (const scope of scopes) {
      for (const [from, to] of [[null, null], [1003, null], [null, 1008], [1002, 1009]]) {
        const rows = query(from, to, { sourceScope: scope });
        assert.deepEqual(rows, original(db, from, to, scope), `${scope.sourceKind} ${scope.sourceId} ${from}-${to}`);
        matched += rows.length;
      }
    }
    assert.ok(matched > 0, 'the fixture matches something, so the comparison is not of two empty lists');
  });

  it('宛先とポートのある通知は、宛先まで索引で引く', () => {
    const db = fixture();
    let sql;
    let params;
    const spy = { prepare(text) { sql = text; return { all: (...args) => { params = args; return []; } }; } };
    const query = createNotificationLogQuery({ getDb: () => spy });

    query(null, null, { sourceScope: { sourceKind: 'agent', sourceId: 'mac-a' } });
    const agentPlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail);
    assert.ok(agentPlan.some(detail => /idx_agent_observations_agent_flow \(agentId=\? AND localAddress=\? AND remoteAddress=\? AND remotePort=\?\)/.test(detail)),
      agentPlan.join('\n'));

    query(null, null, { sourceScope: { sourceKind: 'router', sourceId: 'cisco1' } });
    const routerPlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail);
    assert.ok(routerPlan.some(detail => /SEARCH c USING .*\(src=\? AND dst=\? AND dport=\?/.test(detail)), routerPlan.join('\n'));
  });
});
