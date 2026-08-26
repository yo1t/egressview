'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const { createHistoryQueries } = require('../../src/history-queries');

function makeDb() {
  const file = path.join(os.tmpdir(), `agent-threat-${process.pid}-${Math.random()}.db`);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE agents (agentId TEXT PRIMARY KEY);
    CREATE TABLE agent_observations (
      agentId TEXT NOT NULL, observationId TEXT NOT NULL, remoteAddress TEXT NOT NULL,
      lastObservedAt INTEGER NOT NULL, PRIMARY KEY (agentId, observationId)
    );
    CREATE TABLE connection_agent_observations (
      agentId TEXT NOT NULL, observationId TEXT NOT NULL
    );
    CREATE INDEX idx_agent_observations_time
      ON agent_observations(agentId, lastObservedAt DESC);
    INSERT INTO agents VALUES ('a1');
  `);
  return { db, file };
}

describe('Agentだけが見た宛先を、通知経路が拾う（P3-11）', () => {
  it('相関していない観測の宛先を返す', () => {
    // Measured on the Hub 2026-08-26: 229,826 of 408,301 observations had no
    // correlated `connections` row -- on a Hub that has a router. Unscoped
    // queries read `connections` alone, so these were invisible to the one
    // path by which a person learns a destination matched a feed.
    const { db, file } = makeDb();
    try {
      const queries = createHistoryQueries({ getDb: () => db });
      db.prepare('INSERT INTO agent_observations VALUES (?,?,?,?)')
        .run('a1', 'o1', '203.0.113.9', 1_000);
      db.prepare('INSERT INTO agent_observations VALUES (?,?,?,?)')
        .run('a1', 'o2', '203.0.113.9', 1_100);
      db.prepare('INSERT INTO agent_observations VALUES (?,?,?,?)')
        .run('a1', 'o3', '198.51.100.7', 1_200);
      // Correlated: already reachable through `connections`.
      db.prepare('INSERT INTO agent_observations VALUES (?,?,?,?)')
        .run('a1', 'o4', '192.0.2.1', 1_300);
      db.prepare('INSERT INTO connection_agent_observations VALUES (?,?)').run('a1', 'o4');

      const rows = queries.groupAgentOnlyDstByTimeRange(0, 2_000);
      assert.deepEqual(rows.map((r) => r.dst).sort(), ['198.51.100.7', '203.0.113.9']);
      assert.equal(rows.find((r) => r.dst === '203.0.113.9').cnt, 2);
    } finally {
      db.close();
      fs.rmSync(file, { force: true });
    }
  });

  it('宛先名は返さない', () => {
    // The Agent keeps names on the Mac and never sends one (P3-14). A column
    // that was always null would read as "no name was found".
    const { db, file } = makeDb();
    try {
      const queries = createHistoryQueries({ getDb: () => db });
      db.prepare('INSERT INTO agent_observations VALUES (?,?,?,?)')
        .run('a1', 'o1', '203.0.113.9', 1_000);
      assert.equal(queries.groupAgentOnlyDstByTimeRange(0, 2_000)[0].dstHost, null);
    } finally {
      db.close();
      fs.rmSync(file, { force: true });
    }
  });

  it('期間の外は返さない', () => {
    // Asked on a schedule over a recent window, not over the whole retained
    // history -- 400k rows is not something to regroup every few minutes.
    const { db, file } = makeDb();
    try {
      const queries = createHistoryQueries({ getDb: () => db });
      db.prepare('INSERT INTO agent_observations VALUES (?,?,?,?)')
        .run('a1', 'o1', '203.0.113.9', 5_000);
      assert.deepEqual(queries.groupAgentOnlyDstByTimeRange(0, 1_000), []);
    } finally {
      db.close();
      fs.rmSync(file, { force: true });
    }
  });

  it('Agentごとに既存の期間indexを使い、全観測を走査しない', () => {
    const { db, file } = makeDb();
    try {
      const plan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT o.remoteAddress
        FROM agents a
        CROSS JOIN agent_observations AS o INDEXED BY idx_agent_observations_time
        WHERE o.agentId = a.agentId
          AND o.lastObservedAt >= ? AND o.lastObservedAt <= ?
      `).all(0, 2_000);
      assert(plan.some(row => String(row.detail).includes('idx_agent_observations_time')));
      assert(plan.every(row => !String(row.detail).includes('SCAN o')));
    } finally {
      db.close();
      fs.rmSync(file, { force: true });
    }
  });
});

describe('通知が両方の出どころを見る', () => {
  it('connections と Agent単独の両方から脅威宛先を集める', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'ai-notification-service.js'), 'utf8'
    );
    assert.match(source, /history\.groupDstByTimeRange\(from, to\)/);
    assert.match(source, /groupAgentOnlyDstByTimeRange\?\.\(from, to\)/);
  });
});
