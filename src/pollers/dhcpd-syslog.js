// [DHCPD] syslog poller: real-time IP→MAC tracking from Yamaha DHCP events
// Format: [DHCPD] LAN1(port10) Allocates/Extends 192.168.41.27: 34:f6:2d:ef:25:48
'use strict';

const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

const DEFAULT_LOG_FILE = '/var/log/yamaha-router.log';
const RESTART_DELAY_MS = 5000;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — evict stale leases

// [DHCPD] <iface> Allocates/Extends <ip>: <mac>
const DHCPD_RE = /\[DHCPD\]\s+\S+\s+(?:Allocates|Extends)\s+([\d.]+):\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/i;

let logFile = DEFAULT_LOG_FILE;
let dhcpdEnabled = true;

// ip → { mac, seenAt }
const ipMacMap = new Map();

let tailProc = null;
let lineReader = null;
let restartTimer = null;
let warnedMissing = false;
let started = false;

function configure(cfg) {
  if (cfg.logFile !== undefined) logFile      = cfg.logFile || DEFAULT_LOG_FILE;
  if (cfg.enabled !== undefined) dhcpdEnabled = cfg.enabled;
}

function parseLine(line) {
  if (!line.includes('[DHCPD]')) return null;
  const m = line.match(DHCPD_RE);
  if (!m) return null;
  return { ip: m[1], mac: m[2].toLowerCase() };
}

function handleLine(line) {
  const entry = parseLine(line);
  if (!entry) return;
  ipMacMap.set(entry.ip, { mac: entry.mac, seenAt: Date.now() });
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

function getMap() {
  return ipMacMap;
}

// ─── Tail lifecycle ──────────────────────────────────────────────────────────

function clearRestartTimer() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
}

function cleanupTail() {
  if (lineReader) { try { lineReader.close(); } catch {} lineReader = null; }
  if (tailProc) {
    const proc = tailProc; tailProc = null;
    try { proc.removeAllListeners(); } catch {}
    try { proc.kill(); } catch {}
  }
}

function scheduleRestart() {
  if (!started || !dhcpdEnabled || restartTimer) return;
  restartTimer = setTimeout(() => { restartTimer = null; startTail(); }, RESTART_DELAY_MS);
}

function startTail() {
  if (!started || !dhcpdEnabled || tailProc) return;

  if (!fs.existsSync(logFile)) {
    if (!warnedMissing) {
      console.warn(`[dhcpd-syslog] Log file not found, waiting: ${logFile}`);
      warnedMissing = true;
    }
    scheduleRestart();
    return;
  }
  warnedMissing = false;

  const proc = spawn('sudo', ['tail', '-F', logFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  tailProc = proc;
  lineReader = readline.createInterface({ input: proc.stdout });

  lineReader.on('line', handleLine);

  proc.stderr.on('data', chunk => {
    const text = chunk.toString('utf8').trim();
    if (text) console.warn('[dhcpd-syslog] tail:', text);
  });
  proc.on('error', err => {
    console.error('[dhcpd-syslog] tail failed:', err.message);
    cleanupTail(); scheduleRestart();
  });
  proc.on('close', code => {
    cleanupTail();
    if (started && dhcpdEnabled) {
      console.warn(`[dhcpd-syslog] tail stopped (${code}), restarting soon`);
      scheduleRestart();
    }
  });

  console.log(`[dhcpd-syslog] tailing ${logFile}`);
}

function start() {
  if (!dhcpdEnabled || started) return;
  started = true;
  clearRestartTimer();
  startTail();
}

function stop() {
  started = false;
  clearRestartTimer();
  cleanupTail();
  ipMacMap.clear();
}

module.exports = { configure, start, stop, getMacByIp, getMap };
