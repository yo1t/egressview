// Unit tests for the MCP audit retention schedule (P2-73)
// Run: node --test test/unit/mcp-audit-prune-schedule.test.js
//
// Retention was previously enforced only by the single prune() call at
// startup, so a long-running MCP process never applied the documented
// 180-day window. These cases pin the recurring schedule.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const mcpAudit = require('../../src/mcp-audit');

const DAY_MS = 24 * 60 * 60 * 1000;

function appendAged(ageDays) {
  const id = mcpAudit.append({ eventType: 'mcp_tool_call', outcome: 'success' });
  // append() stamps createdAt itself, so age the row directly.
  mcpAudit._dbForTest()
    .prepare('UPDATE mcp_audit_events SET createdAt = ? WHERE eventId = ?')
    .run(Date.now() - ageDays * DAY_MS, id);
  return id;
}

describe('MCP監査 retention の定期実行', () => {
  afterEach(() => { mcpAudit.stopPruneSchedule(); });

  it('既定間隔は24時間', () => {
    assert.equal(mcpAudit.PRUNE_INTERVAL_MS, DAY_MS);
  });

  it('長期稼働プロセスでも保持期間超過行が削除される', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    mcpAudit._resetForTest(':memory:');
    appendAged(200);
    appendAged(1);
    assert.equal(mcpAudit.list().length, 2, '起動直後は両方残っている');

    mcpAudit.startPruneSchedule();
    // Nothing should happen before the first interval elapses.
    t.mock.timers.tick(DAY_MS - 1);
    assert.equal(mcpAudit.list().length, 2);

    t.mock.timers.tick(1);
    const remaining = mcpAudit.list();
    assert.equal(remaining.length, 1, '180日を超えた行だけ削除されること');
  });

  it('繰り返し発火し、そのたびに評価する', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    mcpAudit._resetForTest(':memory:');
    mcpAudit.startPruneSchedule();

    appendAged(200);
    t.mock.timers.tick(DAY_MS);
    assert.equal(mcpAudit.list().length, 0);

    appendAged(300);
    t.mock.timers.tick(DAY_MS);
    assert.equal(mcpAudit.list().length, 0, '2回目以降も削除されること');
  });

  it('retentionDays を指定でき、期間内の行は残す', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    mcpAudit._resetForTest(':memory:');
    appendAged(100);
    mcpAudit.startPruneSchedule({ retentionDays: 90 });
    t.mock.timers.tick(DAY_MS);
    assert.equal(mcpAudit.list().length, 0);

    appendAged(10);
    t.mock.timers.tick(DAY_MS);
    assert.equal(mcpAudit.list().length, 1, '保持期間内の行は残ること');
  });

  it('二重起動しても timer は1本だけ', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    mcpAudit._resetForTest(':memory:');
    const first = mcpAudit.startPruneSchedule();
    const second = mcpAudit.startPruneSchedule();
    assert.notEqual(first, second, '前の timer は破棄され新しい timer が返ること');
    appendAged(200);
    t.mock.timers.tick(DAY_MS);
    assert.equal(mcpAudit.list().length, 0);
  });

  it('stopPruneSchedule 後は発火しない', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    mcpAudit._resetForTest(':memory:');
    mcpAudit.startPruneSchedule();
    mcpAudit.stopPruneSchedule();
    appendAged(200);
    t.mock.timers.tick(DAY_MS * 3);
    assert.equal(mcpAudit.list().length, 1, '停止後は削除されないこと');
  });

  it('DBが閉じていても発火が例外を投げない', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    mcpAudit._resetForTest(':memory:');
    mcpAudit.startPruneSchedule();
    mcpAudit.closeDb();
    // prune() swallows its own errors, so a scheduled tick must stay silent
    // rather than taking down the MCP process.
    assert.doesNotThrow(() => t.mock.timers.tick(DAY_MS));
  });

  it('timer は unref 済みでイベントループを保持しない', () => {
    mcpAudit._resetForTest(':memory:');
    const timer = mcpAudit.startPruneSchedule();
    assert.equal(typeof timer.hasRef, 'function');
    assert.equal(timer.hasRef(), false);
  });
});
