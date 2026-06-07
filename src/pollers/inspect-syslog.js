// [INSPECT] syslog poller: tail Yamaha router syslog for completed TCP session events
// Format: [INSPECT] LAN2[out][101098] TCP 192.168.41.73:52371 > 18.176.56.231:443 (2026/06/07 17:33:19)
'use strict';

const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

const DEFAULT_LOG_FILE = '/var/log/yamaha-router.log';
const RESTART_DELAY_MS = 5000;

// [INSPECT] <iface>[direction][descriptor] TCP src:sport > dst:dport (start_time)
const INSPECT_RE = /\[INSPECT\]\s+\S+\s+(TCP|UDP)\s+([\d.]+):(\d+)\s+>\s+([\d.]+):(\d+)/i;

let logFile = DEFAULT_LOG_FILE;
let inspectEnabled = true;
let onSession = () => {};

let tailProc = null;
let lineReader = null;
let restartTimer = null;
let warnedMissing = false;
let started = false;

function configure(cfg) {
  if (cfg.logFile  !== undefined) logFile        = cfg.logFile  || DEFAULT_LOG_FILE;
  if (cfg.enabled  !== undefined) inspectEnabled = cfg.enabled;
  if (cfg.onSession)              onSession      = cfg.onSession;
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

function handleLine(line) {
  const entry = parseLine(line);
  if (!entry) return;
  try {
    onSession(entry);
  } catch (e) {
    console.error('[inspect-syslog] onSession failed:', e.message);
  }
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
  if (!started || !inspectEnabled || restartTimer) return;
  restartTimer = setTimeout(() => { restartTimer = null; startTail(); }, RESTART_DELAY_MS);
}

function startTail() {
  if (!started || !inspectEnabled || tailProc) return;

  if (!fs.existsSync(logFile)) {
    if (!warnedMissing) {
      console.warn(`[inspect-syslog] Log file not found, waiting: ${logFile}`);
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
    if (text) console.warn('[inspect-syslog] tail:', text);
  });
  proc.on('error', err => {
    console.error('[inspect-syslog] tail failed:', err.message);
    cleanupTail(); scheduleRestart();
  });
  proc.on('close', code => {
    cleanupTail();
    if (started && inspectEnabled) {
      console.warn(`[inspect-syslog] tail stopped (${code}), restarting soon`);
      scheduleRestart();
    }
  });

  console.log(`[inspect-syslog] tailing ${logFile}`);
}

function start() {
  if (!inspectEnabled || started) return;
  started = true;
  clearRestartTimer();
  startTail();
}

function stop() {
  started = false;
  clearRestartTimer();
  cleanupTail();
}

module.exports = { configure, start, stop };
