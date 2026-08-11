'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../../src/agent-ingest-store');

const golden = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../protocol/agent-ingest/v1/golden.json'),
  'utf8'
));
const agentId = '00000000-0000-4000-8000-000000000001';
const receivedAt = Date.parse('2026-08-11T12:00:01Z');

function copy(value = golden) {
  return structuredClone(value);
}

beforeEach(() => store._initForTest());
after(() => store.closeDb());

describe('Agent ingest store', () => {
  it('stores one batch atomically and preserves uint64 byte counts as text', () => {
    const ack = store.storeBatch(agentId, copy(), { receivedAt });
    assert.deepEqual(ack, {
      batchId: golden.batchId,
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      receivedAt,
      replayed: false,
    });
    const row = store._dbForTest().prepare('SELECT * FROM agent_observations').get();
    assert.equal(row.agentId, agentId);
    assert.equal(row.processId, 42);
    assert.equal(row.bytesIn, '9007199254740993');
    assert.equal(row.bytesOut, null);
  });

  it('returns the original ACK for 100 retries without duplicating storage', () => {
    const first = store.storeBatch(agentId, copy(), { receivedAt });
    for (let index = 0; index < 100; index += 1) {
      const replay = store.storeBatch(agentId, copy(), { receivedAt: receivedAt + index + 1 });
      assert.deepEqual(replay, { ...first, replayed: true });
    }
    const database = store._dbForTest();
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);
  });

  it('counts an observation reused by a different batch as a duplicate', () => {
    store.storeBatch(agentId, copy(), { receivedAt });
    const second = copy();
    second.batchId = '00000000-0000-4000-8000-000000000099';
    const ack = store.storeBatch(agentId, second, { receivedAt: receivedAt + 1 });
    assert.equal(ack.accepted, 0);
    assert.equal(ack.duplicate, 1);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);
  });

  it('keeps the same observationId independent across Agents', () => {
    store.storeBatch(agentId, copy(), { receivedAt });
    const otherAgent = '00000000-0000-4000-8000-000000000002';
    const ack = store.storeBatch(otherAgent, copy(), { receivedAt });
    assert.equal(ack.accepted, 1);
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 2);
  });

  it('rolls back the whole batch when any observation cannot be stored', () => {
    const database = store._dbForTest();
    database.exec(`
      CREATE TRIGGER reject_test_observation
      BEFORE INSERT ON agent_observations
      WHEN NEW.processName = 'RejectThisObservation'
      BEGIN SELECT RAISE(ABORT, 'test rejection'); END;
    `);
    const envelope = copy();
    envelope.observations.push({
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000088',
      processName: 'RejectThisObservation',
    });
    assert.throws(
      () => store.storeBatch(agentId, envelope, { receivedAt }),
      /test rejection/
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_ingest_batches').get().n, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
  });

  it('keeps an accepted batch durable when derived correlation is temporarily unavailable', () => {
    const database = store._dbForTest();
    database.exec('DROP TABLE connection_agent_observations');

    const ack = store.storeBatch(agentId, copy(), { receivedAt });

    assert.equal(ack.accepted, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);
  });

  it('prunes expired originals and their orphaned batch receipts', () => {
    store.storeBatch(agentId, copy(), { receivedAt });
    const result = store.pruneObservations({ before: receivedAt + 1 });
    assert.deepEqual(result, { correlations: 0, observations: 1, batches: 1 });
    assert.equal(store._dbForTest().prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
  });
});
