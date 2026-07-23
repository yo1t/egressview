'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTrustProxy } = require('../../src/proxy-trust');
const { createGlobalRateLimit } = require('../../src/global-rate-limit');

describe('trusted reverse proxy boundary', () => {
  it('trusts only configured exact addresses and IPv4 CIDRs', () => {
    assert.equal(createTrustProxy(), false);
    const trust = createTrustProxy('127.0.0.1,10.41.0.0/16');
    assert.equal(trust('127.0.0.1'), true);
    assert.equal(trust('10.41.9.3'), true);
    assert.equal(trust('10.42.9.3'), false);
    assert.throws(() => createTrustProxy('not-an-ip'), /Invalid/);
  });
});

describe('global API rate limit', () => {
  it('limits writes independently from reads and returns Retry-After', () => {
    const middleware = createGlobalRateLimit({
      windowMs: 60_000,
      readLimit: 2,
      writeLimit: 1,
    });
    const headers = {};
    const res = {
      setHeader: (name, value) => { headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const request = method => ({
      method,
      path: '/api/config',
      ip: '192.0.2.1',
      socket: {},
    });
    let nextCalls = 0;
    middleware(request('POST'), res, () => { nextCalls += 1; });
    middleware(request('POST'), res, () => { nextCalls += 1; });
    middleware(request('GET'), res, () => { nextCalls += 1; });
    assert.equal(nextCalls, 2);
    assert.equal(res.statusCode, 429);
    assert.equal(headers['Retry-After'] >= 1, true);
  });

  it('fails closed instead of growing the source bucket map without bound', () => {
    const middleware = createGlobalRateLimit({
      windowMs: 60_000,
      readLimit: 10,
      writeLimit: 10,
      maxBuckets: 1,
    });
    const response = () => ({
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    });
    const request = ip => ({ method: 'GET', path: '/api/config', ip, socket: {} });
    let nextCalls = 0;
    middleware(request('192.0.2.1'), response(), () => { nextCalls += 1; });
    const rejected = response();
    middleware(request('192.0.2.2'), rejected, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.equal(rejected.statusCode, 429);
    assert.equal(rejected.body.error, 'Too many request sources');
  });
});
