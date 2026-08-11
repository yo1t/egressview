// Unit tests for src/db-bootstrap.js (P2-30 PR 3a).
// Invariant: history (which owns schema migrations) attaches first, and a
// migration failure prevents every other module from opening the DB.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runDbBootstrap } = require('../../src/db-bootstrap');

function makeSpies({ historyThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    history: {
      loadConnectionHistory: (dbPath, opts) => {
        calls.push({ module: 'history', dbPath, opts });
        if (historyThrows) throw new Error('migration failed');
      },
    },
    sessions:   { initDb: p => calls.push({ module: 'sessions',   dbPath: p }) },
    devices:    { initDb: p => calls.push({ module: 'devices',    dbPath: p }) },
    enrichment: { initDb: p => calls.push({ module: 'enrichment', dbPath: p }) },
    beacons:    { initDb: p => calls.push({ module: 'beacons',    dbPath: p }) },
    authAudit:  { initDb: p => calls.push({ module: 'authAudit',  dbPath: p }) },
    apiIdentities: { initDb: p => calls.push({ module: 'apiIdentities', dbPath: p }) },
    agentIdentities: { initDb: p => calls.push({ module: 'agentIdentities', dbPath: p }) },
  };
}

describe('db-bootstrap', () => {
  it('opens history first, then the other modules, all on the same path', () => {
    const spies = makeSpies();
    runDbBootstrap({ dbPath: '/tmp/x.db', ...spies });
    assert.equal(spies.calls[0].module, 'history');
    assert.deepEqual(
      spies.calls.map(c => c.module),
      [
        'history', 'sessions', 'devices', 'enrichment', 'beacons',
        'authAudit', 'apiIdentities', 'agentIdentities',
      ]
    );
    for (const c of spies.calls) assert.equal(c.dbPath, '/tmp/x.db');
  });

  it('passes the sourceRouterMap through to history', () => {
    const spies = makeSpies();
    const map = { yamaha: 'yamaha1', cisco: 'legacy-cisco' };
    runDbBootstrap({ dbPath: ':memory:', sourceRouterMap: map, ...spies });
    assert.deepEqual(spies.calls[0].opts, { sourceRouterMap: map });
  });

  it('a history/migration failure stops the bootstrap before any other module attaches', () => {
    const spies = makeSpies({ historyThrows: true });
    assert.throws(() => runDbBootstrap({ dbPath: ':memory:', ...spies }), /migration failed/);
    assert.deepEqual(spies.calls.map(c => c.module), ['history'],
      'no module may open the DB after a failed migration');
  });
});
