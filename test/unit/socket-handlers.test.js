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
    const auditEvents = [];

    registerSocketHandlers({
      io,
      appState,
      authorizeCredential: (token) => token === 'good-token'
        ? {
            auth: { user: 'ok' }, permissions: ['network.read'], allowed: true,
            authMethod: 'local', actor: 'session:one', principal: 'local:admin',
          }
        : null,
      authAudit: { append: event => auditEvents.push(event) },
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
    assert.equal(auditEvents[0].eventType, 'realtime_authentication');
    assert.equal(auditEvents[0].outcome, 'success');
    assert.equal(auditEvents[0].actor, 'session:one');

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
      authorizeCredential: () => null,
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

  it('denies a valid identity that lacks network.read before any payload is emitted', () => {
    let middleware;
    let onConnection;
    const io = {
      use(fn) { middleware = fn; },
      on(event, fn) { if (event === 'connection') onConnection = fn; },
    };
    const { asus, yamaha, cisco } = createRouters();
    const decisions = [];
    const auditEvents = [];
    registerSocketHandlers({
      io,
      appState: createAppState(),
      authorizeCredential(token, required, options) {
        decisions.push({ token, required, options });
        return { auth: { kind: 'api-identity' }, permissions: ['notes.write'], allowed: false };
      },
      authAudit: { append: event => auditEvents.push(event) },
      asus,
      yamaha,
      cisco,
      notes: { getAll: () => ({ private: 'must not be sent' }) },
      history: { getConnectionHistory: () => new Map([['secret', { id: 'secret' }]]) },
      defaultRouterIp: '192.168.1.1',
    });

    const socket = { handshake: { auth: { token: 'notes-only' } }, data: {} };
    let error;
    middleware(socket, err => { error = err; });

    assert.equal(error?.message, 'Forbidden');
    assert.deepEqual(decisions[0].required, ['network.read']);
    assert.equal(decisions[0].options.browserSessionOnly, false);
    assert.equal(socket.data.auth, undefined);
    assert.equal(typeof onConnection, 'function');
    assert.equal(auditEvents[0].outcome, 'failure');
    assert.deepEqual(auditEvents[0].metadata, { reason: 'permission_denied' });
  });

  it('treats cookie credentials as browser sessions only', () => {
    let middleware;
    const io = { use(fn) { middleware = fn; }, on() {} };
    const { asus, yamaha, cisco } = createRouters();
    let options;
    registerSocketHandlers({
      io,
      appState: createAppState(),
      authorizeCredential(_token, _required, receivedOptions) {
        options = receivedOptions;
        return null;
      },
      asus,
      yamaha,
      cisco,
      notes: { getAll: () => ({}) },
      history: { getConnectionHistory: () => new Map() },
      defaultRouterIp: '192.168.1.1',
    });

    middleware({ handshake: { headers: { cookie: 'egressview_session=forged-api-token' } } }, () => {});
    assert.equal(options.browserSessionOnly, true);
  });

  it('loads the initial one-hour window from SQLite instead of the bounded hot map', () => {
    let onConnection;
    const io = { use() {}, on(_event, fn) { onConnection = fn; } };
    const { asus, yamaha, cisco } = createRouters();
    const queried = [];
    registerSocketHandlers({
      io,
      appState: createAppState(),
      authorizeCredential: () => ({ auth: true, permissions: ['network.read'], allowed: true }),
      asus,
      yamaha,
      cisco,
      notes: { getAll: () => ({}) },
      history: {
        getConnectionHistory: () => new Map([['hot', { id: 'hot', lastSeen: 4_000_000 }]]),
        queryByTimeRange(from, to) {
          queried.push({ from, to });
          return [{ id: 'sqlite-recent', lastSeen: to }];
        },
      },
      threatIntel: { matchThreatIntel: () => ({ confidence: 'high' }) },
      getRouters: () => [{ enabled: true }],
      defaultRouterIp: '192.168.1.1',
      logger: { debug() {} },
      now: () => 4_000_000,
    });
    const emitted = [];
    onConnection({ id: 'socket-1', emit: (event, payload) => emitted.push({ event, payload }) });

    assert.deepEqual(queried, [{ from: 400_000, to: 4_000_000 }]);
    const update = emitted.find(item => item.event === 'connections-update');
    assert.equal(update.payload.connections[0].id, 'sqlite-recent');
    assert.equal(update.payload.connections[0].threat.confidence, 'high');
  });
});
