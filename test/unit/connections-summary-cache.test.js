'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const connectionsRoutes = require('../../src/routes/connections');

// P3-67. The browser sends `from = Date.now() - N` for every rolling range, so
// the value moves every millisecond. With it in the cache key the summary cache
// minted a new entry per poll and never served one -- while the query behind it
// costs 226ms over a day and 7,210ms over all of production's 422,643 rows.
function mount(history) {
  const app = express();
  app.use(express.json());
  app.use('/api', connectionsRoutes({
    requireAdmin: (_req, _res, next) => next(),
    history,
    threatIntel: null,
    devices: { getAll: () => [] },
    routerManager: { list: () => [] },
    agentIdentities: { listAgents: () => [] },
  }));
  return app;
}

function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      http.get({ port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch (error) { reject(error); }
        });
      }).on('error', (error) => { server.close(); reject(error); });
    });
  });
}

// The cache lives at module scope, so each case picks a base far from the
// others rather than sharing entries by accident.
let baseOffset = 0;
function freshBase() {
  baseOffset += 7 * 86_400_000;
  return Date.now() - baseOffset;
}

describe('連続する要約要求がキャッシュを共有する（P3-67）', () => {
  it('ミリ秒違いの from でも2回目はキャッシュから返る', async () => {
    let calls = 0;
    const app = mount({
      summarizeByTimeRange: () => {
        calls += 1;
        return { byDst: [], byDevice: [], total: 0 };
      },
    });
    const now = freshBase();
    const first = await request(app, `/api/connections/summary?from=${now}`);
    const second = await request(app, `/api/connections/summary?from=${now + 7}`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.cached, false);
    assert.equal(second.body.cached, true, 'ミリ秒の差でキャッシュを外した');
    assert.equal(calls, 1, `集計が ${calls} 回走った`);
  });

  it('別の期間は別のキャッシュとして扱う', async () => {
    // The quantisation must not merge ranges a user actually chose apart.
    let calls = 0;
    const app = mount({
      summarizeByTimeRange: () => { calls += 1; return { byDst: [], byDevice: [], total: 0 }; },
    });
    const now = freshBase();
    await request(app, `/api/connections/summary?from=${now}`);
    await request(app, `/api/connections/summary?from=${now - 86_400_000}`);
    assert.equal(calls, 2, '1時間と24時間を同じ答えで返した');
  });

  it('src が違えば共有しない', async () => {
    let calls = 0;
    const app = mount({
      summarizeByTimeRange: () => { calls += 1; return { byDst: [], byDevice: [], total: 0 }; },
    });
    const now = freshBase();
    await request(app, `/api/connections/summary?from=${now}&src=192.0.2.10`);
    await request(app, `/api/connections/summary?from=${now}&src=192.0.2.11`);
    assert.equal(calls, 2, '別の送信元に同じ答えを返した');
  });

  it('ヒット率を数えるので、効いていないことが外から見える', async () => {
    // The defect was invisible: the query was correct, the response was
    // correct, and only the cost was wrong. A hit rate is what that looks
    // like from outside.
    const app = mount({ summarizeByTimeRange: () => ({ byDst: [], byDevice: [], total: 0 }) });
    const before = connectionsRoutes.summaryCacheSnapshot();
    const now = freshBase();
    await request(app, `/api/connections/summary?from=${now}`);
    await request(app, `/api/connections/summary?from=${now + 3}`);
    const after = connectionsRoutes.summaryCacheSnapshot();

    assert.equal(after.misses - before.misses, 1, 'ミスを数えていない');
    assert.equal(after.hits - before.hits, 1, 'ヒットを数えていない');
    assert.ok(after.hitRate > 0, 'ヒット率が出ていない');
  });
});

// P3-139. The key for the all-time summary never moves -- `from` and `to` are
// both null -- so the only thing that decided whether the cache served it was
// the TTL. A fixed ten seconds against a request that arrives once a minute
// meant the entry had always expired: hits=2 misses=393 on production, and
// every miss blocked the event loop for 3.7 seconds.
describe('高くついた答えほど長く使い回す（P3-139）', () => {
  const ttl = connectionsRoutes._summaryCacheTtl;

  it('3.7秒かかった答えは、次の要求が来る64秒後にもまだ生きている', () => {
    // The measured all-time summary: five GROUP BY scans of 478,424 rows.
    const earned = ttl(3677);
    assert.ok(earned > 64_000, `全範囲の答えのTTLが短すぎる: ${earned} ms`);
    assert.equal(earned, 110_310);
    // ...but not unbounded. Two minutes is as stale as this may ever get.
    assert.equal(ttl(60_000), 120_000);
  });

  it('安く済んだ答えには、最低限のTTLしか与えない', () => {
    // A one-hour range measured 26.7 ms on production. Nothing is bought by
    // holding that answer longer, so it keeps the short TTL it always had.
    assert.equal(ttl(26.7), 10_000);
    assert.equal(ttl(0), 10_000);
    assert.equal(ttl(undefined), 10_000);
  });

  it('その間のコストには、比例したTTLを与える', () => {
    assert.equal(ttl(1000), 30_000);
    assert.equal(ttl(2000), 60_000);
  });

  it('全範囲の要約は、2回目に作り直さない', async () => {
    let calls = 0;
    const app = mount({
      summarizeByTimeRange: () => {
        calls += 1;
        return { byDst: [], byDevice: [], total: 0 };
      },
    });
    assert.equal((await request(app, '/api/connections/summary')).body.cached, false);
    assert.equal((await request(app, '/api/connections/summary')).body.cached, true);
    assert.equal(calls, 1);
  });
});
