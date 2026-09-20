'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const devices = require('../../src/devices');

const IP = '192.168.1.60';
let dir;
beforeEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-lease-identity-'));
  devices._initForTest(path.join(dir, 'test.db'));
});

// P3-138. A lease stays assigned for days after the machine is switched off,
// so feeding leases through observeDevice() made every leased device read as
// seen just now: a printer last seen two hours earlier read as zero minutes.
describe('リースは目撃ではない', () => {
  it('身元は直すが、最終観測は動かさない', () => {
    const seenAt = Date.now() - 2 * 3600_000;
    devices.observeDevice({ ip: IP, mac: '7c:df:a1:5d:e7:2c', source: 'yamaha', lastSeen: seenAt, firstSeen: seenAt });
    const before = devices.getByIp(IP).lastSeen;

    const changed = devices.updateIdentity({
      ip: IP, mac: '7c:df:a1:5d:e7:2c', vendor: 'Espressif Inc.', dnsName: 'EPSON095B01',
    });

    const after = devices.getByIp(IP);
    assert.equal(changed, true);
    assert.equal(after.dnsName, 'EPSON095B01');
    assert.equal(after.lastSeen, before, '最終観測が動いている');
  });

  it('見たことのないアドレスに、行を作らない', () => {
    const changed = devices.updateIdentity({ ip: '192.168.1.222', mac: '7c:df:a1:5d:e7:2c', dnsName: 'NeverSeen' });
    assert.equal(changed, false);
    assert.equal(devices.getByIp('192.168.1.222'), null,
      'リースだけを根拠に端末が現れてはいけない');
  });

  it('MACを直したら、ベンダー名もそれに従う', () => {
    const now = Date.now();
    devices.observeDevice({ ip: IP, mac: '7c:df:a1:5d:e7:2c', vendor: 'Espressif Inc.', source: 'yamaha', lastSeen: now });
    devices.updateIdentity({ ip: IP, mac: 'd4:8d:26:c2:a3:af', vendor: 'LG Innotek' });
    const row = devices.getByIp(IP);
    assert.equal(row.mac, 'd4:8d:26:c2:a3:af');
    assert.equal(row.vendor, 'LG Innotek', '古いベンダー名が新しいMACに残っている');
  });

  it('何も変わらないなら、書き込まない', () => {
    const now = Date.now();
    devices.observeDevice({ ip: IP, mac: '7c:df:a1:5d:e7:2c', vendor: 'Espressif Inc.', dnsName: 'A', source: 'yamaha', lastSeen: now });
    assert.equal(devices.updateIdentity({ ip: IP, mac: '7c:df:a1:5d:e7:2c', vendor: 'Espressif Inc.', dnsName: 'A' }), false);
  });

  it('アーカイブされた端末は、リースでは復活しない', () => {
    const now = Date.now();
    const id = devices.observeDevice({ ip: IP, mac: '7c:df:a1:5d:e7:2c', source: 'yamaha', lastSeen: now });
    devices.archiveDevice(id);
    assert.equal(devices.updateIdentity({ ip: IP, mac: '7c:df:a1:5d:e7:2c', dnsName: 'Back' }), false);
  });

  it('端末になり得ないアドレスは、そもそも対象外', () => {
    assert.equal(devices.updateIdentity({ ip: '0.0.0.0', mac: '7c:df:a1:5d:e7:2c' }), false);
    assert.equal(devices.updateIdentity({ ip: 'fe80::1%en0', mac: '7c:df:a1:5d:e7:2c' }), false);
  });
});
