'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createHistoryQueries } = require('../../src/history-queries');

// P3-139. The browser never sends an upper bound, so the time filter was
// one-sided, and SQLite dropped the time index to drive from whichever index
// served the GROUP BY -- scanning the whole table to answer a question about
// the last hour. Measured on production: 746 ms against 19 ms, and the cost
// did not move with the range.
function seedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-time-index-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE connections (
      src TEXT NOT NULL, dst TEXT NOT NULL, dport INTEGER NOT NULL, proto TEXT NOT NULL,
      sport INTEGER, ttl INTEGER, srcMac TEXT, srcVendor TEXT, srcDnsName TEXT, srcMdnsName TEXT,
      dstHost TEXT, country TEXT, org TEXT, lat REAL, lon REAL, city TEXT,
      firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto)
    );
    CREATE TABLE connection_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, routerId TEXT,
      firstObservedAt INTEGER, lastObservedAt INTEGER,
      PRIMARY KEY (src, dst, dport, proto, routerId)
    );
    CREATE TABLE agent_app_hourly (
      hourStart INTEGER NOT NULL, agentId TEXT NOT NULL, appIdentity TEXT NOT NULL,
      processName TEXT NOT NULL, localAddress TEXT NOT NULL, remoteAddress TEXT NOT NULL,
      remotePort INTEGER NOT NULL, networkProtocol TEXT NOT NULL,
      firstObservedAt INTEGER NOT NULL, lastObservedAt INTEGER NOT NULL,
      PRIMARY KEY (hourStart, agentId, appIdentity, localAddress, remoteAddress, remotePort, networkProtocol)
    );
    CREATE TABLE connection_agent_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, agentId TEXT, observationId TEXT,
      linkedAt INTEGER, PRIMARY KEY (src, dst, dport, proto, agentId, observationId)
    );
    CREATE TABLE agent_observations (
      agentId TEXT, observationId TEXT, batchId TEXT, localAddress TEXT, localPort INTEGER,
      remoteAddress TEXT, remotePort INTEGER, networkProtocol TEXT, processName TEXT,
      bundleId TEXT, processId INTEGER, firstObservedAt INTEGER, lastObservedAt INTEGER,
      PRIMARY KEY (agentId, observationId)
    );
    CREATE TABLE agents (agentId TEXT PRIMARY KEY, hostName TEXT);
    CREATE INDEX idx_lastSeen ON connections(lastSeen);
    CREATE INDEX idx_src ON connections(src);
    CREATE INDEX idx_dst ON connections(dst);
  `);
  const insert = db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen)
    VALUES (?, ?, ?, 'TCP', ?, ?)`);
  const now = Date.now();
  const write = db.transaction(() => {
    // Most of the rows are old, so a query about the last hour that actually
    // uses the time index touches a small fraction of the table.
    for (let i = 0; i < 20_000; i++) {
      const at = now - (i < 200 ? i * 1000 : 30 * 86_400_000 + i * 1000);
      insert.run(`10.0.${(i >> 8) & 255}.${i & 255}`, `203.0.113.${i % 250}`, 1024 + (i % 500), at, at);
    }
  });
  write();
  // Real statistics, so the planner is making the choice it would make on a
  // real Hub rather than falling back to defaults.
  db.exec('ANALYZE');
  return { db, dir };
}

function capturePlans(db, run) {
  const plans = [];
  const realPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (/\bFROM\s+connections\b/i.test(sql) && /lastSeen\s*>=/.test(sql) && !/[@:$]\w/.test(sql)) {
      plans.push(sql);
    }
    return realPrepare(sql);
  };
  try { run(); } finally { db.prepare = realPrepare; }
  // The plan does not depend on the values, only on their number, so the
  // captured statements are explained with placeholders of the right count.
  return plans.map(sql => {
    const count = (sql.match(/\?/g) || []).length;
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: count }, () => 0))
      .map(row => row.detail)
      .join(' | ');
    return { sql, detail };
  });
}

describe('時間で絞る問い合わせは、時間索引で駆動する（P3-139）', () => {
  it('上限を送ってこない要求でも、全件走査に落ちない', () => {
    const { db, dir } = seedDb();
    try {
      const queries = createHistoryQueries({
        getDb: () => db,
        getDbPath: () => db.name,
        Database,
        connectionReadColumns: '*',
        hydrateConnectionRows: rows => rows,
        normalizeObservedBy: csv => (csv ? String(csv).split(',').filter(Boolean) : []),
        compatibilitySource: () => null,
        summarizeAppGroups: rows => rows,
      });

      // The shape the browser actually sends: a rolling start, no end.
      const plans = capturePlans(db, () => {
        queries.summarizeByTimeRange(Date.now() - 3_600_000, null, { buckets: 60 });
      });

      assert.ok(plans.length >= 3, `時間で絞るクエリが拾えていない: ${plans.length} 件`);
      for (const { sql, detail } of plans) {
        const stage = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
        assert.ok(
          !/SCAN connections USING INDEX idx_(dst|src)\b/.test(detail),
          `集約用の索引で全件走査している: ${stage}\n  ${detail}`
        );
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('下限だけの要求にも、行を除外しない上限を付ける', () => {
    const { db, dir } = seedDb();
    try {
      const queries = createHistoryQueries({
        getDb: () => db,
        getDbPath: () => db.name,
        Database,
        connectionReadColumns: '*',
        hydrateConnectionRows: rows => rows,
        normalizeObservedBy: () => [],
        compatibilitySource: () => null,
        summarizeAppGroups: rows => rows,
      });
      const from = Date.now() - 3_600_000;
      // The bound is there only for the planner: the answer must not change.
      const openEnded = queries.summarizeByTimeRange(from, null, { buckets: 60 });
      const explicitEnd = queries.summarizeByTimeRange(from, Number.MAX_SAFE_INTEGER, { buckets: 60 });
      assert.equal(openEnded.total, explicitEnd.total);
      assert.ok(openEnded.total > 0, '検証になる行が無い');
      assert.equal(openEnded.byDst.length, explicitEnd.byDst.length);
      assert.equal(openEnded.byDevice.length, explicitEnd.byDevice.length);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
