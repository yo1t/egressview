// Unit tests for src/slow-request-log.js (P2-22 slow-request log)
// Run: node --test test/unit/slow-request-log.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSlowRequestLogger } = require('../../src/slow-request-log');

function makeRes({ statusCode = 200, contentLength = null } = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.getHeader = (name) =>
    name === 'content-length' && contentLength != null ? contentLength : undefined;
  return res;
}

function run({ thresholdMs, req, res }) {
  const logged = [];
  const mw = createSlowRequestLogger({ thresholdMs, log: (msg) => logged.push(msg) });
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, 'next() must be called');
  res.emit('finish');
  return logged;
}

describe('slow-request-log', () => {
  it('logs method, path, status, duration, size when over threshold', () => {
    const logged = run({
      thresholdMs: 0, // 0ms threshold = log everything
      req: { method: 'GET', originalUrl: '/api/connections?from=123&to=456', requestId: 'req-123' },
      res: makeRes({ statusCode: 200, contentLength: '2311153' }),
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^\[slow-request\] GET \/api\/connections 200 \d+ms size=2311153 requestId=req-123$/);
  });

  it('strips the query string from the logged path', () => {
    const logged = run({
      thresholdMs: 0,
      req: { method: 'GET', originalUrl: '/api/devices?fSrc=192.168.1.1' },
      res: makeRes(),
    });
    assert.ok(!logged[0].includes('fSrc'), 'query string must not be logged');
    assert.ok(logged[0].includes('/api/devices'));
  });

  it('does not log requests under the threshold', () => {
    const logged = run({
      thresholdMs: 60_000, // 60s threshold = unreachable within the test's runtime
      req: { method: 'GET', originalUrl: '/api/devices' },
      res: makeRes(),
    });
    assert.equal(logged.length, 0);
  });

  it('falls back to "-" when content-length is not set', () => {
    const logged = run({
      thresholdMs: 0,
      req: { method: 'POST', originalUrl: '/api/notes' },
      res: makeRes({ statusCode: 201, contentLength: null }),
    });
    assert.match(logged[0], /size=-$/);
  });

  it('tolerates missing originalUrl (falls back to req.url)', () => {
    const logged = run({
      thresholdMs: 0,
      req: { method: 'GET', url: '/fallback?x=1' },
      res: makeRes(),
    });
    assert.ok(logged[0].includes('/fallback'));
    assert.ok(!logged[0].includes('x=1'));
  });

  it('omits the request ID field for legacy middleware callers', () => {
    const logged = run({
      thresholdMs: 0,
      req: { method: 'GET', originalUrl: '/healthz' },
      res: makeRes(),
    });
    assert.doesNotMatch(logged[0], /requestId=/);
  });
});
