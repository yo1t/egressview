'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRouterManager } = require('../../src/router-manager');

function fakeAdapter(record) {
  let config = {};
  return {
    kind: record.kind,
    configure(next) { config = next; },
    connect() {}, disconnect() {}, reconnect() {},
    isEnabled: () => config.enabled !== false,
    isReady: () => false,
    fetchSessions: async () => [],
    refreshArp: async () => {}, refreshNdp: async () => {},
    needsArpRefresh: () => false, needsNdpRefresh: () => false,
    getArpCache: () => new Map(), getArpMac: () => null, getNdpByMac: () => [],
    getIp: () => config.ip || '', getUser: () => config.user || '', hasPass: () => !!config.pass,
    getNat: () => config.natDescriptor || '', getHostFp: () => config.hostFp || '',
    exec: async () => '', detect: async input => ({ ssh: { ok: true }, input }), detectCurrent: async () => ({}),
  };
}

function createManager(records = []) {
  const persisted = [];
  const metadata = [];
  const manager = createRouterManager({
    records,
    createAdapter: fakeAdapter,
    persist: (next, tombstones) => persisted.push({ next, tombstones }),
    history: {
      upsertRouterMetadata: record => metadata.push({ action: 'upsert', id: record.id }),
      tombstoneRouterMetadata: id => metadata.push({ action: 'delete', id }),
    },
    io: { emit() {} },
  });
  return { manager, persisted, metadata };
}

describe('router manager CRUD', () => {
  it('creates a disabled router and never exposes its passwords', () => {
    const { manager, persisted } = createManager();
    const created = manager.upsert({
      kind: 'cisco', displayName: 'Edge', ip: '192.168.1.2', user: 'admin',
      pass: 'login-secret', enablePass: 'enable-secret', enabled: false,
    });
    assert.match(created.id, /^cisco-[a-f0-9]{8}$/);
    assert.equal(created.passSet, true);
    assert.equal(created.enablePassSet, true);
    assert.equal(created.pass, undefined);
    assert.equal(created.enablePass, undefined);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].next[0].pass, 'login-secret');
  });

  it('preserves saved secrets when editing with empty password fields', () => {
    const existing = {
      id: 'cisco-12345678', kind: 'cisco', displayName: 'Edge', ip: '192.168.1.2', user: 'admin',
      pass: 'saved-login', enablePass: 'saved-enable', enabled: false, createdAt: 1,
    };
    const { manager, persisted } = createManager([existing]);
    manager.upsert({ id: existing.id, displayName: 'New name', pass: '', enablePass: '', enabled: false });
    const saved = persisted.at(-1).next[0];
    assert.equal(saved.pass, 'saved-login');
    assert.equal(saved.enablePass, 'saved-enable');
    assert.equal(saved.displayName, 'New name');
  });

  it('rejects unknown edit ids and public management IPs', () => {
    const { manager } = createManager();
    assert.throws(() => manager.upsert({ id: 'cisco-12345678', kind: 'cisco' }), /not found/);
    assert.throws(() => manager.upsert({ kind: 'yamaha', ip: '8.8.8.8' }), /must be private/);
  });

  it('tombstones deleted ids and persists the deletion', () => {
    const existing = {
      id: 'yamaha-12345678', kind: 'yamaha', displayName: 'RTX', ip: '192.168.1.1',
      user: 'admin', pass: 'secret', nat: '100', enabled: false, createdAt: 1,
    };
    const { manager, persisted, metadata } = createManager([existing]);
    assert.equal(manager.remove(existing.id), true);
    assert.deepEqual(persisted.at(-1).tombstones, [existing.id]);
    assert.deepEqual(metadata.at(-1), { action: 'delete', id: existing.id });
  });

  it('does not change the runtime registry when persistence fails', () => {
    const manager = createRouterManager({
      createAdapter: fakeAdapter,
      persist: () => { throw new Error('disk full'); },
      history: { upsertRouterMetadata() {} },
      io: { emit() {} },
    });
    assert.throws(() => manager.upsert({
      kind: 'yamaha', ip: '192.168.1.1', user: 'admin', pass: 'secret', nat: '100', enabled: false,
    }), /disk full/);
    assert.equal(manager.list().length, 0);
    assert.equal(manager.registry.size(), 0);
  });
});
