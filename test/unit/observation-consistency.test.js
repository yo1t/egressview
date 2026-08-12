'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const { checkObservationConsistency } = require('../../src/observation-consistency');

function makeDb({ source = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE connections (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT${source ? ', source TEXT' : ''},
      PRIMARY KEY (src, dst, dport, proto)
    );
    CREATE TABLE routers (id TEXT PRIMARY KEY, kind TEXT);
    CREATE TABLE connection_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, routerId TEXT,
      firstObservedAt INTEGER, lastObservedAt INTEGER,
      PRIMARY KEY (src, dst, dport, proto, routerId)
    );
  `);
  return db;
}

describe('observation consistency diagnostics', () => {
  it('reports a fully consistent Yamaha and Cisco observation', () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO routers VALUES ('yamaha1', 'yamaha'), ('cisco1', 'cisco');
      INSERT INTO connections VALUES ('10.0.0.1', '1.1.1.1', 443, 'TCP', 'yamaha+cisco');
      INSERT INTO connection_observations VALUES
        ('10.0.0.1', '1.1.1.1', 443, 'TCP', 'yamaha1', 1, 1),
        ('10.0.0.1', '1.1.1.1', 443, 'TCP', 'cisco1', 1, 1);
    `);
    assert.deepEqual(checkObservationConsistency(db, 123), {
      missingObservations: 0,
      orphanObservations: 0,
      underMerged: 0,
      kindMismatches: 0,
      checkedAt: 123,
    });
    db.close();
  });

  it('agentだけが観測した接続をmissing扱いにしない', () => {
    // An agent has no router identity and deliberately records no router
    // observation. Counting those as missing raised an ERROR on every start
    // for a database that was correct, and the deploy gate counts ERRORs.
    const db = makeDb();
    db.exec(`
      CREATE TABLE agent_observations (
        agentId TEXT, localAddress TEXT, remoteAddress TEXT, remotePort INTEGER,
        networkProtocol TEXT
      );
      INSERT INTO connections VALUES ('10.0.0.9', '203.0.113.5', 443, 'tcp', 'agent');
      INSERT INTO agent_observations VALUES ('agent-1', '10.0.0.9', '203.0.113.5', 443, 'TCP');
    `);
    assert.equal(checkObservationConsistency(db, 1).missingObservations, 0);
    db.close();
  });

  it('agentも routerも観測していない接続は依然としてmissingになる', () => {
    // The check still has to catch a connection nothing accounts for.
    const db = makeDb();
    db.exec(`
      CREATE TABLE agent_observations (
        agentId TEXT, localAddress TEXT, remoteAddress TEXT, remotePort INTEGER,
        networkProtocol TEXT
      );
      INSERT INTO connections VALUES ('10.0.0.9', '203.0.113.5', 443, 'tcp', 'yamaha');
    `);
    assert.equal(checkObservationConsistency(db, 1).missingObservations, 1);
    db.close();
  });

  it('detects two observations of the wrong router kinds', () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO routers VALUES ('yamaha1', 'yamaha'), ('yamaha2', 'yamaha');
      INSERT INTO connections VALUES ('10.0.0.1', '1.1.1.1', 443, 'TCP', 'yamaha+cisco');
      INSERT INTO connection_observations VALUES
        ('10.0.0.1', '1.1.1.1', 443, 'TCP', 'yamaha1', 1, 1),
        ('10.0.0.1', '1.1.1.1', 443, 'TCP', 'yamaha2', 1, 1);
    `);
    const result = checkObservationConsistency(db);
    assert.equal(result.missingObservations, 0);
    assert.equal(result.underMerged, 0);
    assert.equal(result.kindMismatches, 1);
    db.close();
  });

  it('validates v5 junction invariants without a source column', () => {
    const db = makeDb({ source: false });
    db.exec(`
      INSERT INTO routers VALUES ('yamaha1', 'yamaha');
      INSERT INTO connections VALUES ('10.0.0.1', '1.1.1.1', 443, 'TCP');
      INSERT INTO connection_observations VALUES
        ('10.0.0.1', '1.1.1.1', 443, 'TCP', 'yamaha1', 1, 1);
    `);
    assert.deepEqual(checkObservationConsistency(db, 456), {
      missingObservations: 0,
      orphanObservations: 0,
      underMerged: 0,
      kindMismatches: 0,
      checkedAt: 456,
    });
    db.close();
  });

  it('detects v5 missing, orphaned, and unregistered-router observations', () => {
    const db = makeDb({ source: false });
    db.exec(`
      INSERT INTO connections VALUES ('10.0.0.1', '1.1.1.1', 443, 'TCP');
      INSERT INTO connection_observations VALUES
        ('10.0.0.2', '9.9.9.9', 53, 'UDP', 'missing-router', 1, 1);
    `);
    const result = checkObservationConsistency(db);
    assert.equal(result.missingObservations, 1);
    assert.equal(result.orphanObservations, 1);
    assert.equal(result.underMerged, 0);
    assert.equal(result.kindMismatches, 1);
    db.close();
  });
});
