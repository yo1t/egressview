'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildClientConfig, registerSocketHandlers } = require('../../src/socket-handlers');

function createRouters(overrides = {}) {
  const asus = {
    getRouterIp: () => '192.168.50.1',
    getUser: () => 'admin',
    hasPass: () => true,
    isAuthenticated: () => true,
    isEnabled: () => true,
    ...overrides.asus,
  };
  const yamaha = {
    isEnabled: () => true,
    getIp: () => '192.168.100.1',
    getUser: () => 'yamaha-user',
    getNat: () => new Map(),
    hasPass: () => true,
    isReady: () => true,
    ...overrides.yamaha,
  };
  const cisco = {
    isEnabled: () => true,
    getIp: () => '192.168.200.1',
    getUser: () => 'cisco-user',
    hasPass: () => true,
    isReady: () => true,
    ...overrides.cisco,
  };
  return { asus, yamaha, cisco };
}

function createAppState(overrides = {}) {
  return {
    adminToken: 'secret',
    homeCountry: 'JP',
    uiLanguage: 'ja',
    autoInvestigate: false,
    retentionDays: 14,
    dnsmasqEnabled: true,
    dnsmasqLogFile: '/var/log/dnsmasq.log',
    inspectEnabled: false,
    inspectLogFile: '/var/log/inspect.log',
    dhcpdEnabled: true,
    dhcpdLogFile: '/var/log/dhcpd.log',
    ...overrides,
  };
}

describe('buildClientConfig', () => {
  it('builds the socket bootstrap payload from injected state', () => {
    const appState = createAppState({ uiLanguage: 'en' });
    const { asus, yamaha, cisco } = createRouters({
      asus: { getRouterIp: () => '' },
    });

    const config = buildClientConfig({
      appState,
      asus,
      yamaha,
      cisco,
      notes: { getAll: () => ({ '1.1.1.1': 'Printer' }) },
      defaultRouterIp: '192.168.1.1',
      routers: [{ id: 'cisco1', kind: 'cisco', enabled: true, ready: true }],
    });

    assert.equal(config.routerIp, '192.168.1.1');
    assert.equal(config.language, 'en');
    assert.deepEqual(config.notes, { '1.1.1.1': 'Printer' });
    assert.equal(config.ciscoReady, true);
    assert.equal(config.routers[0].id, 'cisco1');
  });
});

describe('registerSocketHandlers', () => {
  it('registers handshake auth and emits initial payloads on connection', () => {
    let middleware;
    let onConnection;
    const io = {
      use(fn) { middleware = fn; },
      on(event, fn) {
        if (event === 'connection') onConnection = fn;
      },
    };
    const appState = createAppState();
    const { asus, yamaha, cisco } = createRouters({
      asus: { isAuthenticated: () => false },
    });

    registerSocketHandlers({
      io,
      appState,
      authenticate: (token) => token === 'good-token' ? { user: 'ok' } : null,
      asus,
      yamaha,
      cisco,
      notes: { getAll: () => ({}) },
      history: {
        getConnectionHistory: () => new Map([
          ['recent', { lastSeen: 3_995_000, id: 'recent' }],
          ['old', { lastSeen: 100_000, id: 'old' }],
        ]),
      },
      defaultRouterIp: '192.168.1.1',
      logger: { debug: () => {} },
      now: () => 4_000_000,
    });

    assert.equal(typeof middleware, 'function');
    assert.equal(typeof onConnection, 'function');

    let authResult = null;
    middleware({ handshake: { auth: { token: 'good-token' } } }, (err) => { authResult = err || 'ok'; });
    assert.equal(authResult, 'ok');

    const emitted = [];
    onConnection({
      id: 'socket-1',
      emit(event, payload) { emitted.push({ event, payload }); },
    });

    assert.deepEqual(emitted.map(e => e.event), ['config', 'auth-required', 'connections-update']);
    assert.equal(emitted[2].payload.connections.length, 1);
    assert.equal(emitted[2].payload.connections[0].id, 'recent');
    assert.equal(emitted[2].payload.initialLoad, true);
  });

  it('rejects unauthenticated handshakes and missing admin setup', () => {
    let middleware;
    const io = {
      use(fn) { middleware = fn; },
      on() {},
    };
    const { asus, yamaha, cisco } = createRouters();

    registerSocketHandlers({
      io,
      appState: createAppState({ adminToken: '' }),
      authenticate: () => null,
      asus,
      yamaha,
      cisco,
      notes: { getAll: () => ({}) },
      history: { getConnectionHistory: () => new Map() },
      defaultRouterIp: '192.168.1.1',
    });

    let error = null;
    middleware({ handshake: { auth: { token: 'bad-token' } } }, (err) => { error = err; });
    assert.equal(error?.message, '認証未初期化');
  });
});
