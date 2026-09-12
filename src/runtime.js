// Runtime: connection recording, INSPECT session handling, MAC resolution.
// Dependencies are injected at startup via init() to enable unit testing.
'use strict';

// ─── Injected dependencies ────────────────────────────────────────────────────
let _io, _history, _enrichment, _threatIntel, _notifier, _deviceId, _devices;
let _asus, _yamaha, _cisco, _dhcpdSyslog;
let _beacons = null; // optional: injected when beacons module is available
let _routerRegistry = null;

// ─── Module state ─────────────────────────────────────────────────────────────
let knownMacs = new Set();
let inspectEmitTimer = null;
let lastInspectEmitTime = Date.now(); // for delta push: only entries updated since the previous emit

/**
 * Inject all external dependencies.
 * Must be called once before any other export.
 *
 * @param {{
 *   io, history, enrichment, threatIntel, notifier, deviceId, devices,
 *   asus, yamaha, dhcpdSyslog
 * }} deps
 */
function init(deps) {
  _io          = deps.io;
  _history     = deps.history;
  _enrichment  = deps.enrichment;
  _threatIntel = deps.threatIntel;
  _notifier    = deps.notifier;
  _deviceId    = deps.deviceId;
  _devices     = deps.devices;
  _asus        = deps.asus;
  _yamaha      = deps.yamaha;
  _cisco       = deps.cisco || null;
  _dhcpdSyslog = deps.dhcpdSyslog;
  _beacons     = deps.beacons || null;
  _routerRegistry = deps.routerRegistry || null;
}

function setRouterRegistry(registry) { _routerRegistry = registry || null; }

// ─── Debounced emit for [INSPECT] sessions ────────────────────────────────────

function scheduleInspectEmit() {
  if (inspectEmitTimer) return;
  inspectEmitTimer = setTimeout(() => {
    inspectEmitTimer = null;
    const now = Date.now();
    // Delta push: send only entries whose lastSeen was updated since the previous emit
    const deltaConns = [..._history.getConnectionHistory().values()]
      .filter(c => c.lastSeen > lastInspectEmitTime);
    lastInspectEmitTime = now;
    if (!deltaConns.length) return;
    _io.emit('connections-update', {
      connections: deltaConns,
      serverTime:  now,
      partial:     true,
      delta:       true,
    });
  }, 1000);
}

// Test helper: reset lastInspectEmitTime
function _resetInspectEmitTime(t) { lastInspectEmitTime = t ?? Date.now(); }

// ─── MAC resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a MAC address for a given IP using all available sources:
 * ASUS DHCP table → DHCPD syslog cache → Yamaha ARP cache.
 * @param {string} ip
 * @returns {string|null}
 */
function resolveMacByIp(ip) {
  if (!ip) return null;
  const asusMac = _asus.getClientMac(ip);
  if (asusMac) return asusMac;
  const dhcpdMac = _dhcpdSyslog.getMacByIp(ip);
  if (dhcpdMac) return dhcpdMac;
  const yamahaMac = _yamaha.getArpMac(ip);
  if (yamahaMac) return yamahaMac;
  const ciscoMac = _cisco?.getArpMac(ip);
  if (ciscoMac) return ciscoMac;
  for (const entry of _routerRegistry?.list?.() || []) {
    const mac = entry.adapter.getArpMac(ip);
    if (mac) return mac;
  }
  return null;
}

// ─── Core connection record helper ───────────────────────────────────────────

const KNOWN_SOURCES = new Set(['yamaha', 'cisco']);

// Mirror the SQL CASE logic so in-memory Map and DB stay in sync.
function _mergeSource(existing, incoming) {
  if (!existing) return incoming;
  if (existing === incoming) return existing;
  if (KNOWN_SOURCES.has(existing) && KNOWN_SOURCES.has(incoming)) return 'yamaha+cisco';
  return existing;
}

/**
 * Enrich a session from caches, upsert into connectionHistory, notify.
 *
 * @param {object} session  - { src, sport, dst, dport, proto, ttl? }
 * @param {number} [now]    - timestamp override (defaults to Date.now())
 * @param {string} [source] - inventory source tag ('nat' | 'inspect')
 * @returns {{ entry, key, isNew }}
 */
function recordConnection(session, now = Date.now(), source = 'nat', routerId = '') {
  const record = _prepareConnection(session, now, source, routerId);
  const { entry, key, isNew, observerAdded } = record;
  _cacheConnection(key, entry);
  _publishConnection(record);
  if (isNew || observerAdded) _history.appendHistoryLog(entry);
  _observeDevices([record], source);
  return { entry, key, isNew };
}

function _prepareConnection(session, now, source, routerId, staged = null, sourceMeta = null) {
  const { src, sport, dst, dport, proto } = session;

  let sourceIdentity = sourceMeta?.get(src);
  if (!sourceIdentity) {
    const srcMac = resolveMacByIp(src);
    sourceIdentity = { srcMac, srcMeta: _deviceId.getNodeMeta(src, srcMac) };
    sourceMeta?.set(src, sourceIdentity);
  }
  const { srcMac, srcMeta } = sourceIdentity;

  // Resolve dstHost: prefer dnsmasq > non-junk PTR > raw IP
  const dnsCached = _enrichment.getDnsCache().get(dst);
  let dstHost = dst;
  if (dnsCached && dnsCached.expires > now) {
    if (dnsCached.source === 'dnsmasq' || !_enrichment.isPtrJunk(dnsCached.host)) {
      dstHost = dnsCached.host;
    }
  }

  const rdap = _enrichment.getRdapCache().get(dst);
  const geo  = _enrichment.getGeoCache().get(dst);

  const enriched = {
    src, sport: sport ?? null, dst, dport, proto,
    srcMac,
    srcVendor:   srcMeta.vendor,
    srcDnsName:  srcMeta.dnsName,
    srcMdnsName: srcMeta.mdnsName,
    dstHost,
    country: rdap?.country || geo?.countryCode || null,
    org:     rdap?.org     || null,
    lat:     geo?.lat  ?? null,
    lon:     geo?.lon  ?? null,
    city:    geo?.city ?? null,
    threat:  _threatIntel.matchThreatIntel(dst, dstHost) || null,
    ttl:     session.ttl ?? 0,
    // Only an endpoint agent knows these. A router poll leaves them null, and
    // the upsert keeps whatever an agent supplied earlier for the same flow.
    agentHost: session.agentHost ?? null,
    process:   session.process   ?? null,
    pid:       session.pid       ?? null,
  };

  const connectionHistory = _history.getConnectionHistory();
  const key      = `${src}|${dst}|${dport}|${proto}`;
  const existing = staged?.get(key) || connectionHistory.get(key) || _history.getConnection?.(key) || null;
  const isNew    = !existing;
  const mergedSource = _mergeSource(existing?.source, source);
  const incomingObservedBy = routerId ? [routerId] : (_history.observationIdsForSource?.(source) || []);
  const observerAdded = incomingObservedBy.some(id => !existing?.observedBy?.includes(id));
  const observedBy = [...new Set([...(existing?.observedBy || []), ...incomingObservedBy])].sort();
  // Pollers that know the session's real creation time (Cisco verbose NAT
  // output) pass firstSeenHint so firstSeen predates the first observation.
  const hint = session.firstSeenHint;
  const firstSeen = existing?.firstSeen
    ?? (Number.isFinite(hint) && hint > 0 && hint <= now ? hint : now);
  const entry    = { ...enriched, source: mergedSource, observedBy, firstSeen, lastSeen: now };
  staged?.set(key, entry);
  return { entry, key, isNew, observerAdded };
}

function _cacheConnection(key, entry) {
  if (_history.cacheConnection) _history.cacheConnection(key, entry);
  else _history.getConnectionHistory().set(key, entry);
}

function _publishConnection({ entry }) {
  if (entry.threat) _notifier.notify(entry);
  if (entry.srcMac && !knownMacs.has(entry.srcMac)) {
    knownMacs.add(entry.srcMac);
    _notifier.notifyNewDevice(entry);
    _io.emit('new-device', entry);
  }
}

function _deviceObservation(entry, source) {
  return {
    ip:        entry.src,
    mac:       entry.srcMac      || null,
    vendor:    entry.srcVendor   || null,
    dnsName:   entry.srcDnsName  || null,
    mdnsName:  entry.srcMdnsName || null,
    firstSeen: entry.firstSeen,
    lastSeen:  entry.lastSeen,
    source,
  };
}

function _observeDevices(records, source) {
  const byIp = new Map();
  for (const { entry } of records) {
    const next = _deviceObservation(entry, source);
    const previous = byIp.get(next.ip);
    if (previous) {
      next.firstSeen = Math.min(previous.firstSeen, next.firstSeen);
      next.lastSeen = Math.max(previous.lastSeen, next.lastSeen);
    }
    byIp.set(next.ip, next);
  }
  const observations = [...byIp.values()];
  if (_devices.observeDevices) _devices.observeDevices(observations);
  else for (const observation of observations) _devices.observeDevice(observation);
}

/**
 * Record one router poll. Durable history is committed before any in-memory
 * cache, notification, or device side effect becomes visible.
 */
function recordConnections(sessions, now = Date.now(), source = 'nat', routerId = '') {
  if (!sessions?.length) return [];
  const staged = new Map();
  const sourceMeta = new Map();
  const records = sessions.map(session => _prepareConnection(session, now, source, routerId, staged, sourceMeta));
  const persistByKey = new Map();
  for (const record of records) {
    if (record.isNew || record.observerAdded || persistByKey.has(record.key)) {
      persistByKey.set(record.key, staged.get(record.key));
    }
  }

  const entries = [...persistByKey.values()];
  if (entries.length) {
    if (_history.appendHistoryLogs) _history.appendHistoryLogs(entries);
    else for (const entry of entries) _history.appendHistoryLog(entry);
  }

  for (const [key, entry] of staged) _cacheConnection(key, entry);
  for (const record of records) _publishConnection(record);
  _observeDevices(records, source);
  return records.map(({ entry, key, isNew }) => ({ entry, key, isNew }));
}

// ─── [INSPECT] session handler ────────────────────────────────────────────────

function handleInspectSession(session) {
  const now = Date.now();
  const { dst } = session;

  const rdap = _enrichment.getRdapCache().get(dst);
  const geo  = _enrichment.getGeoCache().get(dst);

  const { key, entry } = recordConnection(session, now, 'inspect');

  // Record precise-timestamp event for beacon detection
  if (_beacons) {
    _beacons.appendEvent({
      src: entry.src, dst: entry.dst, dstHost: entry.dstHost,
      dport: entry.dport, proto: entry.proto,
      seenAt: now, source: 'inspect',
    });
  }

  // Async: enrich missing geo/rdap/ptr in background (fire-and-forget)
  if (!rdap || !geo) {
    const connectionHistory = _history.getConnectionHistory();
    Promise.allSettled([
      _enrichment.reverseDns(dst),
      _enrichment.lookupRdap(dst),
      _enrichment.lookupGeoBatch([dst]),
    ]).then(() => {
      const e = connectionHistory.get(key);
      if (!e) return;
      const dc2  = _enrichment.getDnsCache().get(dst);
      const now2 = Date.now();
      if (dc2 && dc2.expires > now2) {
        if (dc2.source === 'dnsmasq' || !_enrichment.isPtrJunk(dc2.host)) e.dstHost = dc2.host;
      }
      const r2 = _enrichment.getRdapCache().get(dst);
      const g2 = _enrichment.getGeoCache().get(dst);
      e.country = r2?.country || g2?.countryCode || e.country;
      e.org     = r2?.org     || e.org;
      e.lat     = g2?.lat  ?? e.lat;
      e.lon     = g2?.lon  ?? e.lon;
      e.city    = g2?.city ?? e.city;
    }).catch(() => {});
  }

  scheduleInspectEmit();
}

// ─── Known MACs ───────────────────────────────────────────────────────────────

function getKnownMacs()    { return knownMacs; }
function setKnownMacs(set) { knownMacs = set; }

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  scheduleInspectEmit,
  resolveMacByIp,
  recordConnection,
  recordConnections,
  handleInspectSession,
  getKnownMacs,
  setKnownMacs,
  setRouterRegistry,
  _resetInspectEmitTime,
};
