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
    // ...but not unbounded. Five minutes is as stale as this may ever get,
    // which is also the coarsest grid a key can sit on.
    assert.equal(ttl(60_000), 5 * 60_000);
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

  it('答えは、自分の鍵が生きているあいだは生きている', () => {
    // The measured gap after the grid was fixed: a three-minute grid and a
    // seventy-two-second TTL recomputed the same window inside its own cell.
    assert.equal(ttl(2403, 180_000), 180_000);
    // A cheap answer on a coarse grid is still held for the whole cell: two
    // requests naming the same window get the same answer, which is what the
    // grid already decided.
    assert.equal(ttl(5, 180_000), 180_000);
    // An expensive answer still earns more than its key's lifetime.
    assert.equal(ttl(3677, 60_000), 110_310);
    // A fine grid changes nothing: live and 15m views keep the short TTL.
    assert.equal(ttl(5, 10_000), 10_000);
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

// P3-139 again. Raising the TTL was the wrong fix, and the hit rate could not
// have told anyone that: an entry that expired and a key that never repeats
// look identical from a percentage. They want opposite fixes.
describe('外れた理由を、外れた数と一緒に記録する（P3-139）', () => {
  it('鍵が動いていれば、期限切れではなく「見たことのない鍵」と数える', async () => {
    connectionsRoutes._resetReadCacheForTest();
    const app = mount({ summarizeByTimeRange: () => ({ byDst: [], byDevice: [], total: 0 }) });

    // Two rolling requests far enough apart to land in different cells of the
    // grid this span uses -- five minutes, for a window this wide.
    const base = freshBase();
    await request(app, `/api/connections/summary?from=${base}`);
    await request(app, `/api/connections/summary?from=${base + 6 * 60_000}`);

    const snapshot = connectionsRoutes.summaryCacheSnapshot();
    assert.equal(snapshot.misses, 2);
    assert.equal(snapshot.movingKey, 2);
    assert.equal(snapshot.expired, 0);
  });

  it('同じ鍵が戻ってきて外れたなら、期限切れと数える', async () => {
    connectionsRoutes._resetReadCacheForTest();
    const app = mount({ summarizeByTimeRange: () => ({ byDst: [], byDevice: [], total: 0 }) });

    await request(app, '/api/connections/summary');
    // Drop the entry but keep the memory of the key, the way an expiry does.
    connectionsRoutes._expireSummaryEntriesForTest();
    await request(app, '/api/connections/summary');

    const snapshot = connectionsRoutes.summaryCacheSnapshot();
    assert.equal(snapshot.expired, 1);
    assert.equal(snapshot.movingKey, 1);
  });

  it('聞かれた範囲は、幅だけを名前にして記録する', () => {
    const label = connectionsRoutes._summaryRangeLabel;
    const now = Date.now();
    assert.equal(label(null, null), 'all');
    assert.equal(label(now - 59 * 60_000, null), '<=1h');
    assert.equal(label(now - 23 * 3_600_000, null), '<=24h');
    assert.equal(label(now - 13 * 86_400_000, null), '<=14d');
    assert.equal(label(now - 30 * 86_400_000, null), '>14d');
    assert.equal(label(null, now), 'open-start');
  });
});

// P3-139. The miss reasons said expired=0, keyNeverSeen=89: the key never
// repeated, so no TTL could ever be reached. The grid the key snaps to has to
// be coarser than the interval between requests, and the summary is asked for
// about once a minute.
describe('鍵が繰り返すだけの粗さを持たせる（P3-139）', () => {
  const quantum = connectionsRoutes._summaryCacheQuantum;
  const now = Date.now();

  it('1分に1回の要求なら、直近1時間の鍵は繰り返す', () => {
    assert.equal(quantum(now - 3_600_000, null), 60_000);
  });

  it('短い窓ほど格子は細かい。5分の窓を5分ずらしては意味がない', () => {
    assert.equal(quantum(now - 5 * 60_000, null), 10_000);
    assert.equal(quantum(now - 15 * 60_000, null), 10_000);
    assert.equal(quantum(now - 60_000, null), 10_000);
  });

  it('長い窓でも、ずれは5分で頭打ちにする', () => {
    assert.equal(quantum(now - 6 * 3_600_000, null), 180_000);
    assert.equal(quantum(now - 12 * 3_600_000, null), 5 * 60_000);
    assert.equal(quantum(now - 14 * 86_400_000, null), 5 * 60_000);
    assert.equal(quantum(now - 365 * 86_400_000, null), 5 * 60_000);
  });

  it('範囲が無い要求の鍵は、そもそも動かない', () => {
    assert.equal(quantum(null, null), 10_000);
  });

  it('窓が滑っても格子は動かない', () => {
    // A ratio of the span was tried first: the span is `now - from`, so it
    // changed with every request, the grid changed with it, and the key moved
    // anyway. Two requests a minute apart must land on the same grid.
    assert.equal(quantum(now - 3_600_000, null), quantum(now - 3_600_000 + 60_000, null));
  });

  it('1分違いで届いた直近1時間の要求は、同じ答えを共有する', async () => {
    connectionsRoutes._resetReadCacheForTest();
    let calls = 0;
    const app = mount({
      summarizeByTimeRange: () => {
        calls += 1;
        return { byDst: [], byDevice: [], total: 0 };
      },
    });
    // Both land in the same one-minute cell, as two polls seconds apart do.
    const base = Math.floor((now - 3_600_000) / 60_000) * 60_000 + 1_000;
    await request(app, `/api/connections/summary?from=${base}`);
    const second = await request(app, `/api/connections/summary?from=${base + 30_000}`);
    assert.equal(second.body.cached, true);
    assert.equal(calls, 1);
    assert.equal(connectionsRoutes.summaryCacheSnapshot().hits, 1);
  });
});
