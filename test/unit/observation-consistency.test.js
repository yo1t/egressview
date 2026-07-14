'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const { checkObservationConsistency } = require('../../src/observation-consistency');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE connections (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, source TEXT,
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
});
