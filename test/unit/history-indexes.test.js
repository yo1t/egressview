'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const { ensureHistoryIndexes } = require('../../src/history-indexes');

// P3-190: the new-nodes list read all 627,000 connection rows for their
// firstSeen (1.7-2.1 s on production). These indexes let the grouping stay in
// the index; they are built on the maintenance thread, not by a migration
// that would copy the whole 5.1 GB database first.
describe('optional history indexes', () => {
  function connectionsDb() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE connections (src TEXT, dst TEXT, dstHost TEXT, firstSeen INTEGER)');
    return db;
  }

  it('無ければ2つ作り、2回目は何もしない', () => {
    const db = connectionsDb();
    const first = ensureHistoryIndexes(db);
    assert.deepEqual(first.built.map(index => index.name),
      ['idx_connections_src_firstseen', 'idx_connections_dst_firstseen']);
    const second = ensureHistoryIndexes(db);
    assert.deepEqual(second.built, []);
    assert.deepEqual(second.present, ['idx_connections_src_firstseen', 'idx_connections_dst_firstseen']);
  });

  it('送信元・宛先ごとの最初の時刻を、表を読まずに索引だけで求める', () => {
    const db = connectionsDb();
    ensureHistoryIndexes(db);
    for (const column of ['src', 'dst']) {
      const plan = db.prepare(
        `EXPLAIN QUERY PLAN SELECT ${column}, MIN(firstSeen) FROM connections GROUP BY ${column}
         HAVING MIN(firstSeen) >= 1 AND MIN(firstSeen) <= 2`
      ).all().map(row => row.detail).join(' ');
      assert.match(plan, new RegExp(`COVERING INDEX idx_connections_${column}_firstseen`));
    }
  });

  it('接続の表が無いDBや、DBが無いときは何もしない', () => {
    assert.deepEqual(ensureHistoryIndexes(new Database(':memory:')), { built: [], present: [] });
    assert.deepEqual(ensureHistoryIndexes(null), { built: [], present: [] });
  });
});
