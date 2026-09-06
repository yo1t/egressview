'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isSpecialUseAddress } = require('../../src/special-use-address');

// P3-59. The rule is the address range, never the returned name: a name test
// would miss another registry answering the same way, and would wrongly strip
// a destination IANA legitimately operates.
test('the ranges production actually carried are special-use', () => {
  // Every one of these was measured on the production Hub under a single
  // `Internet Assigned Numbers Authority` group on 2026-09-06.
  for (const address of [
    '10.9.9.9',           // RFC 1918, the shape of the largest single case
    '192.168.0.2', '172.16.173.1',
    '169.254.169.254',    // cloud metadata service
    '100.64.1.10', '100.125.180.112',   // CGNAT
    '192.0.0.2', '192.0.0.6', '192.0.0.8',  // IETF protocol assignments
    '192.0.2.0',          // TEST-NET-1
    '198.18.0.1', '198.18.1.148',       // benchmarking
  ]) {
    assert.equal(isSpecialUseAddress(address), true, `${address} should be special-use`);
  }
});

test('ordinary destinations are left alone', () => {
  // The failure that would matter: stripping the org from a real destination
  // and leaving the reader with an address where a name belonged.
  for (const address of [
    '8.8.8.8', '1.1.1.1', '52.219.1.2',
    '172.32.0.1',         // just past 172.16.0.0/12
    '100.128.0.1',        // just past 100.64.0.0/10
    '198.20.0.1',         // just before 198.18.0.0/15
    '203.0.114.1',        // just past TEST-NET-3
    '223.255.255.255',    // just before multicast
  ]) {
    assert.equal(isSpecialUseAddress(address), false, `${address} must keep its org`);
  }
});

test('the edges of each range are decided, not approximated', () => {
  assert.equal(isSpecialUseAddress('198.17.255.255'), false);
  assert.equal(isSpecialUseAddress('198.18.0.0'), true);
  assert.equal(isSpecialUseAddress('198.19.255.255'), true);
  assert.equal(isSpecialUseAddress('198.20.0.0'), false);
  assert.equal(isSpecialUseAddress('100.63.255.255'), false);
  assert.equal(isSpecialUseAddress('100.64.0.0'), true);
  assert.equal(isSpecialUseAddress('100.127.255.255'), true);
  assert.equal(isSpecialUseAddress('100.128.0.0'), false);
  assert.equal(isSpecialUseAddress('239.255.255.250'), true);   // SSDP multicast
  assert.equal(isSpecialUseAddress('255.255.255.255'), true);   // broadcast
});

test('IPv6 forms agree with the IPv4 they wrap', () => {
  // `::ffff:10.0.0.1` and `10.0.0.1` are the same destination, so they must
  // not answer differently depending on which spelling was stored.
  assert.equal(isSpecialUseAddress('::ffff:10.0.0.1'), true);
  assert.equal(isSpecialUseAddress('::ffff:8.8.8.8'), false);
  for (const address of ['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '2001:db8::1']) {
    assert.equal(isSpecialUseAddress(address), true, `${address} should be special-use`);
  }
  for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isSpecialUseAddress(address), false, `${address} must keep its org`);
  }
});

test('anything that is not an address is not our business', () => {
  // A hostname is a name somebody chose. This function has nothing to say
  // about it, and answering `true` would strip orgs from real destinations.
  for (const value of ['example.com', '', null, undefined, '10.0.0', '10.0.0.256', '999.1.1.1']) {
    assert.equal(isSpecialUseAddress(value), false, `${value} must not be treated as special-use`);
  }
});
