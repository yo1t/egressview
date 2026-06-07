// Shared tail-F lifecycle helper for syslog pollers.
// Handles: process spawn, readline, auto-restart on exit/error, missing-file retry.
'use strict';

const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

const RESTART_DELAY_MS = 5000;

/**
 * Create a managed tail -F poller.
 *
 * @param {object} opts
 * @param {string}   opts.name        - Label used in log messages (e.g. 'dnsmasq-log')
 * @param {Function} opts.getLogFile  - () => string  — current log file path
 * @param {Function} opts.isEnabled   - () => boolean — whether poller should run
 * @param {Function} opts.onLine      - (line: string) => void  — called per line
 * @returns {{ start, stop }}
 */
function createTailPoller({ name, getLogFile, isEnabled, onLine }) {
  let tailProc      = null;
  let lineReader    = null;
  let restartTimer  = null;
  let warnedMissing = false;
  let started       = false;

  function clearRestartTimer() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }

  function cleanup() {
    if (lineReader) { try { lineReader.close(); } catch {} lineReader = null; }
    if (tailProc) {
      const p = tailProc; tailProc = null;
      try { p.removeAllListeners(); } catch {}
      try { p.kill(); } catch {}
    }
  }

  function scheduleRestart() {
    if (!started || !isEnabled() || restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; startTail(); }, RESTART_DELAY_MS);
  }

  function startTail() {
    if (!started || !isEnabled() || tailProc) return;

    const logFile = getLogFile();

    if (!fs.existsSync(logFile)) {
      if (!warnedMissing) {
        console.warn(`[${name}] Log file not found, waiting: ${logFile}`);
        warnedMissing = true;
      }
      scheduleRestart();
      return;
    }
    warnedMissing = false;

    const proc = spawn('sudo', ['tail', '-F', logFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    tailProc   = proc;
    lineReader = readline.createInterface({ input: proc.stdout });

    lineReader.on('line', line => {
      try { onLine(line); } catch (e) {
        console.error(`[${name}] onLine error:`, e.message);
      }
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn(`[${name}] tail stderr:`, text);
    });
    proc.on('error', err => {
      console.error(`[${name}] tail spawn error:`, err.message);
      cleanup(); scheduleRestart();
    });
    proc.on('close', code => {
      cleanup();
      if (started && isEnabled()) {
        console.warn(`[${name}] tail stopped (${code}), restarting soon`);
        scheduleRestart();
      }
    });

    console.log(`[${name}] tailing ${logFile}`);
  }

  function start() {
    if (!isEnabled() || started) return;
    started = true;
    clearRestartTimer();
    startTail();
  }

  function stop() {
    started = false;
    clearRestartTimer();
    cleanup();
  }

  return { start, stop };
}

module.exports = { createTailPoller };
