'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const volume = require('../../src/agent-delivery-volume');

const HOUR = volume.HOUR_MS;
const base = Date.parse('2026-11-21T00:00:00Z');
const agentA = '00000000-0000-4000-8000-00000000000a';
const agentB = '00000000-0000-4000-8000-00000000000b';

let db;
beforeEach(() => {
  db = new Database(':memory:');
  volume.ensureDeliveryVolumeTables(db, { now: base });
});

describe('Hubへ送った量', () => {
  it('Agentごとに送信の回数・大きさ・古くて除いた件数を足す', () => {
    volume.recordDelivery(db, { agentId: agentA, at: base + 10, contentLength: '1200' });
    volume.recordDelivery(db, { agentId: agentA, at: base + HOUR + 10, contentLength: '800', expired: 3 });
    volume.recordDelivery(db, { agentId: agentB, at: base + 20, contentLength: '50' });

    const listed = volume.listDeliveryVolume(db, { since: base });
    assert.equal(listed.startedAt, base);
    const byAgent = Object.fromEntries(listed.agents.map(row => [row.agentId, row]));
    assert.deepEqual(byAgent[agentA], { agentId: agentA, requests: 2, requestsWithoutSize: 0, bytes: 2000, expired: 3 });
    assert.deepEqual(byAgent[agentB], { agentId: agentB, requests: 1, requestsWithoutSize: 0, bytes: 50, expired: 0 });
  });

  it('大きさが無い・読めない送信は、回数にだけ数えて大きさの無い回として残す', () => {
    for (const contentLength of [undefined, '', 'abc', '-5', '1e9', '9'.repeat(16)]) {
      volume.recordDelivery(db, { agentId: agentA, at: base, contentLength });
    }
    const [row] = volume.listDeliveryVolume(db, { since: base }).agents;
    assert.equal(row.requests, 6);
    assert.equal(row.requestsWithoutSize, 6);
    assert.equal(row.bytes, 0);
  });

  it('期間の始まりより前の時間帯は数えず、古い時間帯は整理で消える', () => {
    volume.recordDelivery(db, { agentId: agentA, at: base, contentLength: '100' });
    volume.recordDelivery(db, { agentId: agentA, at: base + 2 * HOUR, contentLength: '10' });

    assert.equal(volume.listDeliveryVolume(db, { since: base + 2 * HOUR + 5 }).agents[0].bytes, 10);
    assert.equal(volume.pruneDeliveryVolume(db, base + HOUR), 1);
    assert.equal(volume.listDeliveryVolume(db, { since: base }).agents[0].bytes, 10);
  });

  it('表を作り直しても、数え始めた時刻は変わらない', () => {
    volume.ensureDeliveryVolumeTables(db, { now: base + 5 * HOUR });
    assert.equal(volume.listDeliveryVolume(db, { since: base }).startedAt, base);
  });
});
