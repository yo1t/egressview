// Unit tests for src/poll-scheduler.js (P2-23 で server.js から分離)
// Run: node --test test/unit/poll-scheduler.test.js
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const scheduler = require('../../src/poll-scheduler');

// ─── Stubs ────────────────────────────────────────────────────────────────────

function makeRouter({ enabled = true, ready = true, sessions = [] } = {}) {
  const calls = { fetch: 0, reconnect: 0, refreshArp: 0 };
  let _enabled = enabled;
  return {
    isEnabled: () => _enabled,
    isReady:   () => ready,
    fetchSessions: async () => { calls.fetch++; return sessions; },
    needsArpRefresh: () => false,
    needsNdpRefresh: () => false,
    refreshArp: async () => { calls.refreshArp++; },
    refreshNdp: async () => {},
    getArpCache: () => new Map(),
    getNdpByMac: () => null,
    reconnect: () => { calls.reconnect++; },
    _calls: calls,
    _disable: () => { _enabled = false; },
  };
}

function makeDeps(over = {}) {
  const emitted = [];
  const historyMap = new Map();
  const recorded = [];
  const deps = {
    io: { emit: (...a) => emitted.push(a) },
    yamaha: makeRouter({ enabled: false }),
    cisco:  makeRouter({ enabled: false }),
    runtime: {
      recordConnection: (s, now, source) => {
        recorded.push({ ...s, source });
        const key = `${s.src}|${s.dst}|${s.dport}|${s.proto}`;
        historyMap.set(key, { ...s, source, lastSeen: now });
      },
      resolveMacByIp: () => null,
    },
    history: {
      getConnectionHistory: () => historyMap,
      pruneHistory: () => {},
    },
    devices: { observeDevice: () => {} },
    beacons: { appendEvent: () => {} },
    investigation: { enqueue: () => {} },
    appState: { inspectEnabled: true, autoInvestigate: false },
    queueConnectionEnrichment: () => {},
    pollIntervalMs: 5,
    ...over,
  };
  return { deps, emitted, historyMap, recorded };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

beforeEach(() => scheduler._resetForTest());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('poll-scheduler: lifecycle', () => {
  it('poll loop dies immediately when the router is disabled and can be restarted', async () => {
    const { deps } = makeDeps();
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    await tick();
    assert.equal(deps.yamaha._calls.fetch, 0, 'disabled router must not be polled');
    // 無効時にループが消滅していれば、再スタートで再びエントリできる（ガードが解除されている）
    scheduler.startYamahaPolling();
    await tick();
    assert.equal(deps.yamaha._calls.fetch, 0);
  });

  it('start guard prevents double loops', async () => {
    const yamaha = makeRouter({ sessions: [] });
    const { deps } = makeDeps({ yamaha });
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    scheduler.startYamahaPolling(); // 二重起動は無視される
    await tick(12); // pollIntervalMs=5 で 2〜3 周期分
    const fetches = yamaha._calls.fetch;
    yamaha._disable(); // ループを止める
    await tick();
    // 二重ループなら fetch 回数が倍増する。1ループ分（経過時間/間隔 + 1 程度）に収まること
    assert.ok(fetches <= 5, `expected single loop, got ${fetches} fetches`);
    assert.ok(fetches >= 1, 'loop must have run at least once');
  });

  it('skips fetch while enabled but not ready, and keeps rescheduling', async () => {
    const yamaha = makeRouter({ ready: false });
    const { deps } = makeDeps({ yamaha });
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    await tick(15);
    assert.equal(yamaha._calls.fetch, 0, 'not-ready router must not be fetched');
    yamaha._disable();
    await tick();
  });
});

describe('poll-scheduler: recording and delta emit', () => {
  it('records yamaha sessions with source="yamaha" and emits them as delta', async () => {
    const session = { src: '192.168.1.10', dst: '8.8.8.8', dport: 443, proto: 'TCP' };
    const yamaha = makeRouter({ sessions: [session] });
    const { deps, emitted, recorded } = makeDeps({ yamaha });
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    await tick(10);
    yamaha._disable();
    await tick();

    assert.ok(recorded.length >= 1);
    assert.equal(recorded[0].source, 'yamaha');
    const updates = emitted.filter(e => e[0] === 'connections-update');
    assert.ok(updates.length >= 1, 'delta emit must fire');
    assert.equal(updates[0][1].delta, true);
    assert.equal(updates[0][1].connections[0].src, '192.168.1.10');
  });

  it('records cisco sessions with source="cisco"', async () => {
    const session = { src: '192.168.2.20', dst: '1.1.1.1', dport: 53, proto: 'UDP' };
    const cisco = makeRouter({ sessions: [session] });
    const { deps, recorded } = makeDeps({ cisco });
    scheduler.init(deps);
    scheduler.startCiscoPolling();
    await tick(10);
    cisco._disable();
    await tick();

    assert.ok(recorded.length >= 1);
    assert.equal(recorded[0].source, 'cisco');
  });
});

describe('poll-scheduler: error handling', () => {
  it('reconnects the router on timeout errors and keeps the loop alive', async () => {
    const yamaha = makeRouter();
    let calls = 0;
    yamaha.fetchSessions = async () => {
      calls++;
      if (calls === 1) throw new Error('SSH timeout');
      return [];
    };
    const { deps } = makeDeps({ yamaha });
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    await tick(15);
    yamaha._disable();
    await tick();

    assert.equal(yamaha._calls.reconnect, 1, 'timeout must trigger reconnect');
    assert.ok(calls >= 2, 'loop must survive the error and poll again');
  });

  it('does not reconnect on non-timeout errors', async () => {
    const yamaha = makeRouter();
    yamaha.fetchSessions = async () => { throw new Error('parse failure'); };
    const { deps } = makeDeps({ yamaha });
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    await tick(10);
    yamaha._disable();
    await tick();

    assert.equal(yamaha._calls.reconnect, 0);
  });
});

describe('poll-scheduler: beacon fallback', () => {
  it('appends beacon events for new sessions only when INSPECT is disabled', async () => {
    const session = { src: '192.168.1.10', dst: '8.8.8.8', dport: 443, proto: 'TCP' };
    const yamaha = makeRouter({ sessions: [session] });
    const events = [];
    const { deps } = makeDeps({
      yamaha,
      beacons: { appendEvent: (e) => events.push(e) },
      appState: { inspectEnabled: false, autoInvestigate: false },
    });
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    await tick(15); // 複数周期 — 2周期目以降は lastPollKeys 済みなので追加されない
    yamaha._disable();
    await tick();

    assert.equal(events.length, 1, 'the same session must be recorded once, not per poll');
    assert.equal(events[0].source, 'poll');
  });

  it('does not append beacon events when INSPECT is enabled', async () => {
    const session = { src: '192.168.1.10', dst: '8.8.8.8', dport: 443, proto: 'TCP' };
    const yamaha = makeRouter({ sessions: [session] });
    const events = [];
    const { deps } = makeDeps({
      yamaha,
      beacons: { appendEvent: (e) => events.push(e) },
      appState: { inspectEnabled: true, autoInvestigate: false },
    });
    scheduler.init(deps);
    scheduler.startYamahaPolling();
    await tick(10);
    yamaha._disable();
    await tick();

    assert.equal(events.length, 0);
  });
});
