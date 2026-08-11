'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../../src/agent-ingest-store');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../protocol/agent-ingest/v1/golden.json'),
  'utf8'
));
const agentId = '00000000-0000-4000-8000-000000000001';
const observedAt = Date.parse('2026-08-11T12:00:00Z');

function copy() {
  return structuredClone(fixture);
}

function addAgent(database, id = agentId) {
  database.prepare(`
    INSERT INTO agents (
      agentId, platform, hostName, osVersion, agentVersion, tokenHash,
      createdAt, updatedAt, lastSeenAt, revokedAt
    ) VALUES (?, 'macos', 'macbook-air', '26.5.2', '0.1.13', ?, ?, ?, NULL, NULL)
  `).run(id, `hash-${id}`, observedAt, observedAt);
}

function addConnection(database, overrides = {}) {
  database.prepare(`
    INSERT INTO connections (src, dst, dport, proto, sport, firstSeen, lastSeen)
    VALUES (@src, @dst, @dport, @proto, @sport, @firstSeen, @lastSeen)
  `).run({
    src: '192.0.2.10',
    dst: '198.51.100.20',
    dport: 443,
    proto: 'TCP',
    sport: 49152,
    firstSeen: observedAt - 2_000,
    lastSeen: observedAt,
    ...overrides,
  });
}

beforeEach(() => {
  store._initForTest();
  addAgent(store._dbForTest());
});
after(() => store.closeDb());

describe('Agent/router correlation read model', () => {
  it('links an exact five-tuple with overlapping time and exposes router-backed metadata', () => {
    const database = store._dbForTest();
    addConnection(database);

    store.storeBatch(agentId, copy(), { receivedAt: observedAt + 1_000 });

    const link = database.prepare('SELECT * FROM connection_agent_observations').get();
    assert.equal(link.matchKind, 'exact-5tuple');
    assert.equal(link.timeDeltaMs, 0);
    assert.deepEqual(store.getCorrelationDiagnostics(), {
      observations: 1,
      correlated: 1,
      exact: 1,
      uniqueMatch: 0,
      ambiguous: 0,
      unmatched: 0,
    });
    const [row] = store.queryCorrelationReadModel({ agentId });
    assert.equal(row.sourceKind, 'agent');
    assert.equal(row.sourceName, 'macbook-air');
    assert.equal(row.agentOnly, false);
    assert.equal(row.matchKind, 'exact-5tuple');
    assert.equal(row.connectionSrc, '192.0.2.10');
  });

  it('uses the weaker four-tuple match only for one candidate with unknown router sport', () => {
    const database = store._dbForTest();
    addConnection(database, { sport: null, firstSeen: observedAt + 30_000, lastSeen: observedAt + 30_000 });

    store.storeBatch(agentId, copy(), { receivedAt: observedAt + 1_000 });

    const link = database.prepare('SELECT * FROM connection_agent_observations').get();
    assert.equal(link.matchKind, 'unique-4tuple-time');
    assert.equal(link.timeDeltaMs, 30_000);
  });

  it('does not label a same-port candidate exact unless observation periods overlap', () => {
    const database = store._dbForTest();
    addConnection(database, { firstSeen: observedAt + 30_000, lastSeen: observedAt + 30_000 });

    store.storeBatch(agentId, copy(), { receivedAt: observedAt + 1_000 });

    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM connection_agent_observations').get().n, 0);
    assert.equal(store.queryCorrelationReadModel({ agentId })[0].agentOnly, true);
  });

  it('does not guess when protocol-normalized candidates are ambiguous', () => {
    const database = store._dbForTest();
    addConnection(database, { proto: 'TCP', sport: null });
    addConnection(database, { proto: 'tcp', sport: null });

    const envelope = copy();
    store.storeBatch(agentId, envelope, { receivedAt: observedAt + 1_000 });
    const result = store.reconcileCorrelations({ agentId });

    assert.equal(result.ambiguous, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM connection_agent_observations').get().n, 0);
    assert.deepEqual(store.getCorrelationDiagnostics(), {
      observations: 1,
      correlated: 0,
      exact: 0,
      uniqueMatch: 0,
      ambiguous: 1,
      unmatched: 0,
    });
  });

  it('keeps known sport mismatches and observations outside the time window Agent-only', () => {
    const database = store._dbForTest();
    addConnection(database, { sport: 60000 });
    const envelope = copy();
    envelope.observations.push({
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000088',
      remotePort: 8443,
    });
    addConnection(database, {
      dport: 8443,
      firstSeen: observedAt + 90_001,
      lastSeen: observedAt + 90_001,
    });

    store.storeBatch(agentId, envelope, { receivedAt: observedAt + 1_000 });

    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM connection_agent_observations').get().n, 0);
    const rows = store.queryCorrelationReadModel({ agentId });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.agentOnly));
  });

  it('reconciles Agent-first data after router data arrives and retains multiple processes', () => {
    const database = store._dbForTest();
    const envelope = copy();
    envelope.observations.push({
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000077',
      processID: 84,
      processName: 'SecondExample',
      bundleID: 'com.example.second',
    });
    store.storeBatch(agentId, envelope, { receivedAt: observedAt + 1_000 });
    addConnection(database);

    const result = store.reconcileCorrelations({ agentId });

    assert.equal(result.exact, 2);
    const rows = store.queryCorrelationReadModel({ agentId });
    assert.deepEqual(new Set(rows.map(row => row.processName)), new Set(['Example', 'SecondExample']));
    assert.ok(rows.every(row => !row.agentOnly));
  });

  it('unions only Agent-only flows while attaching every correlated process to one router row', () => {
    const database = store._dbForTest();
    addConnection(database);
    const envelope = copy();
    envelope.observations.push({
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000066',
      processID: 84,
      processName: 'SecondExample',
    });
    envelope.observations.push({
      ...structuredClone(envelope.observations[0]),
      observationId: '00000000-0000-4000-8000-000000000055',
      remoteAddress: '203.0.113.50',
      processID: 126,
      processName: 'AgentOnlyExample',
    });
    store.storeBatch(agentId, envelope, { receivedAt: observedAt + 1_000 });

    const rows = store.queryUnifiedReadModel([{
      src: '192.0.2.10', dst: '198.51.100.20', dport: 443, proto: 'TCP',
      srcMac: '00:11:22:33:44:55', observedBy: ['yamaha1'],
    }], { agentId });

    assert.equal(rows.length, 2);
    const router = rows.find(row => !row.agentOnly);
    const agentOnly = rows.find(row => row.agentOnly);
    assert.equal(router.srcMac, '00:11:22:33:44:55');
    assert.deepEqual(router.sourceIds, ['yamaha1']);
    assert.deepEqual(
      new Set(router.agentAttributions.map(row => row.processName)),
      new Set(['Example', 'SecondExample'])
    );
    assert.equal(agentOnly.sourceKind, 'agent');
    assert.equal(agentOnly.processName, 'AgentOnlyExample');
  });

  it('can bound periodic retries to recent observations', () => {
    const database = store._dbForTest();
    store.storeBatch(agentId, copy(), { receivedAt: observedAt + 1_000 });
    addConnection(database);

    const result = store.reconcileCorrelations({ agentId, since: observedAt + 1 });

    assert.equal(result.examined, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM connection_agent_observations').get().n, 0);
  });

  it('removes correlation links before pruning their observations', () => {
    const database = store._dbForTest();
    addConnection(database);
    store.storeBatch(agentId, copy(), { receivedAt: observedAt + 1_000 });

    const result = store.pruneObservations({ before: observedAt + 1 });

    assert.deepEqual(result, { correlations: 1, observations: 1, batches: 0 });
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM connection_agent_observations').get().n, 0);
  });
});
