'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIngestAuditSummary, EVENT_TYPE } = require('../../src/ingest-audit-summary');

// Successful agent uploads, one audit row per agent per hour (P3-175).
const HOUR = 60 * 60 * 1000;
const start = Date.parse('2026-09-26T09:00:00Z');

function make() {
  const rows = [];
  let at = start;
  const summary = createIngestAuditSummary({ append: event => rows.push(event), now: () => at });
  return { rows, summary, advance: ms => { at += ms; }, stop: () => summary.stop() };
}
const agentA = { principal: 'agent:a', actor: 'agent:a', authMethod: 'agent-token', clientIp: '10.0.0.1', path: '/api/agent/ingest' };
const agentB = { ...agentA, principal: 'agent:b', actor: 'agent:b' };
const upload = (n = 2, replayed = false, durationMs = 10) => ({
  observationCount: n, acceptedCount: n, duplicateCount: 0, replayed, durationMs,
});

describe('成功した送信の1時間ごとの集計', () => {
  it('1時間の間は書かず、その時間の終わりに1行にまとめて書く', () => {
    const t = make();
    try {
      for (let i = 0; i < 100; i += 1) { t.summary.record(agentA, upload()); t.advance(30 * 1000); }
      assert.equal(t.rows.length, 0);

      t.advance(HOUR);
      assert.equal(t.summary.flush(), 1);
      assert.equal(t.rows.length, 1);
      const [row] = t.rows;
      assert.equal(row.eventType, EVENT_TYPE);
      assert.equal(row.outcome, 'success');
      assert.equal(row.principal, 'agent:a');
      assert.equal(row.metadata.uploads, 100);
      assert.equal(row.metadata.observationCount, 200);
      assert.equal(row.metadata.windowStart, '2026-09-26T09:00:00.000Z');
      assert.equal(row.metadata.windowEnd, '2026-09-26T10:00:00.000Z');
    } finally { t.stop(); }
  });

  it('Agentごとに別の行にする', () => {
    const t = make();
    try {
      t.summary.record(agentA, upload());
      t.summary.record(agentB, upload(5));
      t.advance(HOUR);
      t.summary.flush();
      assert.deepEqual(t.rows.map(row => [row.principal, row.metadata.observationCount]).sort(),
        [['agent:a', 2], ['agent:b', 5]]);
    } finally { t.stop(); }
  });

  it('次の時間の最初の送信で、前の時間を書いてから数え直す', () => {
    const t = make();
    try {
      t.summary.record(agentA, upload());
      t.advance(HOUR);
      t.summary.record(agentA, upload(7));
      assert.equal(t.rows.length, 1);
      assert.equal(t.rows[0].metadata.observationCount, 2);
      assert.equal(t.summary.pending(), 1);
    } finally { t.stop(); }
  });

  it('終わっていない時間は、flushでは書かない', () => {
    const t = make();
    try {
      t.summary.record(agentA, upload());
      t.advance(10 * 60 * 1000);
      assert.equal(t.summary.flush(), 0);
      assert.equal(t.rows.length, 0);
    } finally { t.stop(); }
  });

  // An orderly stop must not lose the hour in progress.
  it('止めるときは、途中の時間も書く', () => {
    const t = make();
    t.summary.record(agentA, upload(3, true, 42));
    t.advance(5 * 60 * 1000);
    t.summary.record(agentA, upload(1, false, 7));
    assert.equal(t.stop(), 1);
    assert.equal(t.rows.length, 1);
    const m = t.rows[0].metadata;
    assert.equal(m.uploads, 2);
    assert.equal(m.observationCount, 4);
    assert.equal(m.replayedCount, 1);
    assert.equal(m.maxDurationMs, 42);
    assert.equal(m.firstAt, '2026-09-26T09:00:00.000Z');
    assert.equal(m.lastAt, '2026-09-26T09:05:00.000Z');
    assert.equal(t.summary.pending(), 0);
  });
});
