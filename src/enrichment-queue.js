'use strict';

const runtimeProfiler = require('./runtime-profiler');

let _history = null;
let _enrichment = null;
let _io = null;
let _logger = console;

const FOREGROUND_BATCH_SIZE = 250;
const BACKGROUND_BATCH_SIZE = 25;
const BACKGROUND_RDAP_CONCURRENCY = 2;
const BACKGROUND_DELAY_MS = 1000;

const foregroundQueue = new Set();
const backgroundQueue = new Set();
let enrichmentQueueRunning = false;
let backgroundHistoryIndex = null;
let backgroundDelayMs = BACKGROUND_DELAY_MS;
let delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let wakeForeground = null;
let idleWaiters = [];

function init(deps) {
  _history = deps.history;
  _enrichment = deps.enrichment;
  _io = deps.io;
  _logger = deps.logger || console;
  backgroundDelayMs = deps.backgroundDelayMs ?? BACKGROUND_DELAY_MS;
  delay = deps.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
}

function buildHistoryDestinationIndex() {
  const index = new Map();
  for (const entry of _history.getConnectionHistory().values()) {
    const entries = index.get(entry.dst) || [];
    entries.push(entry);
    index.set(entry.dst, entries);
  }
  return index;
}

function refreshCachedEnrichmentForDestinations(ips, entriesByDestination = null) {
  const entries = entriesByDestination
    ? ips.flatMap(ip => entriesByDestination.get(ip) || [])
    : _history.getConnectionHistory().values();
  const ipSet = entriesByDestination ? null : new Set(ips);
  const updated = [];
  for (const entry of entries) {
    if (ipSet && !ipSet.has(entry.dst)) continue;

    let changed = false;
    const setIfChanged = (field, value) => {
      if (value == null || entry[field] === value) return;
      entry[field] = value;
      changed = true;
    };

    const now = Date.now();
    const dnsCached = _enrichment.getDnsCache().get(entry.dst);
    if (dnsCached && dnsCached.expires > now) {
      if (dnsCached.source === 'dnsmasq' || !_enrichment.isPtrJunk(dnsCached.host)) {
        setIfChanged('dstHost', dnsCached.host);
      }
    }
    const rdap = _enrichment.getRdapCache().get(entry.dst);
    const geo = _enrichment.getGeoCache().get(entry.dst);
    setIfChanged('country', rdap?.country || geo?.countryCode);
    setIfChanged('org', rdap?.org);
    setIfChanged('lat', geo?.lat);
    setIfChanged('lon', geo?.lon);
    setIfChanged('city', geo?.city);
    if (!changed) continue;

    _history.appendHistoryLog(entry);
    updated.push(entry);
  }
  if (updated.length) {
    _io.emit('connections-update', { connections: updated, serverTime: Date.now(), partial: true, delta: true });
  }
}

function queueConnectionEnrichment(ips) {
  for (const ip of ips) {
    backgroundQueue.delete(ip);
    foregroundQueue.add(ip);
  }
  updateQueueGauges();
  if (wakeForeground) wakeForeground();
  startQueue();
}

function queueStaleConnectionEnrichment(ips) {
  for (const ip of ips) {
    if (!foregroundQueue.has(ip)) backgroundQueue.add(ip);
  }
  updateQueueGauges();
  startQueue();
}

function updateQueueGauges() {
  runtimeProfiler.setGauge('enrichment.foregroundQueued', foregroundQueue.size);
  runtimeProfiler.setGauge('enrichment.staleQueued', backgroundQueue.size);
}

function startQueue() {
  if (enrichmentQueueRunning) return;
  enrichmentQueueRunning = true;
  setImmediate(runConnectionEnrichmentQueue);
}

function takeBatch(queue, size) {
  const batch = [];
  for (const ip of queue) {
    batch.push(ip);
    queue.delete(ip);
    if (batch.length === size) break;
  }
  updateQueueGauges();
  return batch;
}

async function waitForBackgroundDelay() {
  if (backgroundDelayMs <= 0 || foregroundQueue.size) return;
  let resolveForeground;
  const foregroundReady = new Promise(resolve => { resolveForeground = resolve; });
  wakeForeground = resolveForeground;
  try {
    await Promise.race([delay(backgroundDelayMs), foregroundReady]);
  } finally {
    if (wakeForeground === resolveForeground) wakeForeground = null;
  }
}

async function runConnectionEnrichmentQueue() {
  try {
    while (foregroundQueue.size || backgroundQueue.size) {
      const isForeground = foregroundQueue.size > 0;
      const batch = takeBatch(
        isForeground ? foregroundQueue : backgroundQueue,
        isForeground ? FOREGROUND_BATCH_SIZE : BACKGROUND_BATCH_SIZE,
      );
      if (isForeground) {
        await runtimeProfiler.measureAsync('enrichment.live.ptr', () =>
          Promise.allSettled(batch.map(ip => _enrichment.reverseDns(ip))));
        await runtimeProfiler.measureAsync('enrichment.live.rdap', () =>
          _enrichment.lookupRdapBatch(batch));
      } else {
        // Stale startup work only refreshes persisted caches; PTR is populated by live polling.
        await runtimeProfiler.measureAsync('enrichment.stale.rdap', () =>
          _enrichment.lookupRdapBatch(batch, BACKGROUND_RDAP_CONCURRENCY));
      }
      await runtimeProfiler.measureAsync(`enrichment.${isForeground ? 'live' : 'stale'}.geo`, () =>
        _enrichment.lookupGeoBatch(batch));
      if (!isForeground && !backgroundHistoryIndex) {
        backgroundHistoryIndex = runtimeProfiler.measureSync(
          'enrichment.stale.historyIndex', buildHistoryDestinationIndex);
      }
      runtimeProfiler.measureSync(`enrichment.${isForeground ? 'live' : 'stale'}.apply`, () =>
        refreshCachedEnrichmentForDestinations(batch, isForeground ? null : backgroundHistoryIndex));
      if (!isForeground && backgroundQueue.size) await waitForBackgroundDelay();
    }
  } catch (err) {
    _logger.error('[enrichment] background queue error:', err.message);
  } finally {
    enrichmentQueueRunning = false;
    if (!backgroundQueue.size) backgroundHistoryIndex = null;
    updateQueueGauges();
    if (foregroundQueue.size || backgroundQueue.size) {
      startQueue();
    } else {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach(resolve => resolve());
    }
  }
}

function _waitForIdleForTest() {
  if (!enrichmentQueueRunning && !foregroundQueue.size && !backgroundQueue.size) {
    return Promise.resolve();
  }
  return new Promise(resolve => idleWaiters.push(resolve));
}

function _resetForTest() {
  foregroundQueue.clear();
  backgroundQueue.clear();
  enrichmentQueueRunning = false;
  backgroundHistoryIndex = null;
  backgroundDelayMs = BACKGROUND_DELAY_MS;
  delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (wakeForeground) wakeForeground();
  wakeForeground = null;
  idleWaiters.forEach(resolve => resolve());
  idleWaiters = [];
  _history = null;
  _enrichment = null;
  _io = null;
  _logger = console;
}

module.exports = {
  init,
  queueConnectionEnrichment,
  queueStaleConnectionEnrichment,
  refreshCachedEnrichmentForDestinations,
  _waitForIdleForTest,
  _resetForTest,
};
