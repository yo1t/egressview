'use strict';

const runtimeProfiler = require('./runtime-profiler');

let _appState = null;
let _beacons = null;
let _beaconDetector = null;
let _threatIntel = null;
let _enrichment = null;
let _logger = console;

let beaconScanTimer = null;

function init(deps) {
  _appState = deps.appState;
  _beacons = deps.beacons;
  _beaconDetector = deps.beaconDetector;
  _threatIntel = deps.threatIntel;
  _enrichment = deps.enrichment;
  _logger = deps.logger || console;
}

function runBeaconScan() {
  const cfg = _appState.beaconConfig;
  if (!cfg.enabled) return;

  return runtimeProfiler.measureSync('beacons.scan', () => {
    const events = _beacons.getEvents();
    const detected = _beaconDetector.detectBeacons(events, {
      minObs: cfg.minObs,
      maxCov: cfg.maxCov,
      minIntervalMs: cfg.minIntervalMs,
      maxIntervalMs: cfg.maxIntervalMs,
      whitelistDomains: cfg.whitelistDomains,
    });

    const allow = cfg.orgAllowlist.map(o => o.toLowerCase());
    const candidates = detected.filter(c => {
      if (_threatIntel.matchThreatIntel(c.dst, c.dstHost || c.dst)) return true;
      const org = (_enrichment.getRdapCache().get(c.dst)?.org || '').toLowerCase();
      return !org || !allow.some(a => org.includes(a));
    });

    for (const c of candidates) _beacons.upsertBeacon(c);
    const removed = _beacons.pruneCandidatesNotIn(
      candidates.map(c => `${c.src}|${c.dst}|${c.dport}|${c.proto}`)
    );
    const pruned = _beacons.pruneEvents();
    _logger.info(`[beacons] scan: ${candidates.length} candidate(s) from ${events.length} events ` +
                 `(${detected.length - candidates.length} org-allowlisted, ${removed} stale removed, ${pruned} old events pruned)`);
  });
}

function scheduleBeaconScan() {
  if (beaconScanTimer) clearInterval(beaconScanTimer);
  beaconScanTimer = setInterval(runBeaconScan, _appState.beaconConfig.scanIntervalMs);
}

function stopBeaconScan() {
  if (beaconScanTimer) {
    clearInterval(beaconScanTimer);
    beaconScanTimer = null;
  }
}

function _resetForTest() {
  stopBeaconScan();
  _appState = null;
  _beacons = null;
  _beaconDetector = null;
  _threatIntel = null;
  _enrichment = null;
  _logger = console;
}

module.exports = {
  init,
  runBeaconScan,
  scheduleBeaconScan,
  stopBeaconScan,
  _resetForTest,
};
