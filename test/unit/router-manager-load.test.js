'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../../src/runtime');
const { createRouterManager } = require('../../src/router-manager');

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeManualTimer() {
  const tasks = [];
  return {
    schedulePoll(fn, delay) {
      const task = { fn, delay, canceled: false, fired: false };
      tasks.push(task);
      return task;
    },
    cancelPoll(task) { if (task) task.canceled = true; },
    pending() { return tasks.filter(task => !task.canceled && !task.fired); },
    fire(task) { task.fired = true; task.fn(); },
  };
}

function records(count = 10) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${index % 2 ? 'yamaha' : 'cisco'}-${String(index + 1).padStart(8, '0')}`,
    kind: index % 2 ? 'yamaha' : 'cisco',
    displayName: `Router ${index + 1}`,
    ip: `192.168.1.${index + 1}`,
    user: 'test',
    pass: 'test',
    enabled: true,
    createdAt: index + 1,
  }));
}

function sessionsFor(routerIndex, { shared = 0, total = 1_000 } = {}) {
  const sessions = [];
  for (let index = 0; index < shared; index++) {
    sessions.push({
      src: `10.0.0.${index + 1}`,
      sport: 20_000 + index,
      dst: `198.51.100.${index + 1}`,
      dport: 443,
      proto: 'TCP',
    });
  }
  for (let index = shared; index < total; index++) {
    const offset = index - shared;
    sessions.push({
      src: `10.${routerIndex + 1}.${Math.floor(offset / 250)}.${offset % 250 + 1}`,
      sport: 30_000 + offset,
      dst: `203.${routerIndex + 1}.${Math.floor(offset / 250)}.${offset % 250 + 1}`,
      dport: 10_000 + offset,
      proto: 'TCP',
    });
  }
  return sessions;
}

function makeHistory() {
  const connectionHistory = new Map();
  let appendCount = 0;
  return {
    getConnectionHistory: () => connectionHistory,
    appendHistoryLog: () => { appendCount++; },
    pruneHistory() {},
    upsertRouterMetadata() {},
    observationIdsForSource: () => [],
    appendCount: () => appendCount,
  };
}

function initRuntime(history) {
  runtime.setKnownMacs(new Set());
  runtime.init({
    io: { emit() {} },
    history,
    enrichment: {
      getDnsCache: () => new Map(),
      getRdapCache: () => new Map(),
      getGeoCache: () => new Map(),
      isPtrJunk: () => false,
    },
    threatIntel: { matchThreatIntel: () => null },
    notifier: { notify() {}, notifyNewDevice() {} },
    deviceId: { getNodeMeta: () => ({ vendor: null, dnsName: null, mdnsName: null }) },
    devices: { observeDevice() {} },
    asus: { getClientMac: () => null },
    yamaha: { getArpMac: () => null },
    cisco: { getArpMac: () => null },
    dhcpdSyslog: { getMacByIp: () => null },
  });
}

function createDeferredAdapters(sessionSets, failingIds = new Set()) {
  const pending = [];
  let concurrent = 0;
  let highWater = 0;

  return {
    createAdapter(record) {
      let config = {};
      return {
        kind: record.kind,
        configure(next) { config = next; },
        connect(onReady) { onReady(); },
        disconnect() {},
        reconnect() {},
        isEnabled: () => config.enabled !== false,
        isReady: () => true,
        fetchSessions() {
          concurrent++;
          highWater = Math.max(highWater, concurrent);
          return new Promise((resolve, reject) => pending.push({
            id: record.id,
            finish() {
              concurrent--;
              if (failingIds.has(record.id)) reject(new Error('injected router failure'));
              else resolve(sessionSets.get(record.id));
            },
          }));
        },
        refreshArp: async () => {},
        refreshNdp: async () => {},
        needsArpRefresh: () => false,
        needsNdpRefresh: () => false,
        getArpCache: () => new Map(),
        getArpMac: () => null,
        getNdpByMac: () => [],
        getIp: () => config.ip || '',
        getUser: () => config.user || '',
        hasPass: () => !!config.pass,
        getNat: () => config.natDescriptor || '',
        getHostFp: () => '',
        exec: async () => '',
        detect: async () => ({}),
        detectCurrent: async () => ({}),
      };
    },
    pending,
    highWater: () => highWater,
  };
}

async function runInitialCycles(manager, timer, adapters, expectedCalls = 10) {
  await settle();
  const initialPolls = timer.pending().filter(task => task.delay < 60_000);
  assert.equal(initialPolls.length, expectedCalls);
  for (const task of initialPolls) timer.fire(task);
  await settle();

  let finished = 0;
  while (finished < expectedCalls) {
    const next = adapters.pending[finished];
    assert.ok(next, `poll ${finished + 1} must start after a slot is released`);
    next.finish();
    finished++;
    await settle();
  }
  assert.equal(manager.scheduler._runningCount(), 0);
}

describe('router manager 10-router gate', () => {
  let history;

  beforeEach(() => {
    history = makeHistory();
    initRuntime(history);
  });

  it('processes 10,000 mixed-router sessions with concurrency capped at three', async () => {
    const routerRecords = records();
    const sessionSets = new Map(routerRecords.map((record, index) => [
      record.id,
      sessionsFor(index, { shared: 100 }),
    ]));
    const timer = makeManualTimer();
    const adapters = createDeferredAdapters(sessionSets);
    const manager = createRouterManager({
      records: routerRecords,
      runtime,
      history,
      appState: { inspectEnabled: true },
      createAdapter: adapters.createAdapter,
      schedulerOptions: {
        schedulePoll: timer.schedulePoll,
        cancelPoll: timer.cancelPoll,
      },
    });

    await runInitialCycles(manager, timer, adapters);

    assert.equal(adapters.highWater(), 3);
    assert.equal(history.getConnectionHistory().size, 9_100);
    assert.equal(history.appendCount(), 10_000);
    const shared = history.getConnectionHistory().get('10.0.0.1|198.51.100.1|443|TCP');
    assert.deepEqual(shared.observedBy, routerRecords.map(record => record.id).sort());
    assert.equal(manager.list().filter(status => status.ready && status.sessionCount === 1_000).length, 10);
    manager.stopAll();
  });

  it('keeps nine 1,000-session routers healthy when one router fails', async () => {
    const routerRecords = records();
    const failedId = routerRecords[4].id;
    const sessionSets = new Map(routerRecords.map((record, index) => [record.id, sessionsFor(index)]));
    const timer = makeManualTimer();
    const adapters = createDeferredAdapters(sessionSets, new Set([failedId]));
    const manager = createRouterManager({
      records: routerRecords,
      runtime,
      history,
      appState: { inspectEnabled: true },
      createAdapter: adapters.createAdapter,
      schedulerOptions: {
        schedulePoll: timer.schedulePoll,
        cancelPoll: timer.cancelPoll,
      },
    });

    await runInitialCycles(manager, timer, adapters);

    assert.equal(adapters.highWater(), 3);
    assert.equal(history.getConnectionHistory().size, 9_000);
    const byId = new Map(manager.list().map(status => [status.id, status]));
    assert.match(byId.get(failedId).lastError, /injected router failure/);
    assert.equal([...byId.values()].filter(status => status.ready && status.sessionCount === 1_000).length, 9);
    manager.stopAll();
  });
});
