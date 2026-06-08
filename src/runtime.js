// Runtime: connection recording, INSPECT session handling, MAC resolution.
// Dependencies are injected at startup via init() to enable unit testing.
'use strict';

// ─── Injected dependencies ────────────────────────────────────────────────────
let _io, _history, _enrichment, _threatIntel, _notifier, _deviceId, _devices;
let _asus, _yamaha, _dhcpdSyslog;

// ─── Module state ─────────────────────────────────────────────────────────────
let knownMacs = new Set();
let inspectEmitTimer = null;
let lastInspectEmitTime = Date.now(); // 差分 push 用: 前回 emit 以降の更新分のみ送信

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
  _dhcpdSyslog = deps.dhcpdSyslog;
}

// ─── Debounced emit for [INSPECT] sessions ────────────────────────────────────

function scheduleInspectEmit() {
  if (inspectEmitTimer) return;
  inspectEmitTimer = setTimeout(() => {
    inspectEmitTimer = null;
    const now = Date.now();
    // 差分 push: 前回 emit 以降に lastSeen が更新されたエントリのみ送信
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

// テスト用: lastInspectEmitTime をリセット
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
  return _yamaha.getArpMac(ip);
}

// ─── Core connection record helper ───────────────────────────────────────────

/**
 * Enrich a session from caches, upsert into connectionHistory, notify.
 *
 * @param {object} session  - { src, sport, dst, dport, proto, ttl? }
 * @param {number} [now]    - timestamp override (defaults to Date.now())
 * @param {string} [source] - inventory source tag ('nat' | 'inspect')
 * @returns {{ entry, key, isNew }}
 */
function recordConnection(session, now = Date.now(), source = 'nat') {
  const { src, sport, dst, dport, proto } = session;

  const srcMac  = resolveMacByIp(src);
  const srcMeta = _deviceId.getNodeMeta(src, srcMac);

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
  };

  const connectionHistory = _history.getConnectionHistory();
  const key      = `${src}|${dst}|${dport}|${proto}`;
  const existing = connectionHistory.get(key);
  const isNew    = !existing;
  const entry    = { ...enriched, firstSeen: existing?.firstSeen ?? now, lastSeen: now };
  connectionHistory.set(key, entry);

  if (entry.threat) _notifier.notify(entry);
  if (entry.srcMac && !knownMacs.has(entry.srcMac)) {
    knownMacs.add(entry.srcMac);
    _notifier.notifyNewDevice(entry);
    _io.emit('new-device', entry);
  }
  if (isNew) _history.appendHistoryLog(entry);

  _devices.observeDevice({
    ip:        entry.src,
    mac:       entry.srcMac      || null,
    vendor:    entry.srcVendor   || null,
    dnsName:   entry.srcDnsName  || null,
    mdnsName:  entry.srcMdnsName || null,
    firstSeen: entry.firstSeen,
    lastSeen:  entry.lastSeen,
    source,
  });

  return { entry, key, isNew };
}

// ─── [INSPECT] session handler ────────────────────────────────────────────────

function handleInspectSession(session) {
  const now = Date.now();
  const { dst } = session;

  const rdap = _enrichment.getRdapCache().get(dst);
  const geo  = _enrichment.getGeoCache().get(dst);

  const { key } = recordConnection(session, now, 'inspect');

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
  handleInspectSession,
  getKnownMacs,
  setKnownMacs,
  _resetInspectEmitTime,
};
