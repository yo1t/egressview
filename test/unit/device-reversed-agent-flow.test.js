'use strict';

// Windows Agents have reported some flows the wrong way round: a Microsoft or
// Cloudflare server as the computer, and the computer's LAN address as the far
// end. Each such flow made a device row for the server (P3-199, 2026-11-26).
// Here 10.0.0.x stands for the LAN and 203.0.113.x / 198.51.100.x for servers
// on the internet.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const devices = require('../../src/devices');

beforeEach(() => devices._initForTest());
after(() => devices._initForTest());

function rowAt(ip) {
  return devices.getAll({ includeArchived: true }).find(row => row.ip === ip);
}

describe('向きが逆に届いたAgentの通信から、サーバーの行を作らない', () => {
  it('送り元が公開アドレスで宛先がLAN内なら、逆向きとみなす', () => {
    assert.equal(devices.isReversedAgentFlow('203.0.113.203', '10.0.0.129'), true);
    // A computer carried off the LAN, on a public address, reaching a server.
    assert.equal(devices.isReversedAgentFlow('198.51.100.20', '203.0.113.203'), false);
    // The usual shape: the computer on the LAN reaching a server.
    assert.equal(devices.isReversedAgentFlow('10.0.0.129', '203.0.113.203'), false);
    assert.equal(devices.isReversedAgentFlow('10.0.0.129', '10.0.0.1'), false);
    assert.equal(devices.isReversedAgentFlow('203.0.113.203', '2001:db8::1'), false);
    assert.equal(devices.isReversedAgentFlow('203.0.113.203', null), false);
  });

  it('Agentの逆向きの通信では新しい行を作らず、持ち出したPCの公開アドレスの行は作る', () => {
    assert.equal(devices.observeDevice({ ip: '203.0.113.203', peer: '10.0.0.129', source: 'agent' }), null);
    assert.equal(rowAt('203.0.113.203'), undefined);
    assert.ok(devices.observeDevice({ ip: '198.51.100.20', peer: '203.0.113.203', source: 'agent' }));
    assert.ok(rowAt('198.51.100.20'));
  });

  it('ルーターが見た通信なら、同じ形でも行を作る', () => {
    assert.ok(devices.observeDevice({ ip: '203.0.113.203', peer: '10.0.0.129', source: 'nat' }));
    assert.ok(rowAt('203.0.113.203'));
  });

  it('起動時の書き戻しでも、ルーターが見ていない逆向きの通信からは行を作らない', () => {
    devices.seedFromConnectionHistory(new Map([
      ['a', { src: '203.0.113.203', dst: '10.0.0.129', agentHost: 'pc', observedBy: [], firstSeen: 1, lastSeen: 2 }],
      ['b', { src: '198.51.100.20', dst: '203.0.113.203', agentHost: 'pc', observedBy: [], firstSeen: 1, lastSeen: 2 }],
      ['c', { src: '203.0.113.50', dst: '10.0.0.129', agentHost: 'pc', observedBy: ['r1'], firstSeen: 1, lastSeen: 2 }],
    ]));
    assert.deepEqual(devices.getAll().map(row => row.ip).sort(), ['198.51.100.20', '203.0.113.50']);
  });
});

describe('逆向きの通信からできた、今ある行を非表示にする', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egv-reversed-'));
  });
  after(() => devices._initForTest());

  function openWithConnections(rows) {
    const file = path.join(dir, 'hub.db');
    const raw = new Database(file);
    raw.exec('CREATE TABLE connections (src TEXT, dst TEXT, agentHost TEXT)');
    const insert = raw.prepare('INSERT INTO connections (src, dst, agentHost) VALUES (?, ?, ?)');
    for (const row of rows) insert.run(row.src, row.dst, row.agentHost ?? null);
    raw.close();
    devices.initDb(file);
  }

  it('Agentだけが見た公開アドレスの行で、通信がすべて逆向きなら非表示にする。消さない', () => {
    openWithConnections([
      { src: '203.0.113.203', dst: '10.0.0.129', agentHost: 'pc' },
      { src: '203.0.113.203', dst: '10.0.0.133', agentHost: 'pc' },
      { src: '198.51.100.20', dst: '203.0.113.203', agentHost: 'pc' },
    ]);
    devices.upsert({ ip: '203.0.113.203', source: 'agent' });
    devices.upsert({ ip: '203.0.113.203', source: 'nat' });
    devices.upsert({ ip: '198.51.100.20', source: 'agent' });

    assert.equal(devices.archiveNonDevices(), 1);
    assert.equal(rowAt('203.0.113.203').status, 'archived');
    assert.notEqual(rowAt('198.51.100.20').status, 'archived');
    assert.equal(devices.archiveNonDevices(), 0, 'nothing left the second time');
  });

  it('逆向きでない通信が1つでもあるか、通信の記録が無いか、ルーターが見た行は残す', () => {
    openWithConnections([
      { src: '203.0.113.60', dst: '10.0.0.129', agentHost: 'pc' },
      { src: '203.0.113.60', dst: '203.0.113.203', agentHost: 'pc' },
      { src: '203.0.113.70', dst: '10.0.0.129', agentHost: 'pc' },
    ]);
    devices.upsert({ ip: '203.0.113.60', source: 'agent' });
    devices.upsert({ ip: '203.0.113.61', source: 'agent' });
    devices.upsert({ ip: '203.0.113.70', source: 'agent' });
    devices.upsert({ ip: '203.0.113.70', source: 'yamaha' });

    assert.equal(devices.archiveNonDevices(), 0);
  });
});
