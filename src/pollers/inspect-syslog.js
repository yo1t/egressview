// [INSPECT] syslog poller: tail Yamaha router syslog for completed TCP session events
// Format: [INSPECT] LAN2[out][101098] TCP 192.168.41.73:52371 > 18.176.56.231:443 (2026/06/07 17:33:19)
'use strict';

const { createTailPoller } = require('./tail-helper');

const DEFAULT_LOG_FILE = '/var/log/yamaha-router.log';

// [INSPECT] <iface>[direction][descriptor] TCP src:sport > dst:dport (start_time)
const INSPECT_RE = /\[INSPECT\]\s+\S+\s+(TCP|UDP)\s+([\d.]+):(\d+)\s+>\s+([\d.]+):(\d+)/i;

let logFile       = DEFAULT_LOG_FILE;
let inspectEnabled = true;
let onSession     = () => {};

function configure(cfg) {
  if (cfg.logFile   !== undefined) logFile        = cfg.logFile  || DEFAULT_LOG_FILE;
  if (cfg.enabled   !== undefined) inspectEnabled = cfg.enabled;
  if (cfg.onSession)               onSession      = cfg.onSession;
}

function parseLine(line) {
  if (!line.includes('[INSPECT]')) return null;
  const m = line.match(INSPECT_RE);
  if (!m) return null;
  return {
    proto: m[1].toLowerCase(),
    src:   m[2],
    sport: parseInt(m[3], 10),
    dst:   m[4],
    dport: parseInt(m[5], 10),
    time:  new Date(),
  };
}

const poller = createTailPoller({
  name:       'inspect-syslog',
  getLogFile: () => logFile,
  isEnabled:  () => inspectEnabled,
  onLine: line => {
    const entry = parseLine(line);
    if (!entry) return;
    onSession(entry);
  },
});

module.exports = { configure, start: poller.start, stop: poller.stop, _parseLine: parseLine };
