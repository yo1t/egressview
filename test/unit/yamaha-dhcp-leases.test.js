'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseDhcpStatus } = require('../../src/pollers/yamaha');

// Captured from the RTX on 2026-09-20, addresses and names changed. The pager
// break in the middle of a label is real and is the reason this parser does
// not work line by line.
const REAL_OUTPUT = [
  'show status dhcp',
  'DHCPスコープ番号: 1',
  '   ネットワークアドレス: 192.0.2.0',
  '               割り当て中アドレス: 192.0.2.10',
  ' クライアントイーサネットアドレス: 04:c4:61:ca:3d:32',
  '                     リース残時間: 2日 13時間 37分 41秒',
  '               割り当て中アドレス: 192.0.2.11',
  ' クライアントイーサネットアドレス: b0:e9:fe:89:b0:f7',
  '                         ホスト名: SwitchBot-WeatherStation-89B0F7',
  '                     リース残時間: 2日 23時間 48分 4秒',
  '               割り当て中アドレス: 192.0.2.15',
  '---つづく---             クライアントイーサネットアドレス: 62:27:37:ff:13:f9',
  '                         ホスト名: iPhone',
  '                     リース残時間: 1日 22時間 11分 15秒',
  '               割り当て中アドレス: 192.0.2.16',
  ' クライアントイーサネットアドレス: 28:D5:B1:38:6E:E1',
  '                         ホスト名: yo1-007',
  '                     リース残時間: 2日 23時間 25分 13秒',
].join('\r\n');

describe('DHCPサーバの台帳を読む（P3-138）', () => {
  it('実機の出力から、アドレス・MAC・ホスト名を取り出す', () => {
    const leases = parseDhcpStatus(REAL_OUTPUT);
    assert.equal(leases.length, 4);
    assert.deepEqual(leases[1], { ip: '192.0.2.11', mac: 'b0:e9:fe:89:b0:f7', host: 'SwitchBot-WeatherStation-89B0F7' });
  });

  it('ページャが行の途中で割り込んでも落とさない', () => {
    // This lease's label was split by "---つづく---" in the captured output.
    const lease = parseDhcpStatus(REAL_OUTPUT).find(l => l.ip === '192.0.2.15');
    assert.equal(lease.mac, '62:27:37:ff:13:f9');
    assert.equal(lease.host, 'iPhone');
  });

  it('ホスト名を名乗らないリースも取りこぼさない', () => {
    const lease = parseDhcpStatus(REAL_OUTPUT).find(l => l.ip === '192.0.2.10');
    assert.equal(lease.mac, '04:c4:61:ca:3d:32');
    assert.equal(lease.host, null);
  });

  it('MACは小文字に揃える。同じ台帳の中で表記が割れてはいけない', () => {
    const lease = parseDhcpStatus(REAL_OUTPUT).find(l => l.ip === '192.0.2.16');
    assert.equal(lease.mac, '28:d5:b1:38:6e:e1');
  });

  it('MACの無いブロックは、リースとして数えない', () => {
    const partial = '割り当て中アドレス: 192.0.2.99\r\n                     リース残時間: 1日\r\n';
    assert.deepEqual(parseDhcpStatus(partial), []);
  });

  it('空の出力でも落ちない', () => {
    assert.deepEqual(parseDhcpStatus(''), []);
    assert.deepEqual(parseDhcpStatus(null), []);
  });
});
