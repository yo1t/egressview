'use strict';

let _history = null;
let _enrichment = null;
let _io = null;
let _logger = console;

const enrichmentQueue = new Set();
let enrichmentQueueRunning = false;

function init(deps) {
  _history = deps.history;
  _enrichment = deps.enrichment;
  _io = deps.io;
  _logger = deps.logger || console;
}

function refreshCachedEnrichmentForDestinations(ips) {
  const ipSet = new Set(ips);
  const updated = [];
  for (const entry of _history.getConnectionHistory().values()) {
    if (!ipSet.has(entry.dst)) continue;

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
  for (const ip of ips) enrichmentQueue.add(ip);
  if (enrichmentQueueRunning) return;
  enrichmentQueueRunning = true;
  setImmediate(runConnectionEnrichmentQueue);
}

async function runConnectionEnrichmentQueue() {
  try {
    while (enrichmentQueue.size) {
      const batch = [...enrichmentQueue].slice(0, 250);
      batch.forEach(ip => enrichmentQueue.delete(ip));
      await Promise.allSettled(batch.map(ip => _enrichment.reverseDns(ip)));
      await _enrichment.lookupRdapBatch(batch);
      await _enrichment.lookupGeoBatch(batch);
      refreshCachedEnrichmentForDestinations(batch);
      if (enrichmentQueue.size) await new Promise(r => setTimeout(r, 50));
    }
  } catch (err) {
    _logger.error('[enrichment] background queue error:', err.message);
  } finally {
    enrichmentQueueRunning = false;
    if (enrichmentQueue.size) queueConnectionEnrichment([]);
  }
}

function _resetForTest() {
  enrichmentQueue.clear();
  enrichmentQueueRunning = false;
  _history = null;
  _enrichment = null;
  _io = null;
  _logger = console;
}

module.exports = {
  init,
  queueConnectionEnrichment,
  refreshCachedEnrichmentForDestinations,
  _resetForTest,
};
