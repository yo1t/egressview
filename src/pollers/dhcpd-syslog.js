// [DHCPD] syslog poller: real-time IP→MAC tracking from Yamaha DHCP events
// Format: [DHCPD] LAN1(port10) Allocates/Extends 192.168.1.27: aa:bb:cc:dd:ee:ff
'use strict';

const { createTailPoller } = require('./tail-helper');

const DEFAULT_LOG_FILE = '/var/log/yamaha-router.log';
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — evict stale leases

// [DHCPD] <iface> Allocates/Extends <ip>: <mac>
const DHCPD_RE = /\[DHCPD\]\s+\S+\s+(?:Allocates|Extends)\s+([\d.]+):\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/i;

let logFile      = DEFAULT_LOG_FILE;
let dhcpdEnabled = true;
let onLease      = () => {}; // callback: ({ ip, mac }) => void

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
    try { onLease(entry); } catch {}
  },
});

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
  ipMacMap.clear();
}

module.exports = { configure, start: poller.start, stop, getMacByIp, getMap, _parseLine: parseLine };
