// Minimal structured logger
// - ISO timestamp on every line
// - Level filtering via LOG_LEVEL env var (error/warn/info/debug, default: info)
// - error/warn → stderr, info/debug → stdout (same semantics as console)
// - Drop-in for console.log/warn/error throughout src/
'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function fmt(args) {
  return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

function write(stream, level, args) {
  if (LEVELS[level] > currentLevel) return;
  stream.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${fmt(args)}\n`);
}

const logger = {
  info:  (...args) => write(process.stdout, 'info',  args),
  warn:  (...args) => write(process.stderr, 'warn',  args),
  error: (...args) => write(process.stderr, 'error', args),
  debug: (...args) => write(process.stdout, 'debug', args),
};

module.exports = logger;
