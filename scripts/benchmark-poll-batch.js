#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../src/history');
const devices = require('../src/devices');
const runtime = require('../src/runtime');

const count = Number.parseInt(process.argv[2] || '600', 10);
if (!Number.isSafeInteger(count) || count < 1) {
  console.error('Usage: node scripts/benchmark-poll-batch.js [positive session count]');
  process.exit(1);
}

const now = Date.now();
const entries = Array.from({ length: count }, (_, index) => ({
  src: `192.168.41.${10 + (index % 24)}`,
  sport: 10_000 + index,
  dst: `198.51.${Math.floor(index / 250)}.${1 + (index % 250)}`,
  dport: index % 3 ? 443 : 53,
  proto: index % 3 ? 'TCP' : 'UDP',
  firstSeen: now,
  lastSeen: now,
  source: 'yamaha',
  observedBy: ['yamaha-benchmark'],
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-poll-batch-'));

function elapsedMs(fn) {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function removeDb(dbPath) {
  history.closeDb();
  devices.closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix); } catch {}
  }
}

function historyRun(name, write) {
  const dbPath = path.join(root, `${name}.db`);
  history._initForTest(dbPath, { sourceRouterMap: { yamaha: 'yamaha-benchmark' } });
  const ms = elapsedMs(() => write(entries));
  removeDb(dbPath);
  return ms;
}

function deviceRun(name, write) {
  const dbPath = path.join(root, `${name}.db`);
  devices.initDb(dbPath);
  const observations = entries.map(entry => ({
    ip: entry.src,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    source: 'yamaha',
  }));
  const ms = elapsedMs(() => write(observations));
  removeDb(dbPath);
  return ms;
}

function runtimeRun(name, write) {
  const dbPath = path.join(root, `${name}.db`);
  history._initForTest(dbPath, { sourceRouterMap: { yamaha: 'yamaha-benchmark' } });
  devices.initDb(dbPath);
  runtime.setKnownMacs(new Set());
  runtime.init({
    io: { emit() {} },
    history,
    devices,
    enrichment: {
      getDnsCache: () => new Map(),
      getRdapCache: () => new Map(),
      getGeoCache: () => new Map(),
      isPtrJunk: () => false,
    },
    threatIntel: { matchThreatIntel: () => null },
    notifier: { notify() {}, notifyNewDevice() {} },
    deviceId: { getNodeMeta: () => ({ vendor: null, dnsName: null, mdnsName: null }) },
    asus: { getClientMac: () => null },
    dhcpdSyslog: { getMacByIp: () => null },
    yamaha: { getArpMac: () => null },
    cisco: { getArpMac: () => null },
    routerRegistry: { list: () => [] },
  });
  const ms = elapsedMs(() => write(entries));
  const consistency = history.checkObservationConsistency();
  removeDb(dbPath);
  return { ms, consistency };
}

try {
  const historySingle = historyRun('history-single', rows => rows.forEach(history.appendHistoryLog));
  const historyBatch = historyRun('history-batch', rows => history.appendHistoryLogs(rows));
  const devicesSingle = deviceRun('devices-single', rows => rows.forEach(devices.observeDevice));
  const devicesByIp = deviceRun('devices-batch', rows => {
    const unique = new Map(rows.map(row => [row.ip, row]));
    devices.observeDevices([...unique.values()]);
  });
  const runtimeSingle = runtimeRun('runtime-single', rows => {
    rows.forEach(row => runtime.recordConnection(row, now, 'yamaha', 'yamaha-benchmark'));
  });
  const runtimeBatch = runtimeRun('runtime-batch', rows => {
    runtime.recordConnections(rows, now, 'yamaha', 'yamaha-benchmark');
  });

  console.log(JSON.stringify({
    sessions: count,
    uniqueDevices: new Set(entries.map(entry => entry.src)).size,
    historySingleMs: Number(historySingle.toFixed(2)),
    historyBatchMs: Number(historyBatch.toFixed(2)),
    historySpeedup: Number((historySingle / historyBatch).toFixed(2)),
    devicesSingleMs: Number(devicesSingle.toFixed(2)),
    devicesBatchMs: Number(devicesByIp.toFixed(2)),
    devicesSpeedup: Number((devicesSingle / devicesByIp).toFixed(2)),
    runtimeSingleMs: Number(runtimeSingle.ms.toFixed(2)),
    runtimeBatchMs: Number(runtimeBatch.ms.toFixed(2)),
    runtimeSpeedup: Number((runtimeSingle.ms / runtimeBatch.ms).toFixed(2)),
    runtimeBatchUnder250Ms: runtimeBatch.ms <= 250,
    observationConsistency: {
      missing: runtimeBatch.consistency.missingObservations,
      orphans: runtimeBatch.consistency.orphanObservations,
      underMerged: runtimeBatch.consistency.underMerged,
      kindMismatches: runtimeBatch.consistency.kindMismatches,
    },
  }, null, 2));
} finally {
  history.closeDb();
  devices.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
