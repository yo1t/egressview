'use strict';

// Unit tests for the pure helper functions in public/js/devices.js
// (device naming, sort-key extraction, cell-value extraction, column filtering).
// devices.js has top-level DOM side-effects, so — like graph-link-normalization.test.js —
// we slice out just the pure-function block and evaluate it in an isolated context.
// Run: node --test test/unit/devices-view.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const devicesSource = fs.readFileSync(path.join(root, 'public/js/devices.js'), 'utf8');

function loadDeviceHelpers() {
  const start = devicesSource.indexOf('function deviceName');
  const end = devicesSource.indexOf('function renderDevicesTable');
  assert.notEqual(start, -1, 'function deviceName not found');
  assert.notEqual(end, -1, 'function renderDevicesTable not found');

  const context = {};
  vm.runInNewContext(devicesSource.slice(start, end), context);
  return context;
}

const { deviceName, deviceIpv6, getDeviceSortValue, getDvCellValue, dvMatchFilter } =
  loadDeviceHelpers();

describe('deviceName', () => {
  it('prefers mDNS name over DNS and NetBIOS', () => {
    assert.equal(deviceName({ mdnsName: 'm', dnsName: 'd', netbiosName: 'n' }), 'm');
  });
  it('falls back to DNS when mDNS is absent', () => {
    assert.equal(deviceName({ dnsName: 'd', netbiosName: 'n' }), 'd');
  });
  it('falls back to NetBIOS when only it is present', () => {
    assert.equal(deviceName({ netbiosName: 'n' }), 'n');
  });
  it('returns em-dash when no name is known', () => {
    assert.equal(deviceName({}), '—');
  });
});

describe('deviceIpv6', () => {
  it('returns em-dash when no IPv6 addresses', () => {
    assert.equal(deviceIpv6({}), '—');
    assert.equal(deviceIpv6({ ipv6Addrs: [] }), '—');
  });
  it('joins a single address', () => {
    assert.equal(deviceIpv6({ ipv6Addrs: ['2001:db8::1'] }), '2001:db8::1');
  });
  it('shows at most the first two addresses', () => {
    assert.equal(
      deviceIpv6({ ipv6Addrs: ['2001:db8::1', '2001:db8::2', '2001:db8::3'] }),
      '2001:db8::1, 2001:db8::2',
    );
  });
});

describe('getDeviceSortValue', () => {
  const d = {
    ip: '192.168.1.5', mac: 'aa:bb', vendor: 'Apple',
    mdnsName: 'MacBook', firstSeen: 100, lastSeen: 200,
  };
  it('returns raw ip / mac', () => {
    assert.equal(getDeviceSortValue(d, 'ip'), '192.168.1.5');
    assert.equal(getDeviceSortValue(d, 'mac'), 'aa:bb');
  });
  it('lowercases vendor and name for case-insensitive sort', () => {
    assert.equal(getDeviceSortValue(d, 'vendor'), 'apple');
    assert.equal(getDeviceSortValue(d, 'name'), 'macbook');
  });
  it('returns numeric timestamps for firstSeen / lastSeen', () => {
    assert.equal(getDeviceSortValue(d, 'firstSeen'), 100);
    assert.equal(getDeviceSortValue(d, 'lastSeen'), 200);
  });
  it('coerces missing fields to empty string / 0', () => {
    assert.equal(getDeviceSortValue({}, 'ip'), '');
    assert.equal(getDeviceSortValue({}, 'vendor'), '');
    assert.equal(getDeviceSortValue({}, 'lastSeen'), 0);
  });
  it('returns empty string for unknown column', () => {
    assert.equal(getDeviceSortValue(d, 'nope'), '');
  });
});

describe('getDvCellValue', () => {
  it('returns raw values for ip / mac / vendor', () => {
    const d = { ip: '10.0.0.1', mac: 'de:ad', vendor: 'Cisco' };
    assert.equal(getDvCellValue(d, 'ip'), '10.0.0.1');
    assert.equal(getDvCellValue(d, 'mac'), 'de:ad');
    assert.equal(getDvCellValue(d, 'vendor'), 'Cisco');
  });
  it('returns the name when known', () => {
    assert.equal(getDvCellValue({ dnsName: 'host' }, 'name'), 'host');
  });
  it('returns empty string (not em-dash) when name is unknown', () => {
    assert.equal(getDvCellValue({}, 'name'), '');
  });
  it('returns empty string for unknown column or missing field', () => {
    assert.equal(getDvCellValue({}, 'ip'), '');
    assert.equal(getDvCellValue({}, 'nope'), '');
  });
});

describe('dvMatchFilter', () => {
  it('matches everything when filter is empty', () => {
    assert.equal(dvMatchFilter('anything', null), true);
    assert.equal(dvMatchFilter('anything', { mode: 'includes', value: '' }), true);
  });
  it('default mode is case-insensitive substring', () => {
    assert.equal(dvMatchFilter('MacBook Pro', { mode: 'includes', value: 'book' }), true);
    assert.equal(dvMatchFilter('MacBook Pro', { mode: 'includes', value: 'win' }), false);
  });
  it('startsWith / endsWith are case-insensitive', () => {
    assert.equal(dvMatchFilter('Apple TV', { mode: 'startsWith', value: 'app' }), true);
    assert.equal(dvMatchFilter('Apple TV', { mode: 'startsWith', value: 'tv' }), false);
    assert.equal(dvMatchFilter('Apple TV', { mode: 'endsWith', value: ' tv' }), true);
  });
  it('regex mode matches with the case-insensitive flag', () => {
    assert.equal(dvMatchFilter('192.168.1.10', { mode: 'regex', value: '^192\\.168\\.' }), true);
    assert.equal(dvMatchFilter('AABBCC', { mode: 'regex', value: 'aabb' }), true);
  });
  it('invalid regex is treated as match-all (no crash)', () => {
    assert.equal(dvMatchFilter('anything', { mode: 'regex', value: '([' }), true);
  });
});

describe('device detail note wiring', () => {
  it('looks up notes with deviceId so canonical notes remain visible', () => {
    assert.match(devicesSource, /lookupNote\(d\.ip,\s*d\.mac,\s*d\.deviceId\)/,
      'device table/detail note lookup should pass deviceId to lookupNote');
  });

  it('saves device detail notes with deviceId and checks HTTP errors', () => {
    const start = devicesSource.indexOf("document.getElementById('dv-detail-save').addEventListener");
    assert.notEqual(start, -1, 'dv-detail-save click handler not found');
    const end = devicesSource.indexOf("document.getElementById('dv-detail-investigate').addEventListener", start);
    assert.notEqual(end, -1, 'dv-detail-save handler end not found');
    const handler = devicesSource.slice(start, end);

    assert.match(handler, /body:\s*JSON\.stringify\(\{\s*ip,\s*mac,\s*deviceId,\s*note\s*\}\)/,
      'save payload should include deviceId as the canonical note key');
    assert.match(handler, /if\s*\(\s*!res\.ok\s*\)/,
      'save handler should not treat non-OK responses as success');
    assert.match(handler, /btn\.disabled\s*=\s*true/,
      'save button should be disabled while the request is in flight');
    assert.match(handler, /btn\.disabled\s*=\s*false/,
      'save button should be re-enabled after the request finishes');
  });
});
