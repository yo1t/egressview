// Unit tests for src/devices.js (in-memory SQLite)
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const devicesModule = require('../../src/devices');

beforeEach(() => devicesModule._initForTest());

describe('devices.upsert / getAll', () => {
  it('inserts a new device', () => {
    devicesModule.upsert({ ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:ff', vendor: 'Apple', source: 'nat' });
    const all = devicesModule.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].ip, '192.168.1.1');
    assert.equal(all[0].mac, 'aa:bb:cc:dd:ee:ff');
    assert.equal(all[0].vendor, 'Apple');
  });

  it('merges fields on upsert (COALESCE)', () => {
    devicesModule.upsert({ ip: '10.0.0.1', mac: null,           vendor: 'Sony',  source: 'nat' });
    devicesModule.upsert({ ip: '10.0.0.1', mac: '11:22:33:44:55:66', vendor: null,   source: 'dhcp' });
    const all = devicesModule.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].mac, '11:22:33:44:55:66');  // filled in by second upsert
    assert.equal(all[0].vendor, 'Sony');             // kept from first upsert
  });

  it('accumulates sources', () => {
    devicesModule.upsert({ ip: '10.0.0.2', source: 'nat' });
    devicesModule.upsert({ ip: '10.0.0.2', source: 'dhcp' });
    devicesModule.upsert({ ip: '10.0.0.2', source: 'nat' }); // duplicate should not be added again
    const row = devicesModule.getByIp('10.0.0.2');
    const sources = row.sources.split(',').filter(Boolean);
    assert.ok(sources.includes('nat'),  'nat present');
    assert.ok(sources.includes('dhcp'), 'dhcp present');
    assert.equal(sources.filter(s => s === 'nat').length, 1, 'nat appears only once');
  });

  it('keeps MIN firstSeen and MAX lastSeen', () => {
    const t = Date.now();
    devicesModule.upsert({ ip: '10.0.0.3', firstSeen: t - 5000, lastSeen: t - 4000, source: 'nat' });
    devicesModule.upsert({ ip: '10.0.0.3', firstSeen: t - 3000, lastSeen: t,        source: 'nat' });
    const row = devicesModule.getByIp('10.0.0.3');
    assert.equal(row.firstSeen, t - 5000);
    assert.equal(row.lastSeen,  t);
  });
});

describe('devices.getByIp', () => {
  it('returns null for unknown IP', () => {
    assert.equal(devicesModule.getByIp('1.2.3.4'), null);
  });

  it('returns the correct row', () => {
    devicesModule.upsert({ ip: '172.16.0.1', mac: 'de:ad:be:ef:00:01', source: 'arp' });
    const row = devicesModule.getByIp('172.16.0.1');
    assert.ok(row, 'row exists');
    assert.equal(row.ip, '172.16.0.1');
  });
});

describe('devices.getByMac', () => {
  it('returns empty array for unknown MAC', () => {
    assert.deepEqual(devicesModule.getByMac('ff:ff:ff:ff:ff:ff'), []);
  });

  it('returns all IPs with the same MAC', () => {
    devicesModule.upsert({ ip: '192.168.1.10', mac: '00:11:22:33:44:55', source: 'nat' });
    devicesModule.upsert({ ip: '192.168.1.11', mac: '00:11:22:33:44:55', source: 'nat' });
    const rows = devicesModule.getByMac('00:11:22:33:44:55');
    assert.equal(rows.length, 2);
  });
});

describe('devices.seedFromConnectionHistory', () => {
  it('populates devices from a Map of connection entries', () => {
    const hist = new Map([
      ['10.0.0.1|8.8.8.8|53|UDP', {
        src: '10.0.0.1', srcMac: 'aa:bb:cc:00:00:01', srcVendor: 'Google',
        srcDnsName: 'gdev.local', srcMdnsName: null,
        firstSeen: Date.now() - 10000, lastSeen: Date.now(),
      }],
      ['10.0.0.2|1.1.1.1|443|TCP', {
        src: '10.0.0.2', srcMac: null, srcVendor: null,
        srcDnsName: null, srcMdnsName: null,
        firstSeen: Date.now() - 5000, lastSeen: Date.now(),
      }],
    ]);
    devicesModule.seedFromConnectionHistory(hist);
    const all = devicesModule.getAll();
    assert.equal(all.length, 2);
    const d = devicesModule.getByIp('10.0.0.1');
    assert.equal(d.mac, 'aa:bb:cc:00:00:01');
    assert.equal(d.vendor, 'Google');
    assert.equal(d.dnsName, 'gdev.local');
  });
});
