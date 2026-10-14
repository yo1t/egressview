'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const {
  findLanScans, windowsToCheck, createLanScanCooldown, WINDOW_MS,
} = require('../../src/lan-scan-detector');

// P3-191. Thresholds come from seven days of production: at most 17 LAN
// addresses and 7 non-ephemeral ports on one address, per process per 2 min.
function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (agentId TEXT PRIMARY KEY, hostName TEXT);
    CREATE TABLE agent_observations (
      agentId TEXT, observationId TEXT, processName TEXT, localAddress TEXT,
      remoteAddress TEXT, remotePort INTEGER, networkProtocol TEXT,
      firstObservedAt INTEGER, lastObservedAt INTEGER, bytesIn INTEGER, bytesOut INTEGER);
    INSERT INTO agents VALUES ('a1', 'JAMESBOND'), ('a2', 'Quartermaster');
  `);
  return db;
}
let seq = 0;
function observe(db, row) {
  db.prepare(`INSERT INTO agent_observations VALUES (@agentId, @id, @processName, @localAddress,
    @remoteAddress, @remotePort, 'tcp', @at, @at, 0, 0)`).run({
    agentId: 'a1', id: `o${++seq}`, processName: 'chrome', localAddress: '192.168.1.50', remotePort: 80, ...row,
  });
}

describe('LAN scan detection', () => {
  const from = 10 * WINDOW_MS;

  it('2分間に30以上のLAN内アドレスへ接続したプロセスを掃引として見つける', () => {
    const db = database();
    for (let i = 1; i <= 40; i += 1) observe(db, { remoteAddress: `192.168.1.${i}`, at: from + i * 1000 });
    const findings = findLanScans(db, { from });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'sweep');
    assert.equal(findings[0].addresses, 40);
    assert.equal(findings[0].hostName, 'JAMESBOND');
    assert.equal(findings[0].processName, 'chrome');
    assert.equal(findings[0].sample.length, 5);
  });

  it('ふだんの範囲（17アドレス）や、マルチキャスト・ブロードキャスト・インターネット宛ては数えない', () => {
    const db = database();
    for (let i = 1; i <= 17; i += 1) observe(db, { remoteAddress: `192.168.1.${i}`, at: from + i });
    for (let i = 1; i <= 40; i += 1) observe(db, { remoteAddress: `198.51.100.${i}`, at: from + i });
    for (let i = 1; i <= 40; i += 1) observe(db, { remoteAddress: `239.255.0.${i}`, at: from + i });
    observe(db, { remoteAddress: '192.168.1.255', at: from + 1 });
    assert.deepEqual(findLanScans(db, { from }), []);
  });

  it('1台の10以上のポートへの接続をポートの探索として見つけ、相手側の一時ポートは数えない', () => {
    const db = database();
    for (let p = 20; p < 32; p += 1) observe(db, { remoteAddress: '192.168.1.1', remotePort: p, at: from + p });
    for (let p = 0; p < 500; p += 1) observe(db, { processName: 'zabbix_agent2', remoteAddress: '10.0.0.5', remotePort: 40000 + p, at: from + p });
    const findings = findLanScans(db, { from });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'port-probe');
    assert.equal(findings[0].target, '192.168.1.1');
    assert.equal(findings[0].ports, 12);
    assert.deepEqual(findings[0].sample, [20, 21, 22, 23, 24]);
  });

  it('窓の外の観測は数えない', () => {
    const db = database();
    for (let i = 1; i <= 40; i += 1) observe(db, { remoteAddress: `192.168.1.${i}`, at: from + WINDOW_MS + i });
    assert.deepEqual(findLanScans(db, { from }), []);
  });

  it('終わってから1分たった窓を1回ずつ、取りこぼさずに見る', () => {
    const now = 100 * WINDOW_MS + 90 * 1000;
    const first = windowsToCheck({ now, lastChecked: null });
    assert.deepEqual(first, [99 * WINDOW_MS]);
    assert.deepEqual(windowsToCheck({ now, lastChecked: 99 * WINDOW_MS }), []);
    assert.deepEqual(windowsToCheck({ now: now + 2 * WINDOW_MS, lastChecked: 99 * WINDOW_MS }), [100 * WINDOW_MS, 101 * WINDOW_MS]);
    assert.equal(windowsToCheck({ now: now + 100 * WINDOW_MS, lastChecked: 99 * WINDOW_MS }).length, 5, '止まっていた間は直近5窓まで');
  });

  it('同じプロセス・同じ種類の通知は1時間に1回', () => {
    const cooldown = createLanScanCooldown();
    const finding = { agentId: 'a1', processName: 'chrome', kind: 'sweep' };
    assert.equal(cooldown.admit(finding, 0), true);
    assert.equal(cooldown.admit(finding, 30 * 60 * 1000), false);
    assert.equal(cooldown.admit({ ...finding, kind: 'port-probe', target: '192.168.1.1' }, 30 * 60 * 1000), true);
    assert.equal(cooldown.admit(finding, 61 * 60 * 1000), true);
  });
});
