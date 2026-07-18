'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildAnonymousAiContext } = require('../../src/ai-context');

describe('anonymous AI context', () => {
  it('keeps aggregate evidence while excluding identifying router and connection data', () => {
    const facts = {
      range: { from: 1, to: 2, durationMs: 1 },
      previousRange: { from: 0, to: 1, durationMs: 1 },
      collection: { health: 'ok', enabledCount: 1, readyCount: 1 },
      current: { connections: 4, devices: 2, destinations: 3, safe: 3, warn: 1, danger: 0 },
      previous: { connections: 2, devices: 1, destinations: 2, safe: 2, warn: 0, danger: 0 },
    };
    const secretValues = ['192.168.41.10', 'AA:BB:CC:DD:EE:FF', 'office-laptop', 'router.internal'];
    const context = buildAnonymousAiContext({
      facts,
      from: 1,
      to: 2,
      routers: [{ enabled: true, kind: 'cisco', id: 'router.internal', displayName: 'office-laptop' }],
      history: { groupServiceByTimeRange: () => [{ dport: 443, proto: 'tcp', count: 4, dst: secretValues[0] }] },
    });
    assert.deepEqual(context.collection.routerKinds, { cisco: 1 });
    assert.deepEqual(context.topServices, [{ port: 443, protocol: 'tcp', connections: 4 }]);
    const serialized = JSON.stringify(context);
    for (const value of secretValues) assert.equal(serialized.includes(value), false);
  });

  it('bounds the service list', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ dport: i, proto: 'tcp', count: 1 }));
    const context = buildAnonymousAiContext({
      facts: { range: {}, previousRange: {}, collection: {}, current: {}, previous: {} },
      routers: [], from: 0, to: 1,
      history: { groupServiceByTimeRange: () => rows },
    });
    assert.equal(context.topServices.length, 20);
  });
});
