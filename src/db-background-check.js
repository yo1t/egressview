'use strict';

// Database checks run while the Hub keeps working: the startup check when it
// was deferred (db-startup-check.js) and the daily full check. Each runs in a
// child process at the lowest CPU and disk priority the system offers, reading
// the database through its own read-only connection; collection, detection
// and notification go on meanwhile.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'db-check-child.js');

function lowPriorityCommand(args, { platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform === 'linux' && exists('/usr/bin/nice') && exists('/usr/bin/ionice')) {
    // nice 19: last for the CPU. ionice class 3 (idle): disk only when nothing
    // else wants it.
    return { command: '/usr/bin/nice', args: ['-n', '19', '/usr/bin/ionice', '-c', '3', process.execPath, ...args] };
  }
  return { command: process.execPath, args };
}

/**
 * @param {'quick'|'full'} mode
 * @returns {Promise<{ result: 'ok'|'corrupt'|'error', ms: number, error?: string, mode: string }>}
 */
function runDatabaseCheck(dbPath, mode, { spawnImpl = spawn, commandFor = lowPriorityCommand } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const { command, args } = commandFor([SCRIPT, dbPath, mode]);
    let output = '';
    let settled = false;
    const settle = value => { if (!settled) { settled = true; resolve({ ...value, mode }); } };
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      settle({ result: 'error', ms: Date.now() - startedAt, error: error.message });
      return;
    }
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    child.once('error', error => settle({ result: 'error', ms: Date.now() - startedAt, error: error.message }));
    child.once('close', code => {
      const line = output.trim().split('\n').pop();
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.result === 'string') return settle(parsed);
      } catch {
        // fall through
      }
      settle({ result: 'error', ms: Date.now() - startedAt, error: `the check process exited with ${code} and no result` });
    });
  });
}

/** Milliseconds until the next `hour`:00 local time. */
function msUntilNextHour(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

module.exports = { runDatabaseCheck, lowPriorityCommand, msUntilNextHour };
