// Unit tests for src/runtime.js (recordConnection, resolveMacByIp, scheduleInspectEmit)
// All external dependencies are replaced with lightweight stubs.
// Run: node --test test/unit/runtime.test.js
'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../../src/runtime');

// ─── Stubs ────────────────────────────────────────────────────────────────────

function makeIo() {
  const emitted = [];
  return { emit: (...args) => emitted.push(args), _emitted: emitted };
}

function makeHistory() {
  const map = new Map();
  const log = [];
  return {
    getConnectionHistory: () => map,
    appendHistoryLog:     (e) => log.push(e),
    _log: log,
  };
}

function makeEnrichment({ dnsHost, dnsSource } = {}) {
  const dnsCache  = new Map();
  const rdapCache = new Map();
  const geoCache  = new Map();
  if (dnsHost) {
    dnsCache.set('8.8.8.8', { host: dnsHost, expires: Date.now() + 60000, source: dnsSource || 'ptr' });
  }
  return {
    getDnsCache:  () => dnsCache,
    getRdapCache: () => rdapCache,
    getGeoCache:  () => geoCache,
    isPtrJunk:    (h) => !h || h.includes('in-addr') || h === '8.8.8.8',
    reverseDns:   async () => {},
    lookupRdap:   async () => {},
    lookupGeoBatch: async () => {},
  };
}

function makeThreatIntel(matchResult = null) {
  return { matchThreatIntel: () => matchResult };
}

function makeNotifier() {
  const calls = { notify: [], newDevice: [] };
  return {
    notify:           (e) => calls.notify.push(e),
    notifyNewDevice:  (e) => calls.newDevice.push(e),
    _calls: calls,
  };
}

function makeDeviceId() {
  return {
    getNodeMeta: (ip, mac) => ({ vendor: 'TestVendor', dnsName: null, mdnsName: null }),
  };
}

function makeDevices() {
  const observed = [];
  return {
    upsert:        (d) => observed.push(d),
    observeDevice: (d) => observed.push(d),
    _upserted: observed,   // alias: 既存テストとの後方互換
  };
}

function makeAsus(mac = null) {
  return { getClientMac: () => mac, getRouterIp: () => '192.168.1.1' };
}
function makeDhcpd(mac = null) {
  return { getMacByIp: () => mac };
}
function makeYamaha(arpMac = null) {
  return { getArpMac: () => arpMac, getIp: () => '192.168.1.1' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SESSION = { src: '192.168.1.100', sport: 12345, dst: '8.8.8.8', dport: 53, proto: 'UDP', ttl: 0 };

function initRuntime(overrides = {}) {
  const io          = overrides.io          || makeIo();
  const hist        = overrides.history     || makeHistory();
  const enrich      = overrides.enrichment  || makeEnrichment();
  const threat      = overrides.threatIntel || makeThreatIntel();
  const notif       = overrides.notifier    || makeNotifier();
  const devId       = overrides.deviceId    || makeDeviceId();
  const devs        = overrides.devices     || makeDevices();
  const asus_       = overrides.asus        || makeAsus();
  const yamaha_     = overrides.yamaha      || makeYamaha();
  const dhcpd_      = overrides.dhcpdSyslog || makeDhcpd();

  runtime.setKnownMacs(new Set());   // reset between tests
  runtime.init({ io, history: hist, enrichment: enrich, threatIntel: threat,
                 notifier: notif, deviceId: devId, devices: devs,
                 asus: asus_, yamaha: yamaha_, dhcpdSyslog: dhcpd_ });

  return { io, history: hist, enrichment: enrich, threatIntel: threat,
           notifier: notif, deviceId: devId, devices: devs };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveMacByIp', () => {
  it('returns ASUS mac when available', () => {
    initRuntime({ asus: makeAsus('aa:bb:cc:dd:ee:ff') });
    assert.equal(runtime.resolveMacByIp('192.168.1.100'), 'aa:bb:cc:dd:ee:ff');
  });

  it('falls back to dhcpd mac when ASUS has none', () => {
    initRuntime({ asus: makeAsus(null), dhcpdSyslog: makeDhcpd('11:22:33:44:55:66') });
    assert.equal(runtime.resolveMacByIp('192.168.1.100'), '11:22:33:44:55:66');
  });

  it('falls back to yamaha ARP when both ASUS and dhcpd have none', () => {
    initRuntime({ asus: makeAsus(null), dhcpdSyslog: makeDhcpd(null), yamaha: makeYamaha('de:ad:be:ef:00:01') });
    assert.equal(runtime.resolveMacByIp('192.168.1.100'), 'de:ad:be:ef:00:01');
  });

  it('returns null when ip is null', () => {
    initRuntime();
    assert.equal(runtime.resolveMacByIp(null), null);
  });
});

describe('recordConnection', () => {
  it('stores the entry in connection history', () => {
    const { history: hist } = initRuntime();
    runtime.recordConnection(SESSION);
    assert.equal(hist.getConnectionHistory().size, 1);
  });

  it('returns isNew=true for a first-time session', () => {
    initRuntime();
    const { isNew } = runtime.recordConnection(SESSION);
    assert.ok(isNew);
  });

  it('returns isNew=false for a repeat session', () => {
    initRuntime();
    runtime.recordConnection(SESSION);
    const { isNew } = runtime.recordConnection(SESSION);
    assert.ok(!isNew);
  });

  it('calls notifier.notify when threat is found', () => {
    const threat  = makeThreatIntel({ tag: 'Feodo', type: 'C2' });
    const notif   = makeNotifier();
    initRuntime({ threatIntel: threat, notifier: notif });
    runtime.recordConnection(SESSION);
    assert.equal(notif._calls.notify.length, 1);
  });

  it('does NOT call notifier.notify when there is no threat', () => {
    const notif = makeNotifier();
    initRuntime({ notifier: notif });
    runtime.recordConnection(SESSION);
    assert.equal(notif._calls.notify.length, 0);
  });

  it('emits new-device on io for a new MAC address', () => {
    const io    = makeIo();
    const asus_ = makeAsus('aa:bb:cc:dd:ee:01');
    initRuntime({ io, asus: asus_ });
    runtime.recordConnection(SESSION);
    const newDeviceEmits = io._emitted.filter(e => e[0] === 'new-device');
    assert.equal(newDeviceEmits.length, 1);
  });

  it('does NOT emit new-device for a previously seen MAC', () => {
    const io    = makeIo();
    const asus_ = makeAsus('aa:bb:cc:dd:ee:01');
    initRuntime({ io, asus: asus_ });
    runtime.recordConnection(SESSION);       // first: emits
    runtime.recordConnection({ ...SESSION, sport: 99999 }); // second session, same src MAC
    const newDeviceEmits = io._emitted.filter(e => e[0] === 'new-device');
    assert.equal(newDeviceEmits.length, 1);  // still only 1
  });

  it('uses dnsmasq dstHost in preference to raw IP', () => {
    const enrich = makeEnrichment({ dnsHost: 'dns.google', dnsSource: 'dnsmasq' });
    const { history: hist } = initRuntime({ enrichment: enrich });
    runtime.recordConnection(SESSION);
    const entry = [...hist.getConnectionHistory().values()][0];
    assert.equal(entry.dstHost, 'dns.google');
  });

  it('appends to history log for new sessions', () => {
    const { history: hist } = initRuntime();
    runtime.recordConnection(SESSION);
    assert.equal(hist._log.length, 1);
  });

  it('does not append to history log for repeat sessions', () => {
    const { history: hist } = initRuntime();
    runtime.recordConnection(SESSION);
    runtime.recordConnection(SESSION);
    assert.equal(hist._log.length, 1);
  });

  it('upserts into device inventory', () => {
    const devs = makeDevices();
    initRuntime({ devices: devs });
    runtime.recordConnection(SESSION);
    assert.equal(devs._upserted.length, 1);
    assert.equal(devs._upserted[0].ip, SESSION.src);
  });
});

// ─── scheduleInspectEmit: delta push tests ────────────────────────────────────

describe('scheduleInspectEmit: delta push', () => {
  it('送信される接続は lastInspectEmitTime より新しいエントリのみ', (t) => {
    t.mock.timers.enable(['setTimeout']);
    const io   = makeIo();
    const hist = makeHistory();
    initRuntime({ io, history: hist });

    const base = 1_000_000;
    // 古いエントリ (base - 1): emit 対象外
    hist.getConnectionHistory().set('old', { src: '192.168.1.1', dst: '1.1.1.1', dport: 53, proto: 'UDP', lastSeen: base - 1 });
    // 新しいエントリ (base + 1): emit 対象
    hist.getConnectionHistory().set('new', { src: '192.168.1.2', dst: '8.8.8.8', dport: 53, proto: 'UDP', lastSeen: base + 1 });

    runtime._resetInspectEmitTime(base);
    runtime.scheduleInspectEmit();
    t.mock.timers.tick(1000);

    const emits = io._emitted.filter(e => e[0] === 'connections-update');
    assert.equal(emits.length, 1);
    assert.equal(emits[0][1].connections.length, 1);
    assert.equal(emits[0][1].connections[0].dst, '8.8.8.8');
  });

  it('差分ゼロのとき emit を送らない', (t) => {
    t.mock.timers.enable(['setTimeout']);
    const io   = makeIo();
    const hist = makeHistory();
    initRuntime({ io, history: hist });

    const base = 1_000_000;
    // 古いエントリのみ
    hist.getConnectionHistory().set('old', { src: '192.168.1.1', dst: '1.1.1.1', dport: 53, proto: 'UDP', lastSeen: base - 1 });

    runtime._resetInspectEmitTime(base);
    runtime.scheduleInspectEmit();
    t.mock.timers.tick(1000);

    const emits = io._emitted.filter(e => e[0] === 'connections-update');
    assert.equal(emits.length, 0, 'emit が送られないこと');
  });

  it('delta: true と partial: true が付与される', (t) => {
    t.mock.timers.enable(['setTimeout']);
    const io   = makeIo();
    const hist = makeHistory();
    initRuntime({ io, history: hist });

    const base = 1_000_000;
    hist.getConnectionHistory().set('new', { src: '192.168.1.2', dst: '8.8.8.8', dport: 443, proto: 'TCP', lastSeen: base + 1 });

    runtime._resetInspectEmitTime(base);
    runtime.scheduleInspectEmit();
    t.mock.timers.tick(1000);

    const emits = io._emitted.filter(e => e[0] === 'connections-update');
    assert.equal(emits[0][1].partial, true);
    assert.equal(emits[0][1].delta,   true);
  });

  it('複数回 scheduleInspectEmit を呼んでも emit は1回（debounce）', (t) => {
    t.mock.timers.enable(['setTimeout']);
    const io   = makeIo();
    const hist = makeHistory();
    initRuntime({ io, history: hist });

    const base = 1_000_000;
    hist.getConnectionHistory().set('a', { src: '192.168.1.1', dst: '1.1.1.1', dport: 80, proto: 'TCP', lastSeen: base + 1 });

    runtime._resetInspectEmitTime(base);
    runtime.scheduleInspectEmit();
    runtime.scheduleInspectEmit(); // 2回目は無視される
    runtime.scheduleInspectEmit(); // 3回目も無視
    t.mock.timers.tick(1000);

    const emits = io._emitted.filter(e => e[0] === 'connections-update');
    assert.equal(emits.length, 1, 'emit は1回のみ');
  });

  it('lastInspectEmitTime が 0 のとき全エントリが送られる', (t) => {
    t.mock.timers.enable(['setTimeout']);
    const io   = makeIo();
    const hist = makeHistory();
    initRuntime({ io, history: hist });

    hist.getConnectionHistory().set('a', { src: '192.168.1.1', dst: '1.1.1.1', dport: 80,  proto: 'TCP', lastSeen: 1000 });
    hist.getConnectionHistory().set('b', { src: '192.168.1.2', dst: '2.2.2.2', dport: 443, proto: 'TCP', lastSeen: 2000 });

    runtime._resetInspectEmitTime(0); // 全エントリが対象になる
    runtime.scheduleInspectEmit();
    t.mock.timers.tick(1000);

    const emits = io._emitted.filter(e => e[0] === 'connections-update');
    assert.equal(emits[0][1].connections.length, 2);
  });
});
