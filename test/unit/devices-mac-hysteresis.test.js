'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const devices = require('../../src/devices');

// P3-138. Two IPs on the production Hub alternated between two globally unique
// MACs every poll. The operator saw the vendor and name change under them,
// every flip wrote another observation row, and the merge logic absorbed live
// hardware into the wrong device eleven times.
// Globally unique addresses, both of them: the second-least-significant bit of
// the first octet is what separates real hardware from a randomised address,
// and hysteresis only applies when both sides name real hardware.
const MAC_A = '7C:DF:A1:5D:E7:2C';
const MAC_B = '3C:A9:AB:09:77:F1';
const IP = '192.0.2.55';

let dir;
beforeEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-mac-hysteresis-'));
  devices._initForTest(path.join(dir, 'test.db'));
});

const observe = (mac, vendor) => devices.observeDevice({
  ip: IP, mac, vendor, source: 'yamaha1', lastSeen: Date.now(),
});

describe('端末は2分ごとにハードウェアを変えたりしない（P3-138）', () => {
  it('一度きりの別MACでは、記録されている身元を変えない', () => {
    observe(MAC_A, 'Vendor A');
    observe(MAC_B, 'Vendor B');
    const device = devices.getByIp(IP);
    assert.equal(device.mac, MAC_A);
    // The vendor follows the MAC: keeping the new vendor beside the old MAC
    // would state something neither report made.
    assert.equal(device.vendor, 'Vendor A');
  });

  it('同じ新しいMACが3回続いたら、身元が移る', () => {
    observe(MAC_A, 'Vendor A');
    observe(MAC_B, 'Vendor B');
    assert.equal(devices.getByIp(IP).mac, MAC_A, '1回目では移らない');
    observe(MAC_B, 'Vendor B');
    assert.equal(devices.getByIp(IP).mac, MAC_A, '2回目でも移らない');
    observe(MAC_B, 'Vendor B');
    assert.equal(devices.getByIp(IP).mac, MAC_B, '3回目で移る');
    assert.equal(devices.getByIp(IP).vendor, 'Vendor B');
  });

  it('入れ替わっている間は、いつまでも移らない', () => {
    observe(MAC_A, 'Vendor A');
    // Ends on the new MAC, so passing cannot mean "the last report happened to
    // be the old one".
    for (let i = 0; i <= 20; i++) observe(i % 2 === 0 ? MAC_B : MAC_A, 'Vendor');
    assert.equal(devices.getByIp(IP).mac, MAC_A,
      '交互に報告され続ける限り、身元は動いてはいけない');
  });

  it('押し戻した回数を数えるので、入れ替わりが外から見える', () => {
    observe(MAC_A, 'Vendor A');
    observe(MAC_B, 'Vendor B');
    observe(MAC_A, 'Vendor A');
    observe(MAC_B, 'Vendor B');
    const held = devices.getHeldMacSwitches();
    assert.equal(held.length, 1);
    assert.equal(held[0].ip, IP);
    assert.equal(held[0].recorded, MAC_A);
    assert.equal(held[0].proposed, MAC_B);
    assert.equal(held[0].count, 2);
  });

  it('MACが無かったIPには、最初の報告をそのまま採る', () => {
    observe(null, null);
    observe(MAC_A, 'Vendor A');
    assert.equal(devices.getByIp(IP).mac, MAC_A);
  });

  it('ランダム化されたMACには適用しない', () => {
    // A locally administered address is expected to change; holding one steady
    // would be pretending a privacy feature is a fault.
    const PRIVATE_A = '7E:1F:0C:45:8F:AD';
    const PRIVATE_B = '7A:2B:3C:4D:5E:6F';
    observe(PRIVATE_A, 'Vendor A');
    observe(PRIVATE_B, 'Vendor B');
    assert.equal(devices.getByIp(IP).mac, PRIVATE_B);
  });
});
