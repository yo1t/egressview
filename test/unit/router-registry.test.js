// Unit tests for src/router-registry.js (P2-30 PR 2)
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRouterRegistry } = require('../../src/router-registry');
const { createCiscoAdapter }   = require('../../src/pollers/cisco-adapter');
const { createYamahaAdapter }  = require('../../src/pollers/yamaha-adapter');

function ciscoEntry(id, displayName) {
  return { id, adapter: createCiscoAdapter({ id }), displayName };
}

describe('router-registry: register', () => {
  it('registers a contract-valid adapter and freezes the entry', () => {
    const reg = createRouterRegistry();
    const entry = reg.register(ciscoEntry('cisco-11111111', 'Office edge'));
    assert.equal(entry.id, 'cisco-11111111');
    assert.equal(entry.kind, 'cisco');
    assert.equal(entry.displayName, 'Office edge');
    assert.ok(Object.isFrozen(entry));
    assert.equal(reg.size(), 1);
    assert.ok(reg.has('cisco-11111111'));
    assert.equal(reg.get('cisco-11111111'), entry);
  });

  it('defaults displayName to the id', () => {
    const reg = createRouterRegistry();
    const entry = reg.register(ciscoEntry('cisco-22222222'));
    assert.equal(entry.displayName, 'cisco-22222222');
  });

  it('supports mixed kinds and same-kind multiples', () => {
    const reg = createRouterRegistry();
    reg.register(ciscoEntry('cisco-11111111'));
    reg.register(ciscoEntry('cisco-22222222'));
    reg.register({ id: 'yamaha1', adapter: createYamahaAdapter({ id: 'yamaha1' }) });
    assert.deepEqual(reg.list().map(e => e.kind).sort(), ['cisco', 'cisco', 'yamaha']);
  });

  it('rejects invalid routerIds', () => {
    const reg = createRouterRegistry();
    assert.throws(() => reg.register(ciscoEntry('Bad_ID')), /invalid routerId/);
    assert.throws(() => reg.register(ciscoEntry('')), /invalid routerId/);
    assert.throws(() => reg.register({ adapter: createCiscoAdapter({ id: 'x' }) }), /invalid routerId/);
  });

  it('rejects duplicate registration', () => {
    const reg = createRouterRegistry();
    reg.register(ciscoEntry('cisco-11111111'));
    assert.throws(() => reg.register(ciscoEntry('cisco-11111111')), /already registered/);
  });

  it('rejects adapters that do not satisfy the poller contract', () => {
    const reg = createRouterRegistry();
    assert.throws(
      () => reg.register({ id: 'cisco-33333333', adapter: { kind: 'cisco' } }),
      /missing method/
    );
  });
});

describe('router-registry: unregister and tombstones', () => {
  it('unregister removes the router and leaves a tombstone', () => {
    const reg = createRouterRegistry();
    reg.register(ciscoEntry('cisco-11111111'));
    assert.equal(reg.unregister('cisco-11111111'), true);
    assert.equal(reg.has('cisco-11111111'), false);
    assert.equal(reg.get('cisco-11111111'), null);
    assert.ok(reg.allKnownIds().has('cisco-11111111'));
  });

  it('a tombstoned id can never be re-registered', () => {
    const reg = createRouterRegistry();
    reg.register(ciscoEntry('cisco-11111111'));
    reg.unregister('cisco-11111111');
    assert.throws(() => reg.register(ciscoEntry('cisco-11111111')), /cannot be reused/);
  });

  it('unregister of an unknown id returns false', () => {
    const reg = createRouterRegistry();
    assert.equal(reg.unregister('cisco-99999999'), false);
  });

  it('allKnownIds covers active and tombstoned ids', () => {
    const reg = createRouterRegistry();
    reg.register(ciscoEntry('cisco-11111111'));
    reg.register(ciscoEntry('cisco-22222222'));
    reg.unregister('cisco-22222222');
    const known = reg.allKnownIds();
    assert.ok(known.has('cisco-11111111'));
    assert.ok(known.has('cisco-22222222'));
    assert.equal(known.size, 2);
  });
});
