// Unit tests for src/runtime.js (recordConnection, resolveMacByIp, scheduleInspectEmit)
// All external dependencies are replaced with lightweight stubs.
// Run: node --test test/unit/runtime.test.js
'use strict';

const { describe, it } = require('node:test');
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
  const batches = [];
  return {
    getConnectionHistory: () => map,
    appendHistoryLog:     (e) => log.push(e),
    appendHistoryLogs:    (entries) => {
      batches.push(entries);
      log.push(...entries);
    },
    observationIdsForSource: source => source === 'yamaha'
      ? ['yamaha1']
      : source === 'cisco' ? ['cisco1'] : source === 'agent' ? [] : [`legacy-${source}`],
    _log: log,
    _batches: batches,
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
    getNodeMeta: (_ip, _mac) => ({ vendor: 'TestVendor', dnsName: null, mdnsName: null }),
  };
}

function makeDevices() {
  const observed = [];
  return {
    upsert:        (d) => observed.push(d),
    observeDevice: (d) => observed.push(d),
    _upserted: observed,   // alias: kept for backward compatibility with existing tests
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
function makeCisco(arpMac = null) {
  return { getArpMac: () => arpMac, getIp: () => '192.168.2.1' };
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
  const cisco_      = overrides.cisco       || makeCisco();
  const dhcpd_      = overrides.dhcpdSyslog || makeDhcpd();

  runtime.setKnownMacs(new Set());   // reset between tests
  runtime.init({ io, history: hist, enrichment: enrich, threatIntel: threat,
                 notifier: notif, deviceId: devId, devices: devs,
                 asus: asus_, yamaha: yamaha_, cisco: cisco_, dhcpdSyslog: dhcpd_,
                 routerRegistry: overrides.routerRegistry });

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

  it('falls back to cisco ARP when ASUS, dhcpd, and yamaha have none', () => {
    initRuntime({ asus: makeAsus(null), dhcpdSyslog: makeDhcpd(null),
                  yamaha: makeYamaha(null), cisco: makeCisco('ca:fe:00:11:22:33') });
    assert.equal(runtime.resolveMacByIp('192.168.2.100'), 'ca:fe:00:11:22:33');
  });

  it('returns null when no source has a mac and cisco is not injected', () => {
    const io = makeIo(), hist = makeHistory();
    runtime.setKnownMacs(new Set());
    runtime.init({ io, history: hist, enrichment: makeEnrichment(), threatIntel: makeThreatIntel(),
                   notifier: makeNotifier(), deviceId: makeDeviceId(), devices: makeDevices(),
                   asus: makeAsus(null), yamaha: makeYamaha(null), dhcpdSyslog: makeDhcpd(null) });
    assert.equal(runtime.resolveMacByIp('192.168.1.100'), null);
  });

  it('returns null when ip is null', () => {
    initRuntime();
    assert.equal(runtime.resolveMacByIp(null), null);
  });

  it('falls back to every registered router ARP cache', () => {
    initRuntime({
      asus: makeAsus(null), dhcpdSyslog: makeDhcpd(null), yamaha: makeYamaha(null), cisco: makeCisco(null),
      routerRegistry: { list: () => [{ adapter: { getArpMac: () => 'aa:00:00:00:00:01' } }] },
    });
    assert.equal(runtime.resolveMacByIp('192.168.9.10'), 'aa:00:00:00:00:01');
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

  it('merges exact observer ids for real-time WebSocket entries', () => {
    initRuntime();
    runtime.recordConnection(SESSION, Date.now(), 'yamaha');
    const { entry } = runtime.recordConnection(SESSION, Date.now(), 'cisco');
    assert.deepEqual(entry.observedBy, ['cisco1', 'yamaha1']);
  });

  it('backdates firstSeen from firstSeenHint for a new entry', () => {
    initRuntime();
    const now  = Date.now();
    const hint = now - 90_000;
    const { entry } = runtime.recordConnection({ ...SESSION, firstSeenHint: hint }, now);
    assert.equal(entry.firstSeen, hint);
    assert.equal(entry.lastSeen, now);
  });

  it('keeps the existing firstSeen even when a later hint arrives', () => {
    initRuntime();
    const now = Date.now();
    const { entry: first } = runtime.recordConnection(SESSION, now - 60_000);
    const { entry } = runtime.recordConnection({ ...SESSION, firstSeenHint: now - 5_000 }, now);
    assert.equal(entry.firstSeen, first.firstSeen);
  });

  it('restores a cold SQLite entry before merging a new observation', () => {
    const hist = makeHistory();
    const firstSeen = Date.now() - 60_000;
    hist.getConnection = () => ({
      ...SESSION,
      firstSeen,
      lastSeen: firstSeen,
      source: 'cisco',
      observedBy: ['cisco1'],
    });
    initRuntime({ history: hist });

    const { entry, isNew } = runtime.recordConnection(SESSION, Date.now(), 'yamaha', 'yamaha1');

    assert.equal(isNew, false);
    assert.equal(entry.firstSeen, firstSeen);
    assert.deepEqual(entry.observedBy, ['cisco1', 'yamaha1']);
  });

  it('ignores an invalid or future firstSeenHint', () => {
    initRuntime();
    const now = Date.now();
    const { entry: future } = runtime.recordConnection({ ...SESSION, firstSeenHint: now + 60_000 }, now);
    assert.equal(future.firstSeen, now);
    const { entry: nan } = runtime.recordConnection({ ...SESSION, dst: '9.9.9.9', firstSeenHint: 'abc' }, now);
    assert.equal(nan.firstSeen, now);
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

describe('recordConnections', () => {
  it('notifies for a threatened Agent flow even when its local address is unknown', () => {
    const notif = makeNotifier();
    const { history: hist } = initRuntime({
      notifier: notif,
      threatIntel: makeThreatIntel({ tag: 'known-c2' }),
    });

    const [record] = runtime.recordConnections([{
      src: '::', sport: 0, dst: '203.0.113.66', dport: 443, proto: 'TCP',
      agentHost: 'macbook', process: 'Browser', pid: 321,
    }], Date.now(), 'agent');

    assert.equal(notif._calls.notify.length, 1);
    assert.equal(notif._calls.notify[0].dst, '203.0.113.66');
    assert.equal(record.entry.process, 'Browser');
    assert.deepEqual(record.entry.observedBy, []);
    assert.equal(hist._batches.length, 1);
  });

  it('persists one history batch and deduplicates device updates by IP', () => {
    const devs = makeDevices();
    const { history: hist } = initRuntime({ devices: devs });
    const sessions = [SESSION, { ...SESSION, dst: '1.1.1.1', sport: 54321 }];

    const recorded = runtime.recordConnections(sessions, Date.now(), 'yamaha', 'yamaha1');

    assert.equal(recorded.length, 2);
    assert.equal(hist._batches.length, 1);
    assert.equal(hist._batches[0].length, 2);
    assert.equal(hist.getConnectionHistory().size, 2);
    assert.equal(devs._upserted.length, 1);
  });

  it('keeps cache, notifications, and devices unchanged when history commit fails', () => {
    const hist = makeHistory();
    hist.appendHistoryLogs = () => { throw new Error('database is full'); };
    const notif = makeNotifier();
    const devs = makeDevices();
    const io = makeIo();
    initRuntime({
      history: hist,
      notifier: notif,
      devices: devs,
      io,
      asus: makeAsus('00:11:22:33:44:55'),
      threatIntel: makeThreatIntel({ tag: 'test' }),
    });

    assert.throws(
      () => runtime.recordConnections([SESSION], Date.now(), 'yamaha', 'yamaha1'),
      /database is full/,
    );
    assert.equal(hist.getConnectionHistory().size, 0);
    assert.equal(notif._calls.notify.length, 0);
    assert.equal(notif._calls.newDevice.length, 0);
    assert.equal(devs._upserted.length, 0);
    assert.equal(io._emitted.length, 0);
  });

  it('persists the final value when a poll contains a duplicate natural key', () => {
    const { history: hist } = initRuntime();
    runtime.recordConnections([
      SESSION,
      { ...SESSION, sport: 54321 },
    ], Date.now(), 'yamaha', 'yamaha1');

    assert.equal(hist._batches[0].length, 1);
    assert.equal(hist._batches[0][0].sport, 54321);
  });

  it('resolves source identity once per IP within a poll', () => {
    let macLookups = 0;
    let metaLookups = 0;
    initRuntime({
      asus: { getClientMac: () => { macLookups++; return null; } },
      deviceId: { getNodeMeta: () => { metaLookups++; return { vendor: null, dnsName: null, mdnsName: null }; } },
    });

    runtime.recordConnections([
      SESSION,
      { ...SESSION, dst: '1.1.1.1' },
    ], Date.now(), 'yamaha', 'yamaha1');

    assert.equal(macLookups, 1);
    assert.equal(metaLookups, 1);
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
    // Old entry (base - 1): excluded from the emit
    hist.getConnectionHistory().set('old', { src: '192.168.1.1', dst: '1.1.1.1', dport: 53, proto: 'UDP', lastSeen: base - 1 });
    // New entry (base + 1): included in the emit
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
    // Only an old entry
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
    runtime.scheduleInspectEmit(); // the 2nd call is ignored
    runtime.scheduleInspectEmit(); // as is the 3rd
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

    runtime._resetInspectEmitTime(0); // makes every entry eligible
    runtime.scheduleInspectEmit();
    t.mock.timers.tick(1000);

    const emits = io._emitted.filter(e => e[0] === 'connections-update');
    assert.equal(emits[0][1].connections.length, 2);
  });
});
