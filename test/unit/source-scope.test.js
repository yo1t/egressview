'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { z } = require('zod');
const {
  isKnownSourceScope,
  sourceScopeShape,
  validateSourceScopePair,
} = require('../../src/source-scope');

const schema = z.object(sourceScopeShape).strict().superRefine(validateSourceScopePair);

describe('collection source scope validation', () => {
  it('requires sourceKind and sourceId as one pair', () => {
    assert.equal(schema.safeParse({}).success, true);
    assert.equal(schema.safeParse({ sourceKind: 'router', sourceId: 'router-1' }).success, true);
    assert.equal(schema.safeParse({ sourceKind: 'router' }).success, false);
    assert.equal(schema.safeParse({ sourceId: 'router-1' }).success, false);
    assert.equal(schema.safeParse({ sourceKind: 'other', sourceId: 'router-1' }).success, false);
  });

  it('accepts only active configured sources', () => {
    const dependencies = {
      routerManager: { list: () => [
        { id: 'router-1', enabled: true },
        { id: 'router-2', enabled: false },
      ] },
      agentIdentities: { listAgents: () => [
        { agentId: 'agent-1', revokedAt: null },
        { agentId: 'agent-2', revokedAt: 123 },
      ] },
    };
    assert.equal(isKnownSourceScope({ sourceKind: 'router', sourceId: 'router-1' }, dependencies), true);
    assert.equal(isKnownSourceScope({ sourceKind: 'router', sourceId: 'router-2' }, dependencies), false);
    assert.equal(isKnownSourceScope({ sourceKind: 'agent', sourceId: 'agent-1' }, dependencies), true);
    assert.equal(isKnownSourceScope({ sourceKind: 'agent', sourceId: 'agent-2' }, dependencies), false);
    assert.equal(isKnownSourceScope({ sourceKind: 'agent', sourceId: "x' OR 1=1 --" }, dependencies), false);
    assert.equal(isKnownSourceScope({ sourceKind: 'router', sourceId: 'router-1' }), false);
    assert.equal(isKnownSourceScope({ sourceKind: 'agent', sourceId: 'agent-1' }), false);
  });
});
