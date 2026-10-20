'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const {
  findLanScans, windowsToCheck, createLanScanCooldown, WINDOW_MS,
  cooldownSeedsFromLog, lanScanCooldownKey, inboundProbeCooldownKey,
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

  it('送信元が決まる前に失敗した接続だけの掃引でも、送信元に0.0.0.0を出さない', () => {
    const db = database();
    observe(db, { processName: 'Safari', remoteAddress: '192.168.1.9', at: from - 60_000 });
    for (let i = 1; i <= 40; i += 1) {
      observe(db, { processName: 'curl', localAddress: '0.0.0.0', remoteAddress: `192.168.1.${i}`, at: from + i * 1000 });
    }
    const [finding] = findLanScans(db, { from });
    assert.equal(finding.kind, 'sweep');
    assert.equal(finding.localAddress, '192.168.1.50', 'そのAgentの直近の、送信元が分かる接続のアドレス');
  });

  it('送信元を補うときは、探した先と同じ種類（IPv4/IPv6）のアドレスを優先する', () => {
    // 2026-10-21: an IPv4 sweep was named by the Mac's global IPv6 address,
    // its latest connection, instead of its LAN address.
    const db = database();
    observe(db, { processName: 'Safari', localAddress: '192.168.1.50', remoteAddress: '192.168.1.9', at: from - 120_000 });
    observe(db, { processName: 'Safari', localAddress: '2001:db8::50', remoteAddress: '2001:db8::1', at: from - 60_000 });
    for (let i = 1; i <= 40; i += 1) {
      observe(db, { processName: 'curl', localAddress: '0.0.0.0', remoteAddress: `192.168.1.${i}`, at: from + i * 1000 });
    }
    for (let i = 1; i <= 12; i += 1) {
      observe(db, { processName: 'nc', localAddress: '::', remoteAddress: 'fe80::1', remotePort: 20 + i, at: from + i });
    }
    const byKind = Object.fromEntries(findLanScans(db, { from }).map(f => [f.kind, f]));
    assert.equal(byKind.sweep.localAddress, '192.168.1.50', 'IPv4の掃引にはIPv4');
    assert.equal(byKind['port-probe'].localAddress, '2001:db8::50', 'IPv6の相手にはIPv6');
  });

  it('同じ種類が無ければ、もう一方の種類を使う', () => {
    const db = database();
    observe(db, { processName: 'Safari', localAddress: '2001:db8::50', remoteAddress: '2001:db8::1', at: from - 60_000 });
    for (let i = 1; i <= 40; i += 1) {
      observe(db, { processName: 'curl', localAddress: '0.0.0.0', remoteAddress: `192.168.1.${i}`, at: from + i * 1000 });
    }
    assert.equal(findLanScans(db, { from })[0].localAddress, '2001:db8::50');
  });

  it('送信元が分かる接続が混じっていれば、そのアドレスを使い、無ければnull', () => {
    const db = database();
    for (let i = 1; i <= 40; i += 1) {
      observe(db, { localAddress: i === 7 ? '192.168.1.60' : '::', remoteAddress: `192.168.1.${i}`, at: from + i * 1000 });
    }
    assert.equal(findLanScans(db, { from })[0].localAddress, '192.168.1.60');
    const empty = database();
    for (let p = 20; p < 32; p += 1) {
      observe(empty, { localAddress: '0.0.0.0', remoteAddress: '192.168.1.1', remotePort: p, at: from + p });
    }
    const [probe] = findLanScans(empty, { from });
    assert.equal(probe.kind, 'port-probe');
    assert.equal(probe.localAddress, null, '分からないものは分からないまま');
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

  describe('再起動をまたぐ1時間の制限', () => {
    const now = 1_800_000_000_000;
    const rows = [
      { src: '192.168.1.50', threatSource: 'curl', detectedAt: now - 10 * 60_000,
        threatTag: JSON.stringify({ kind: 'sweep', agentId: 'a1', target: null }) },
      { src: '192.168.1.50', threatSource: 'nc', detectedAt: now - 5 * 60_000,
        threatTag: JSON.stringify({ kind: 'port-probe', agentId: 'a1', target: '192.168.1.1' }) },
      { src: '10.0.0.5', threatSource: null, detectedAt: now - 3 * 60_000,
        threatTag: JSON.stringify({ kind: 'probed', agentId: 'a1', protocol: 'tcp' }) },
      // Written before the log carried agentId, or unreadable: skipped.
      { src: '192.168.1.50', threatSource: 'curl', detectedAt: now - 2 * 60_000,
        threatTag: JSON.stringify({ kind: 'sweep', target: null }) },
      { src: '192.168.1.50', threatSource: 'curl', detectedAt: now - 60_000, threatTag: 'not json' },
    ];

    it('検出ログの行から、プログラムと探られた側の制限を作り直す', () => {
      const { programs, probed } = cooldownSeedsFromLog(rows);
      assert.deepEqual(programs, [
        { key: lanScanCooldownKey({ agentId: 'a1', processName: 'curl', kind: 'sweep' }), at: now - 10 * 60_000 },
        { key: lanScanCooldownKey({ agentId: 'a1', processName: 'nc', kind: 'port-probe', target: '192.168.1.1' }), at: now - 5 * 60_000 },
      ]);
      assert.deepEqual(probed, [
        { key: inboundProbeCooldownKey({ agentId: 'a1', sourceAddress: '10.0.0.5', networkProtocol: 'tcp' }), at: now - 3 * 60_000 },
      ]);
    });

    it('作り直した制限があれば、再起動直後の同じ掃引は1時間以内に通知しない', () => {
      const cooldown = createLanScanCooldown();
      for (const { key, at } of cooldownSeedsFromLog(rows).programs) cooldown.seed(key, at);
      const sweep = { agentId: 'a1', processName: 'curl', kind: 'sweep', target: null };
      assert.equal(cooldown.admit(sweep, now), false, '10分前に通知済み');
      assert.equal(cooldown.admit({ ...sweep, processName: 'python3' }, now), true, '別のプログラムは通知する');
      assert.equal(cooldown.admit(sweep, now + 51 * 60_000), true, '1時間を過ぎれば通知する');
    });

    it('作り直しは、新しい記録を古い時刻で上書きしない', () => {
      const cooldown = createLanScanCooldown();
      const sweep = { agentId: 'a1', processName: 'curl', kind: 'sweep', target: null };
      assert.equal(cooldown.admit(sweep, now), true);
      cooldown.seed(lanScanCooldownKey(sweep), now - 59 * 60_000);
      assert.equal(cooldown.admit(sweep, now + 2 * 60_000), false, '直前の通知が効いたまま');
    });
  });
});
