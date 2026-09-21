'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const devices = require('../../src/devices');
const deviceIdentify = require('../../src/device-identify');
const { isStableMac } = require('../../src/mac');

let dir;
beforeEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-device-address-'));
  devices._initForTest(path.join(dir, 'test.db'));
});

// P3-138. Agents report every address their machine holds, and each one became
// a row: 305 of 427 rows on the production Hub were not devices.
describe('端末一覧に載るのは端末だけ', () => {
  it('1台が持つ「端末ではないアドレス」を弾く', () => {
    for (const ip of [
      '0.0.0.0', '127.0.0.1', '169.254.83.107', '224.0.0.251', '255.255.255.255',
      '::', '::1', 'fe80::1c84:a206:8a4d:f973%en0', 'fe80::3cd1:55ff:fe42:aa09%awdl0',
      '240d:1a:55e:ed00:a0c4:f73f:92dc:397c', 'fd7a:115c:a1e0::403a:b471',
      '100.125.180.112',
    ]) {
      assert.equal(devices.isDeviceAddress(ip), false, `弾けていない: ${ip}`);
    }
  });

  it('本物の端末のアドレスは通す', () => {
    for (const ip of ['192.168.1.50', '10.0.0.5', '172.16.173.1', '203.0.113.9']) {
      assert.equal(devices.isDeviceAddress(ip), true, `弾いてはいけない: ${ip}`);
    }
  });

  it('壊れた入力でも判断を誤らない', () => {
    for (const ip of [null, undefined, '', 'not-an-ip', '1.2.3', '1.2.3.4.5']) {
      assert.equal(devices.isDeviceAddress(ip), false);
    }
  });

  it('弾いたアドレスは、行を作らない', () => {
    const now = Date.now();
    assert.equal(devices.observeDevice({ ip: '0.0.0.0', source: 'agent', lastSeen: now }), null);
    assert.equal(devices.observeDevice({ ip: 'fe80::1%en0', source: 'agent', lastSeen: now }), null);
    assert.equal(devices.observeDevice({ ip: '240d:1a:55e:ed00::1', source: 'agent', lastSeen: now }), null);
    assert.equal(devices.getAll().length, 0, '端末でないものが一覧に入っている');

    assert.notEqual(devices.observeDevice({ ip: '192.168.1.50', source: 'agent', lastSeen: now }), null);
    assert.equal(devices.getAll().length, 1);
  });
});

// The same randomised address was shown as "CANDY HOUSE, Inc." at one address
// and "iRobot Corporation" at another. It was a MacBook both times.
describe('ランダム化MACに、無関係な会社名を付けない', () => {
  it('ローカル管理アドレスからはベンダーを引かない', () => {
    for (const mac of ['E6:C6:50:AD:A1:33', '7E:1F:0C:45:8F:AD', '62:27:37:ff:13:f9', 'D2:32:25:DF:6C:2A']) {
      assert.equal(isStableMac(mac), false, `グローバル扱いになっている: ${mac}`);
      // Returns empty without consulting the OUI table at all, which is also
      // why this does not throw when the table has not been loaded.
      assert.equal(deviceIdentify.lookupVendor(mac), '');
      assert.equal(deviceIdentify.getOuiVendor(mac), null);
    }
  });

  it('本物のベンダーIDは、これまでどおり扱う', () => {
    for (const mac of ['8C:BF:EA:8C:BE:2C', '28:d5:b1:38:6e:e1', '34:31:7F:A0:CB:FE']) {
      assert.equal(isStableMac(mac), true, `ローカル扱いになっている: ${mac}`);
    }
  });

  it('壊れたMACやブロードキャストは、グローバルではない', () => {
    for (const mac of [null, '', 'zz:zz:zz:zz:zz:zz', 'ff:ff:ff:ff:ff:ff', '00:00:00:00:00:00']) {
      assert.equal(isStableMac(mac), false);
    }
  });
});
