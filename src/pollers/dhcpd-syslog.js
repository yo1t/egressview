// [DHCPD] syslog poller: real-time IP→MAC tracking from Yamaha DHCP events
// Format: [DHCPD] LAN1(port10) Allocates/Extends 192.168.1.27: aa:bb:cc:dd:ee:ff
'use strict';

const { createTailPoller } = require('./tail-helper');
const logger = require('../logger');

const DEFAULT_LOG_FILE = '/var/log/yamaha-router.log';
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — evict stale leases

// How long to let a freshly started collector stay quiet before saying so.
// A home network can go fifteen minutes without a DHCP event; it cannot go
// hours, and it certainly does not go days.
const SILENCE_GRACE_MS = 15 * 60 * 1000;
// And how often to repeat it. Once would scroll away; every few minutes would
// be noise the operator learns to skip.
const SILENCE_REPEAT_MS = 6 * 60 * 60 * 1000;

// [DHCPD] <iface> Allocates/Extends <ip>: <mac>
const DHCPD_RE = /\[DHCPD\]\s+\S+\s+(?:Allocates|Extends)\s+([\d.]+):\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/i;

let logFile      = DEFAULT_LOG_FILE;
let dhcpdEnabled = true;
let onLease      = () => {}; // callback: ({ ip, mac }) => void
// Enabled and receiving nothing is the state this collector spent months in
// without saying so. It logged "tailing <file>" at every start, which reads
// like success, and then never mentioned that no line ever arrived: on the
// production Hub the file was zero bytes and had never held a [DHCPD] entry.
//
// A collector that collects nothing has to be the one to say so. Nobody goes
// looking for an absence.
let leasesSeen   = 0;
let startedAt    = 0;
let silenceTimer = null;

// ip → { mac, seenAt }
const ipMacMap = new Map();

function configure(cfg) {
  if (cfg.logFile !== undefined) logFile      = cfg.logFile || DEFAULT_LOG_FILE;
  if (cfg.enabled !== undefined) dhcpdEnabled = cfg.enabled;
  if (cfg.onLease)               onLease      = cfg.onLease;
}

function parseLine(line) {
  if (!line.includes('[DHCPD]')) return null;
  const m = line.match(DHCPD_RE);
  if (!m) return null;
  return { ip: m[1], mac: m[2].toLowerCase() };
}

const poller = createTailPoller({
  name:       'dhcpd-syslog',
  getLogFile: () => logFile,
  isEnabled:  () => dhcpdEnabled,
  onLine: line => {
    const entry = parseLine(line);
    if (!entry) return;
    ipMacMap.set(entry.ip, { mac: entry.mac, seenAt: Date.now() });
    leasesSeen += 1;
    try { onLease(entry); } catch {}
  },
});

/**
 * Say, on a slow beat, that this is switched on and nothing is arriving.
 *
 * The router has to be told to send its syslog here, and nothing in the setup
 * asks for that, so the default state of this collector is silence. The Hub
 * now reads the same leases by polling the router directly, which needs no
 * router-side configuration -- so the message says what is lost by leaving
 * this unconfigured, which is only immediacy.
 */
function _checkSilence() {
  if (!dhcpdEnabled || leasesSeen > 0) return;
  if (Date.now() - startedAt < SILENCE_GRACE_MS) return;
  logger.warn(
    `[dhcpd-syslog] switched on, and no [DHCPD] line has arrived from ${logFile}. `
    + 'The router has to be configured to send its syslog here. '
    + 'Leases are still read by polling the router, so nothing is missing -- '
    + 'only the few minutes between a lease being issued and the next poll.'
  );
}

function start() {
  startedAt = Date.now();
  leasesSeen = 0;
  poller.start();
  if (silenceTimer) clearInterval(silenceTimer);
  if (dhcpdEnabled) {
    silenceTimer = setInterval(_checkSilence, SILENCE_REPEAT_MS);
    silenceTimer.unref?.();
    // The first check is on the grace period, not on the repeat: an operator
    // who has just switched this on should not wait six hours to learn it is
    // not working.
    const first = setTimeout(_checkSilence, SILENCE_GRACE_MS);
    first.unref?.();
  }
}

/** How this collector is doing, for anything that wants to report it. */
function status() {
  return {
    enabled: dhcpdEnabled,
    logFile,
    leasesSeen,
    tracking: ipMacMap.size,
    silentFor: startedAt ? Date.now() - startedAt : 0,
  };
}

// ─── Public query ────────────────────────────────────────────────────────────

function getMacByIp(ip) {
  const entry = ipMacMap.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.seenAt > ENTRY_TTL_MS) {
    ipMacMap.delete(ip);
    return null;
  }
  return entry.mac;
}

function getMap() { return ipMacMap; }

function stop() {
  poller.stop();
  if (silenceTimer) clearInterval(silenceTimer);
  silenceTimer = null;
  startedAt = 0;
  leasesSeen = 0;
  ipMacMap.clear();
}

module.exports = {
  configure, start, stop, getMacByIp, getMap, status,
  _parseLine: parseLine,
  _checkSilence,
  // Reaching past the grace period without waiting fifteen minutes for it.
  _setStartedAtForTest: (at) => { startedAt = at; },
  _noteLeaseForTest: (entry) => {
    ipMacMap.set(entry.ip, { mac: entry.mac, seenAt: Date.now() });
    leasesSeen += 1;
  },
};
