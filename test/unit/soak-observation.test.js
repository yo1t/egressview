'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { DAY_MS, createSoakRecord, summarizeSoakHistory } = require('../../src/soak-observation');

const NOW = Date.parse('2026-07-15T00:00:00Z');
const CONSISTENT = {
  missingObservations: 0,
  orphanObservations: 0,
  underMerged: 0,
  kindMismatches: 0,
};

describe('soak observation record', () => {
  it('passes with known build metadata and recent Yamaha/Cisco collection', () => {
    const record = createSoakRecord({
      consistency: CONSISTENT,
      routers: [
        { id: 'yamaha1', kind: 'yamaha', enabled: true, lastSuccessAt: NOW - 1000, ip: '192.168.1.1', user: 'secret' },
        { id: 'cisco1', kind: 'cisco', enabled: true, lastSuccessAt: NOW - 2000 },
      ],
      version: '1.3.5',
      commit: 'abc1234',
      durationMs: 12.4,
      now: NOW,
      processStartedAt: NOW - 60_000,
    });
    assert.equal(record.passed, true);
    assert.equal(record.durationMs, 12);
    assert.equal(record.failureType, null);
    assert.equal(record.routers.length, 2);
    assert.equal('ip' in record.routers[0], false);
    assert.equal('user' in record.routers[0], false);
  });

  it('fails for stale collection, a mismatch, or unknown commit', () => {
    const record = createSoakRecord({
      consistency: { ...CONSISTENT, orphanObservations: 1 },
      routers: [
        { id: 'yamaha1', kind: 'yamaha', enabled: true, lastSuccessAt: NOW - 25 * 60 * 60 * 1000 },
        { id: 'cisco1', kind: 'cisco', enabled: true, lastSuccessAt: NOW - 1000 },
      ],
      version: '1.3.5',
      commit: '',
      durationMs: 1,
      now: NOW,
      processStartedAt: NOW - 60_000,
    });
    assert.equal(record.passed, false);
    assert.equal(record.failureType, 'validation');
    assert.ok(record.failures.includes('orphans=1'));
    assert.ok(record.failures.includes('commit-unknown'));
    assert.ok(record.failures.includes('router-kinds-stale=yamaha'));
  });

  it('opens the v5 gate after seven distinct daily checks and a restart', () => {
    const records = Array.from({ length: 7 }, (_, index) => ({
      checkedAt: new Date(NOW + index * 24 * 60 * 60 * 1000).toISOString(),
      version: '1.3.5',
      commit: 'abc1234',
      processStartedAt: new Date(NOW - 60_000 + (index >= 4 ? 30_000 : 0)).toISOString(),
      passed: true,
    }));
    const summary = summarizeSoakHistory(records);
    assert.equal(summary.readyForV5, true);
    assert.equal(summary.consecutiveChecks, 7);
    assert.equal(summary.distinctDates, 7);
    assert.equal(summary.elapsedDays, 6);
    assert.equal(summary.restartObserved, true);
  });

  it('keeps the streak when an operational error recovers on the same build', () => {
    const records = Array.from({ length: 7 }, (_, index) => ({
      checkedAt: new Date(NOW + index * DAY_MS).toISOString(),
      version: '1.3.5',
      commit: 'abc1234',
      processStartedAt: new Date(NOW - 60_000 + (index >= 4 ? 30_000 : 0)).toISOString(),
      passed: true,
    }));
    records.splice(3, 0, {
      checkedAt: new Date(NOW + 2 * DAY_MS + 60_000).toISOString(),
      version: '1.3.5',
      commit: 'abc1234',
      passed: false,
      failures: ['The operation was aborted due to timeout'],
    });

    const summary = summarizeSoakHistory(records);
    assert.equal(summary.readyForV5, true);
    assert.equal(summary.consecutiveChecks, 7);
    assert.equal(summary.operationalFailures, 1);
    assert.equal(summary.pendingOperationalFailure, false);
  });

  it('blocks readiness while an operational error is not recovered', () => {
    const records = Array.from({ length: 7 }, (_, index) => ({
      checkedAt: new Date(NOW + index * DAY_MS).toISOString(),
      version: '1.3.5',
      commit: 'abc1234',
      processStartedAt: new Date(NOW - 60_000 + (index >= 4 ? 30_000 : 0)).toISOString(),
      passed: true,
    }));
    records.push({
      checkedAt: new Date(NOW + 6 * DAY_MS + 60_000).toISOString(),
      version: '1.3.5',
      commit: 'abc1234',
      passed: false,
      failureType: 'operational',
      failures: ['router status API timeout'],
    });

    const summary = summarizeSoakHistory(records);
    assert.equal(summary.readyForV5, false);
    assert.equal(summary.consecutiveChecks, 7);
    assert.equal(summary.pendingOperationalFailure, true);
  });

  it('resets after a validation failure or an unrecovered daily gap', () => {
    const validation = [
      { checkedAt: new Date(NOW).toISOString(), version: '1.3.5', commit: 'abc1234', passed: true },
      { checkedAt: new Date(NOW + DAY_MS).toISOString(), version: '1.3.5', commit: 'abc1234', passed: false, failureType: 'validation', failures: ['orphans=1'] },
      { checkedAt: new Date(NOW + 2 * DAY_MS).toISOString(), version: '1.3.5', commit: 'abc1234', passed: true },
    ];
    assert.equal(summarizeSoakHistory(validation).consecutiveChecks, 1);

    const gap = [
      { checkedAt: new Date(NOW).toISOString(), version: '1.3.5', commit: 'abc1234', passed: true },
      { checkedAt: new Date(NOW + 60_000).toISOString(), version: '1.3.5', commit: 'abc1234', passed: false, failureType: 'operational', failures: ['timeout'] },
      { checkedAt: new Date(NOW + 48 * 60 * 60 * 1000).toISOString(), version: '1.3.5', commit: 'abc1234', passed: true },
    ];
    assert.equal(summarizeSoakHistory(gap).consecutiveChecks, 1);
  });

  it('resets the streak after a missed day or build change', () => {
    const records = [
      { checkedAt: new Date(NOW).toISOString(), version: '1.3.5', commit: 'aaaaaaa', passed: true },
      { checkedAt: new Date(NOW + 48 * 60 * 60 * 1000).toISOString(), version: '1.3.5', commit: 'aaaaaaa', passed: true },
      { checkedAt: new Date(NOW + 72 * 60 * 60 * 1000).toISOString(), version: '1.3.5', commit: 'bbbbbbb', passed: true },
    ];
    const summary = summarizeSoakHistory(records);
    assert.equal(summary.readyForV5, false);
    assert.equal(summary.consecutiveChecks, 1);
  });
});
