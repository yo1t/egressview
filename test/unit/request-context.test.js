'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createRequestContextMiddleware,
  getRequestId,
  normalizeRequestId,
  runWithRequestId,
} = require('../../src/request-context');

function invokeMiddleware({ requestId, generatedId = 'generated-request-id', statusCode = 200 } = {}) {
  const records = [];
  const logger = {};
  for (const level of ['debug', 'warn', 'error']) {
    logger[level] = message => records.push({ level, message, requestId: getRequestId() });
  }
  const req = {
    method: 'GET',
    originalUrl: '/api/test?token=must-not-be-logged',
    headers: requestId === undefined ? {} : { 'x-request-id': requestId },
    get(name) { return name.toLowerCase() === 'x-request-id' ? requestId : undefined; },
  };
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  const middleware = createRequestContextMiddleware({ idFactory: () => generatedId, logger });
  middleware(req, res, () => res.emit('finish'));
  return { req, res, records };
}

describe('HTTP request context', () => {
  it('accepts a bounded safe caller ID and returns it in the response', () => {
    const result = invokeMiddleware({ requestId: 'client.trace-123:child' });
    assert.equal(result.req.requestId, 'client.trace-123:child');
    assert.equal(result.res.headers['x-request-id'], 'client.trace-123:child');
    assert.ok(result.records.every(row => row.requestId === 'client.trace-123:child'));
  });

  it('replaces missing, malformed, control-character, array, and oversized IDs', () => {
    const invalid = [undefined, '', ' space', 'bad/value', 'line\nbreak', ['array'], 'x'.repeat(65)];
    for (const requestId of invalid) {
      const result = invokeMiddleware({ requestId });
      assert.equal(result.req.requestId, 'generated-request-id');
      assert.equal(result.res.headers['x-request-id'], 'generated-request-id');
    }
  });

  it('logs 400, 401, 429, and 500 without query values and with the same ID', () => {
    for (const statusCode of [400, 401, 429, 500]) {
      const { records } = invokeMiddleware({ requestId: `status-${statusCode}`, statusCode });
      const completed = records.at(-1);
      assert.equal(completed.requestId, `status-${statusCode}`);
      const expectedLevel = statusCode >= 500
        ? 'error'
        : [401, 429].includes(statusCode) ? 'warn' : 'debug';
      assert.equal(completed.level, expectedLevel);
      assert.match(completed.message, new RegExp(`/api/test ${statusCode}$`));
      assert.doesNotMatch(completed.message, /token|must-not-be-logged/);
    }
  });

  it('keeps concurrent asynchronous request IDs isolated', async () => {
    const seen = await Promise.all(['request-a', 'request-b'].map((requestId, index) =>
      runWithRequestId(requestId, async () => {
        await new Promise(resolve => setTimeout(resolve, index ? 1 : 5));
        return getRequestId();
      })));
    assert.deepEqual(seen, ['request-a', 'request-b']);
    assert.equal(getRequestId(), null);
  });

  it('documents the accepted request ID grammar', () => {
    assert.equal(normalizeRequestId('A-1_b.c:d'), 'A-1_b.c:d');
    assert.equal(normalizeRequestId('bad value'), null);
  });
});
