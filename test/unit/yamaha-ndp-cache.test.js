'use strict';

// `show ipv6 neighbor cache` on a Yamaha RTX: which global IPv6 addresses the
// LAN1 neighbours hold, and, when none are kept, why (P3-200).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseNdpCache, describeEmptyNdp } = require('../../src/pollers/yamaha');

const SAMPLE = [
  'show ipv6 neighbor cache',
  '2001:db8:0:ed00:5de6:a5c8:44fb:a1e5    aa:bb:cc:dd:ee:01 LAN1  REACHABLE',
  '2001:db8:0:ed00::20                    AA:BB:CC:DD:EE:01 LAN1  STALE',
  'fe80::a8bb:ccff:fedd:ee02              aa:bb:cc:dd:ee:02 LAN1  REACHABLE',
  '2001:db8:1::1                          aa:bb:cc:dd:ee:03 LAN2  REACHABLE',
  '2001:db8:1::2                          aa:bb:cc:dd:ee:04 LAN2  STALE',
  '',
].join('\r\n');

describe('Yamahaの近隣キャッシュを読む', () => {
  it('LAN1のグローバルアドレスだけをMACごとに残す。MACは小文字に揃える', () => {
    const { byMac } = parseNdpCache(SAMPLE);
    assert.deepEqual([...byMac.keys()], ['aa:bb:cc:dd:ee:01']);
    assert.deepEqual(byMac.get('aa:bb:cc:dd:ee:01'), ['2001:db8:0:ed00:5de6:a5c8:44fb:a1e5', '2001:db8:0:ed00::20']);
  });

  it('残さなかった行も数える。リンクローカルと、LAN1以外のインターフェース', () => {
    const result = parseNdpCache(SAMPLE);
    assert.equal(result.rows, 5);
    assert.equal(result.linkLocal, 1);
    assert.deepEqual(result.otherInterfaces, { LAN2: 2 });
  });
});

describe('0件だったとき、理由をログに書く', () => {
  it('行が1つも無ければ、キャッシュが空だったと分かる', () => {
    const result = parseNdpCache('show ipv6 neighbor cache\r\n\r\n');
    assert.equal(result.byMac.size, 0);
    assert.equal(describeEmptyNdp(result), 'no neighbour rows in 1 line(s) of output');
  });

  it('行があってLAN1以外なら、どのインターフェースに何行あったかを書く', () => {
    const result = parseNdpCache([
      'show ipv6 neighbor cache',
      'fe80::1                                aa:bb:cc:dd:ee:05 LAN1  REACHABLE',
      '2001:db8:2::5                          aa:bb:cc:dd:ee:06 LAN3  REACHABLE',
    ].join('\n'));
    assert.equal(result.byMac.size, 0);
    assert.equal(describeEmptyNdp(result), '2 neighbour row(s): link-local on LAN1 1, on other interfaces LAN3 1');
  });

  it('空の出力でも落ちない', () => {
    const result = parseNdpCache(undefined);
    assert.equal(result.byMac.size, 0);
    assert.equal(describeEmptyNdp(result), 'no neighbour rows in 0 line(s) of output');
  });
});
