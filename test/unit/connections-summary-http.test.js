'use strict';

// GET /api/connections/summary went undeclared because its tests called the
// handler directly with a stand-in `res`, so nothing ever reached it through
// Express and a declaration could not be verified. Production named it the
// busiest undeclared route (x660 in one 15-minute window, 2026-09-06).
//
// This exercises it over real HTTP so the response contract can be declared
// against something that is actually checked.

const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it, before, after } = require('node:test');
const express = require('express');

const connectionsRoutes = require('../../src/routes/connections');

// Shaped after what the production Hub actually answers, not after the
// minimum the route needs to run. A stub that returns less than production
// would let a contract pass here and fail there -- `total` comes from
// summarizeByTimeRange, so leaving it out of the stub hid it from the
// contract entirely.
function historyStub() {
  return {
    queryByTimeRange: () => [],
    queryByTimeRangePaged: () => [],
    countByTimeRange: () => 0,
    summarizeByTimeRange: () => ({
      byDst: [{ dst: '198.51.100.10', dstHost: 'example.test', count: 5 }],
      byDevice: [{ src: '203.0.113.20', count: 5 }],
      byTarget: [{ key: 'Example Org', label: 'Example Org', count: 5 }],
      byEdge: [{ src: '203.0.113.20', key: 'Example Org', count: 5 }],
      byLocation: [{ key: 'Example Org', country: 'JP', count: 5 }],
      mapCoverage: { placed: 5, unplaced: 0 },
      appGroups: [{ app: 'curl', count: 5, attribution: 'agent' }],
      timeline: [{ key: 'Example Org', bucket: 0, count: 5 }],
      total: 5,
      buckets: 60,
      from: 0,
      to: 1,
    }),
  };
}

describe('GET /api/connections/summary over HTTP', () => {
  let server;
  let base;

  before(async () => {
    const app = express();
    app.use('/api', connectionsRoutes({
      requireAdmin: (_req, _res, next) => next(),
      history: historyStub(),
    }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise(resolve => server.close(resolve)));

  it('answers 200 with a JSON body', async () => {
    const response = await fetch(`${base}/api/connections/summary`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
  });

  it('carries byDst, byDevice and serverTime', async () => {
    const body = await (await fetch(`${base}/api/connections/summary`)).json();
    assert.ok(Array.isArray(body.byDst), 'byDst should be an array');
    assert.ok(Array.isArray(body.byDevice), 'byDevice should be an array');
    assert.equal(typeof body.serverTime, 'number');
  });

  // The reason the declaration was withheld: a contract nobody exercises is
  // not a check. This asserts the response satisfies the declared shape when
  // it travels through Express, not just when a test calls the function.
  it('satisfies the declared response contract', async () => {
    const { createRegistry } = require('../../src/response-contracts');
    const contract = createRegistry().lookup('GET /api/connections/summary', 200);
    assert.ok(contract, 'GET /api/connections/summary should now be declared');
    const body = await (await fetch(`${base}/api/connections/summary`)).json();
    const result = contract.schema.safeParse(body);
    assert.ok(
      result.success,
      `response does not match the contract: ${JSON.stringify(result.error?.issues?.slice(0, 3))}`
    );
  });
});
