'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isBlockedOutboundIpLiteral } = require('../../src/ssrf-guard');

describe('isBlockedOutboundIpLiteral', () => {
  it('blocks link-local, metadata, unspecified, broadcast, and multicast IPv4', () => {
    for (const address of [
      '169.254.169.254', // IMDS
      '169.254.0.1',
      '0.0.0.0',
      '0.1.2.3',
      '255.255.255.255',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), true, address);
    }
  });

  it('blocks link-local, unspecified, IMDS, and multicast IPv6', () => {
    for (const address of [
      'fe80::1',
      'fe80::abcd',
      '::',
      'fd00:ec2::254', // EC2 IMDS over IPv6
      'ff02::1',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), true, address);
    }
  });

  it('blocks IPv4-mapped IPv6 forms of metadata (decimal and hextet, bracketed)', () => {
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '[::ffff:a9fe:a9fe]',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), true, address);
    }
  });

  it('allows loopback and private ranges a self-hosted Ollama legitimately uses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.20',
      '172.16.1.2',
      '192.168.1.2',
      '100.100.100.1', // CGNAT (e.g. Tailscale)
      '::1',
      'fd00::20',
      '::ffff:127.0.0.1',
    ]) {
      assert.equal(isBlockedOutboundIpLiteral(address), false, address);
    }
  });

  it('does not treat hostnames or empty input as blocked literals', () => {
    for (const value of ['ollama.internal', 'example.com', '', null, undefined, 'not-an-ip']) {
      assert.equal(isBlockedOutboundIpLiteral(value), false, String(value));
    }
  });
});
