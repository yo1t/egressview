// Unit tests for src/logger.js
// Run: node --test test/unit/logger.test.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── helpers ────────────────────────────────────────────────────────────────────

// Capture output from a stream by temporarily replacing its write method.
function captureStream(stream) {
  const chunks = [];
  const original = stream.write.bind(stream);
  stream.write = (...args) => { chunks.push(args[0]); return true; };
  return {
    restore: () => { stream.write = original; },
    lines:   () => chunks.join('').trimEnd().split('\n'),
  };
}

// Fresh logger instance for each test (clear the require cache so LOG_LEVEL
// changes between tests don't bleed through the module cache).
function freshLogger(level) {
  const prev = process.env.LOG_LEVEL;
  if (level !== undefined) process.env.LOG_LEVEL = level;
  delete require.cache[require.resolve('../../src/logger')];
  const l = require('../../src/logger');
  if (level !== undefined) {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  }
  return l;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('logger', () => {
  it('info writes to stdout', () => {
    const logger = freshLogger();
    const cap = captureStream(process.stdout);
    try {
      logger.info('[test] hello');
    } finally {
      cap.restore();
    }
    const line = cap.lines()[0];
    assert.match(line, /INFO\s+\[test\] hello/);
  });

  it('error writes to stderr', () => {
    const logger = freshLogger();
    const cap = captureStream(process.stderr);
    try {
      logger.error('[test] boom');
    } finally {
      cap.restore();
    }
    const line = cap.lines()[0];
    assert.match(line, /ERROR\s+\[test\] boom/);
  });

  it('warn writes to stderr', () => {
    const logger = freshLogger();
    const cap = captureStream(process.stderr);
    try {
      logger.warn('[test] careful');
    } finally {
      cap.restore();
    }
    assert.match(cap.lines()[0], /WARN\s+\[test\] careful/);
  });

  it('each line starts with an ISO timestamp', () => {
    const logger = freshLogger();
    const cap = captureStream(process.stdout);
    try {
      logger.info('ts check');
    } finally {
      cap.restore();
    }
    // ISO 8601: 2026-06-10T12:34:56.789Z
    assert.match(cap.lines()[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('non-string argument is JSON-serialized', () => {
    const logger = freshLogger();
    const cap = captureStream(process.stdout);
    try {
      logger.info('[test]', { code: 42 });
    } finally {
      cap.restore();
    }
    assert.match(cap.lines()[0], /\{"code":42\}/);
  });

  it('debug is suppressed at default level (info)', () => {
    const logger = freshLogger('info');
    const cap = captureStream(process.stdout);
    try {
      logger.debug('should not appear');
    } finally {
      cap.restore();
    }
    assert.equal(cap.lines().filter(l => l.includes('should not appear')).length, 0);
  });

  it('debug is emitted when LOG_LEVEL=debug', () => {
    const logger = freshLogger('debug');
    const cap = captureStream(process.stdout);
    try {
      logger.debug('[test] verbose');
    } finally {
      cap.restore();
    }
    assert.match(cap.lines()[0], /DEBUG\s+\[test\] verbose/);
  });

  it('info is suppressed when LOG_LEVEL=error', () => {
    const logger = freshLogger('error');
    const cap = captureStream(process.stdout);
    try {
      logger.info('should not appear');
    } finally {
      cap.restore();
    }
    assert.equal(cap.lines().filter(l => l.includes('should not appear')).length, 0);
  });

  it('error is emitted even when LOG_LEVEL=error', () => {
    const logger = freshLogger('error');
    const cap = captureStream(process.stderr);
    try {
      logger.error('[test] serious');
    } finally {
      cap.restore();
    }
    assert.match(cap.lines()[0], /ERROR\s+\[test\] serious/);
  });
});
