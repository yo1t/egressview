'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  ACQUISITION_COMMANDS,
  classifyConntrackOutput,
  isPrivateIpv4,
  parseConntrack,
  parseConntrackLine,
} = require('../../src/pollers/conntrack');

const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'conntrack', name), 'utf8');

describe('conntrack parser', () => {
  it('defines procfs first with conntrack -L as the fallback', () => {
    assert.deepEqual(ACQUISITION_COMMANDS, ['cat /proc/net/nf_conntrack', 'conntrack -L']);
  });

  it('parses sanitized procfs TCP, UDP, and ICMP origin tuples', () => {
    const sessions = parseConntrack(fixture('procfs.txt'));
    assert.deepEqual(sessions, [
      { proto: 'TCP', src: '10.99.0.100', sport: 51874, dst: '198.51.100.10', dport: 80, ttl: 118 },
      { proto: 'TCP', src: '10.99.0.100', sport: 52341, dst: '203.0.113.20', dport: 443, ttl: 431999 },
      { proto: 'UDP', src: '10.99.1.100', sport: 44900, dst: '203.0.113.53', dport: 53, ttl: 27 },
      { proto: 'ICMP', src: '10.99.2.100', sport: 60, dst: '198.51.100.8', dport: 0, ttl: 29 },
    ]);
  });

  it('parses conntrack -L output without an address-family prefix', () => {
    const sessions = parseConntrack(fixture('command.txt'));
    assert.deepEqual(sessions.map(session => session.proto), ['TCP', 'UDP', 'ICMP']);
    assert.deepEqual(sessions.map(session => session.src), ['192.168.50.10', '172.16.4.20', '10.20.30.40']);
  });

  it('uses only the origin tuple and ignores the NAT reply tuple', () => {
    const [session] = parseConntrack(fixture('command.txt'));
    assert.equal(session.src, '192.168.50.10');
    assert.equal(session.dst, '198.51.100.50');
    assert.equal(session.sport, 61000);
    assert.equal(session.dport, 443);
  });

  it('rejects IPv6, non-private origins, unsupported protocols, and malformed ports', () => {
    assert.equal(parseConntrackLine('ipv6 2 tcp 6 30 ESTABLISHED src=2001:db8::1 dst=2001:db8::2 sport=1 dport=2'), null);
    assert.equal(parseConntrackLine('tcp 6 30 ESTABLISHED src=198.51.100.1 dst=203.0.113.1 sport=1 dport=2'), null);
    assert.equal(parseConntrackLine('gre 47 30 src=10.0.0.1 dst=203.0.113.1'), null);
    assert.equal(parseConntrackLine('tcp 6 30 ESTABLISHED src=10.0.0.1 dst=203.0.113.1 sport=x dport=443'), null);
  });

  it('deduplicates the runtime natural key and keeps the longest timeout', () => {
    const line = 'tcp 6 10 ESTABLISHED src=10.0.0.1 dst=203.0.113.1 sport=1000 dport=443 src=203.0.113.1 dst=192.0.2.1 sport=443 dport=1000';
    const newer = line.replace(' 10 ', ' 20 ').replace('sport=1000', 'sport=2000');
    assert.deepEqual(parseConntrack(`${line}\n${newer}`), [
      { proto: 'TCP', src: '10.0.0.1', sport: 2000, dst: '203.0.113.1', dport: 443, ttl: 20 },
    ]);
  });

  it('classifies supported, empty, unavailable, and permission-denied output', () => {
    assert.equal(classifyConntrackOutput(fixture('procfs.txt')), 'supported');
    assert.equal(classifyConntrackOutput(''), 'empty');
    assert.equal(classifyConntrackOutput('cat: /proc/net/nf_conntrack: No such file or directory'), 'unavailable');
    assert.equal(classifyConntrackOutput('conntrack: Operation not permitted (you must be root)'), 'permission-denied');
  });

  it('accepts only RFC1918 source addresses in stage 1', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) assert.equal(isPrivateIpv4(ip), true);
    for (const ip of ['172.15.0.1', '172.32.0.1', '100.64.0.1', '203.0.113.1', 'bad']) assert.equal(isPrivateIpv4(ip), false);
  });
});
