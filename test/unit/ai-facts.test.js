'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildAiFacts, collectionFacts } = require('../../src/ai-facts');

describe('AI facts snapshot', () => {
  it('compares the selected period with the immediately preceding period', () => {
    const calls = [];
    const history = {
      countFactsByTimeRange(from, to) {
        calls.push(['facts', from, to]);
        return from === 100 ? { connections: 5, devices: 2, destinations: 3 }
          : { connections: 4, devices: 1, destinations: 2 };
      },
      groupDstByTimeRange(from, to) {
        calls.push(['threats', from, to]);
        return from === 100
          ? [{ dst: 'danger.example', cnt: 2 }, { dst: 'safe.example', cnt: 3 }]
          : [{ dst: 'warn.example', cnt: 1 }, { dst: 'safe.example', cnt: 3 }];
      },
    };
    const threatIntel = {
      matchThreatIntel(dst) {
        if (dst === 'danger.example') return { confidence: 'high' };
        if (dst === 'warn.example') return { confidence: 'low' };
        return null;
      },
    };
    const result = buildAiFacts({ history, threatIntel, routers: [], from: 100, to: 200, serverTime: 250 });

    assert.deepEqual(result.range, { from: 100, to: 200, durationMs: 100 });
    assert.deepEqual(result.previousRange, { from: 0, to: 100, durationMs: 100 });
    assert.deepEqual(result.current, {
      connections: 5, devices: 2, destinations: 3, safe: 3, warn: 0, danger: 2,
    });
    assert.deepEqual(result.previous, {
      connections: 4, devices: 1, destinations: 2, safe: 3, warn: 1, danger: 0,
    });
    assert.equal(calls.length, 4);
  });

  it('reports aggregate collection health without router addresses or credentials', () => {
    const facts = collectionFacts([
      { id: 'r1', kind: 'yamaha', displayName: 'Primary', ip: '192.0.2.1', user: 'admin', enabled: true, ready: true, sessionCount: 12, lastSuccessAt: 50 },
      { id: 'r2', kind: 'cisco', displayName: 'Backup', enabled: true, ready: false, sessionCount: 0, lastSuccessAt: 40 },
      { id: 'r3', kind: 'cisco', displayName: 'Stopped', enabled: false, ready: false },
    ]);
    assert.equal(facts.health, 'partial');
    assert.equal(facts.enabledCount, 2);
    assert.equal(facts.readyCount, 1);
    assert.equal(facts.reportedSessions, 12);
    assert.equal(facts.lastUpdatedAt, 50);
    assert.equal(JSON.stringify(facts).includes('192.0.2.1'), false);
    assert.equal(JSON.stringify(facts).includes('admin'), false);
  });
});
