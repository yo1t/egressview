'use strict';

const runtimeProfiler = require('./runtime-profiler');
const { createRouterRegistry } = require('./router-registry');
const { createRouterPollScheduler } = require('./router-poll-scheduler');
const { createYamahaAdapter } = require('./pollers/yamaha-adapter');
const { createCiscoAdapter } = require('./pollers/cisco-adapter');
const { createConntrackAdapter } = require('./pollers/conntrack-adapter');
const { MAX_ROUTERS, normalizeRouterRecord, publicRouter } = require('./router-config');
const { isAllowedRouterIp } = require('./utils');

function createRouterManager({
  records = [], tombstones = [], persist = () => {}, pollIntervalMs = 60_000,
  runtime, history, devices, beacons, enrichmentQueue, investigation, appState, io,
  createAdapter, schedulerOptions = {},
} = {}) {
  const registry = createRouterRegistry({ tombstones });
  const configs = new Map();
  const statuses = new Map();
  const previousKeys = new Map();

  function emitStatus() {
    io?.emit('routers-status', list());
  }

  async function runCycle(entry, { signal } = {}) {
    signal?.throwIfAborted();
    const { adapter, id, kind } = entry;
    if (!adapter.isEnabled() || !adapter.isReady()) throw new Error('router not connected');
    const sessions = await adapter.fetchSessions({ signal });
    signal?.throwIfAborted();
    enrichmentQueue?.queueConnectionEnrichment([...new Set(sessions.map(s => s.dst))]);
    const now = Date.now();
    if (adapter.needsArpRefresh()) {
      await adapter.refreshArp({ signal });
      signal?.throwIfAborted();
    }
    if (adapter.needsNdpRefresh()) {
      await adapter.refreshNdp({ signal });
      signal?.throwIfAborted();
      for (const [ip, mac] of adapter.getArpCache()) {
        const ipv6 = adapter.getNdpByMac(mac);
        if (ipv6?.length) devices?.observeDevice({ ip, mac, ipv6Addr: ipv6[0], lastSeen: now, source: `ndp:${id}` });
      }
    }

    const updated = runtimeProfiler.measureSync(`router.${kind}.poll.recordConnections`, () => {
      const result = new Map();
      for (const session of sessions) {
        signal?.throwIfAborted();
        const recorded = runtime.recordConnection(session, now, kind, id);
        result.set(recorded.key, recorded.entry);
      }
      return result;
    });

    const currentKeys = new Set(sessions.map(s => `${s.src}|${s.dst}|${s.dport}|${s.proto}`));
    const prior = previousKeys.get(id) || new Set();
    if (!appState?.inspectEnabled) {
      for (const session of sessions) {
        const key = `${session.src}|${session.dst}|${session.dport}|${session.proto}`;
        if (!prior.has(key)) {
          const entryData = history.getConnectionHistory().get(key);
          beacons?.appendEvent({
            src: session.src, dst: session.dst, dstHost: entryData?.dstHost || session.dst,
            dport: session.dport, proto: session.proto, seenAt: now, source: `poll:${id}`,
          });
        }
      }
    }
    signal?.throwIfAborted();
    previousKeys.set(id, currentKeys);
    history.pruneHistory();
    if (updated.size) io?.emit('connections-update', {
      connections: [...updated.values()], serverTime: now, partial: true, delta: true,
    });
    if (appState?.autoInvestigate) {
      for (const ip of new Set(sessions.map(s => s.src))) investigation?.enqueue(ip, runtime.resolveMacByIp(ip));
    }
    const status = statuses.get(id) || {};
    statuses.set(id, { ...status, ready: true, state: 'ready', message: '', sessionCount: sessions.length, lastSuccessAt: now, lastError: null });
    emitStatus();
  }

  const scheduler = createRouterPollScheduler({
    ...schedulerOptions,
    runCycle,
    pollIntervalMs,
    onTimeout: entry => entry.adapter.reconnect(),
  });

  function adapterFor(record) {
    if (createAdapter) return createAdapter(record);
    if (record.kind === 'yamaha') return createYamahaAdapter({ id: record.id });
    if (record.kind === 'cisco') return createCiscoAdapter({ id: record.id });
    return createConntrackAdapter({ id: record.id });
  }

  function startRouter(entry) {
    entry.adapter.connect(() => {
      entry.adapter.refreshArp()
        .catch(() => {})
        .finally(() => scheduler.start(entry));
    });
  }

  function configureAdapter(record, adapter) {
    adapter.configure({
      ip: record.ip,
      user: record.user,
      pass: record.pass,
      enablePass: record.enablePass,
      natDescriptor: record.nat,
      enabled: record.enabled,
      hostFp: record.hostFp,
      onStatus: state => {
        const current = statuses.get(record.id) || {};
        statuses.set(record.id, { ...current, ...state, ready: !!state.ready, lastError: state.ready ? null : (state.message || current.lastError) });
        emitStatus();
      },
      onSaveConfig: () => {
        const current = configs.get(record.id);
        if (!current) return;
        const previousHostFp = current.hostFp;
        current.hostFp = adapter.getHostFp();
        try { persist([...configs.values()], registry.tombstones()); }
        catch (err) {
          current.hostFp = previousHostFp;
          statuses.set(record.id, { ...statuses.get(record.id), lastError: err.message });
          throw err;
        }
      },
    });
  }

  function attach(record, adapter = adapterFor(record)) {
    configureAdapter(record, adapter);
    const entry = registry.register({ id: record.id, adapter, displayName: record.displayName });
    configs.set(record.id, record);
    statuses.set(record.id, { ready: false, state: record.enabled ? 'connecting' : 'disabled', message: '', sessionCount: 0 });
    history?.upsertRouterMetadata?.(record);
    if (record.enabled) startRouter(entry);
    return entry;
  }

  for (const record of records) attach({ ...record });

  function list() {
    const schedulerById = new Map(scheduler.status().map(s => [s.id, s]));
    return [...configs.values()].map(record => {
      const own = statuses.get(record.id) || {};
      const scheduled = schedulerById.get(record.id) || {};
      return publicRouter(record, {
        ...own,
        lastSuccessAt: own.lastSuccessAt || scheduled.lastSuccessAt,
        lastError: own.lastError || scheduled.lastError,
      });
    });
  }

  function getRecord(id) { return configs.get(id) || null; }

  function upsert(input) {
    const existing = input?.id ? configs.get(input.id) : null;
    if (input?.id && !existing) throw new Error('router not found');
    if (!existing && configs.size >= MAX_ROUTERS) throw new Error(`maximum ${MAX_ROUTERS} routers`);
    if (input?.ip && !isAllowedRouterIp(input.ip)) throw new Error('router IP must be private');
    const record = normalizeRouterRecord(input, {
      existing,
      knownIds: [...registry.allKnownIds()],
    });
    if (!record.ip || !record.user || !record.pass) throw new Error('IP, username and password are required');
    const adapter = adapterFor(record);
    const nextRecords = existing
      ? [...configs.values()].map(item => item.id === record.id ? record : item)
      : [...configs.values(), record];
    persist(nextRecords, registry.tombstones());

    if (existing) {
      scheduler.stop(existing.id);
      const old = registry.get(existing.id);
      old?.adapter.disconnect();
      registry.replace({ id: existing.id, adapter, displayName: record.displayName });
      const entry = registry.get(existing.id);
      configureAdapter(record, entry.adapter);
      configs.set(record.id, record);
      statuses.set(record.id, { ready: false, state: record.enabled ? 'connecting' : 'disabled', sessionCount: 0 });
      if (record.enabled) startRouter(entry);
      history?.upsertRouterMetadata?.(record);
    } else {
      attach(record, adapter);
    }
    emitStatus();
    return publicRouter(record, statuses.get(record.id));
  }

  function remove(id) {
    const existing = configs.get(id);
    if (!existing) return false;
    persist(
      [...configs.values()].filter(record => record.id !== id),
      [...new Set([...registry.tombstones(), id])],
    );
    scheduler.stop(id);
    registry.get(id)?.adapter.disconnect();
    registry.unregister(id);
    configs.delete(id);
    statuses.delete(id);
    previousKeys.delete(id);
    history?.tombstoneRouterMetadata?.(id);
    emitStatus();
    return true;
  }

  async function detect(input) {
    if (!isAllowedRouterIp(input?.ip)) throw new Error('router IP must be private');
    const existing = input?.id ? configs.get(input.id) : null;
    const kind = input?.kind || existing?.kind;
    if (!['yamaha', 'cisco', 'conntrack'].includes(kind)) throw new Error('unsupported router kind');
    const adapter = adapterFor({ id: existing?.id || `${kind}-detect`, kind });
    const pass = input?.pass || existing?.pass || '';
    if (!input?.ip || !input?.user || !pass) throw new Error('IP, username and password are required');
    return adapter.detect({
      ip: input.ip,
      user: input.user,
      pass,
      enablePass: input.enablePass || existing?.enablePass || '',
      expectedHostFp: existing?.ip === input.ip ? existing.hostFp : '',
      natCandidates: kind === 'yamaha' ? [input.nat || existing?.nat || '100'] : undefined,
    });
  }

  function stopAll() {
    scheduler.stopAll();
    for (const entry of registry.list()) entry.adapter.disconnect();
  }

  return { list, getRecord, upsert, remove, detect, stopAll, registry, scheduler };
}

module.exports = { createRouterManager };
