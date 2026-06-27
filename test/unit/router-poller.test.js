'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_METHODS,
  createRouterPoller,
  validateRouterPoller,
} = require('../../src/pollers/router-interface');
const yamahaAdapter = require('../../src/pollers/yamaha-adapter');

function makeAdapter(overrides = {}) {
  const fn = () => {};
  const adapter = { kind: 'test-router' };
  for (const name of REQUIRED_METHODS) adapter[name] = fn;
  return { ...adapter, ...overrides };
}

describe('router poller interface', () => {
  it('accepts a complete adapter', () => {
    const adapter = makeAdapter();
    assert.equal(validateRouterPoller(adapter), adapter);
  });

  it('rejects adapters without a kind', () => {
    assert.throws(
      () => validateRouterPoller(makeAdapter({ kind: '' })),
      /string kind/
    );
  });

  it('rejects adapters missing required methods', () => {
    const adapter = makeAdapter({ fetchSessions: undefined });
    assert.throws(
      () => validateRouterPoller(adapter),
      /missing method: fetchSessions/
    );
  });

  it('freezes created adapters so the contract is stable at runtime', () => {
    const adapter = createRouterPoller(makeAdapter());
    assert.equal(Object.isFrozen(adapter), true);
  });
});

describe('Yamaha router adapter', () => {
  it('implements the generic router poller contract', () => {
    assert.equal(yamahaAdapter.kind, 'yamaha');
    for (const name of REQUIRED_METHODS) {
      assert.equal(typeof yamahaAdapter[name], 'function', `${name} should be a function`);
    }
  });

  it('keeps legacy Yamaha method names as aliases during migration', () => {
    assert.equal(yamahaAdapter.connectYamaha, yamahaAdapter.connect);
    assert.equal(yamahaAdapter.fetchNatSessions, yamahaAdapter.fetchSessions);
    assert.equal(yamahaAdapter.refreshYamahaArp, yamahaAdapter.refreshArp);
    assert.equal(yamahaAdapter.refreshYamahaNdp, yamahaAdapter.refreshNdp);
    assert.equal(yamahaAdapter.yamahaExec, yamahaAdapter.exec);
    assert.equal(yamahaAdapter.detectYamaha, yamahaAdapter.detect);
    assert.equal(yamahaAdapter.detectCurrentYamaha, yamahaAdapter.detectCurrent);
  });
});
