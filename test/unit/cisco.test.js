// Unit tests for Cisco IOS parser helpers
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cisco = require('../../src/pollers/cisco');
const adapter = require('../../src/pollers/cisco-adapter');
const { REQUIRED_METHODS } = require('../../src/pollers/router-interface');

const fix = name => fs.readFileSync(path.join(__dirname, '../fixtures/cisco', name), 'utf8');

// ── dotMacToColon ─────────────────────────────────────────────────────────────

describe('cisco: dotMacToColon', () => {
  it('converts Cisco dot-notation to colon-notation', () => {
    assert.equal(cisco.dotMacToColon('aabb.cc11.0200'), 'aa:bb:cc:11:02:00');
    assert.equal(cisco.dotMacToColon('aabb.cc00.0100'), 'aa:bb:cc:00:01:00');
    assert.equal(cisco.dotMacToColon('aabb.cc33.0400'), 'aa:bb:cc:33:04:00');
  });

  it('passes through an unknown format unchanged', () => {
    assert.equal(cisco.dotMacToColon('invalid'), 'invalid');
  });
});

// ── parseNatTranslations ──────────────────────────────────────────────────────

describe('cisco: parseNatTranslations', () => {
  it('parses TCP entries', () => {
    const raw = fix('nat-translations.txt');
    const sessions = cisco.parseNatTranslations(raw);
    const tcp = sessions.filter(s => s.proto === 'TCP');
    assert.ok(tcp.length >= 2, 'expected at least 2 TCP sessions');
    const first = sessions[0];
    assert.equal(first.proto, 'TCP');
    assert.equal(first.src, '192.168.1.10');
    assert.equal(first.sport, 12345);
    assert.equal(first.dst, '8.8.8.8');
    assert.equal(first.dport, 80);
    assert.equal(first.ttl, 86400);
  });

  it('parses UDP entries', () => {
    const raw = fix('nat-translations.txt');
    const sessions = cisco.parseNatTranslations(raw);
    const udp = sessions.filter(s => s.proto === 'UDP');
    assert.ok(udp.length >= 1);
    assert.equal(udp[0].ttl, 300);
  });

  it('parses ICMP entries', () => {
    const raw = fix('nat-translations.txt');
    const sessions = cisco.parseNatTranslations(raw);
    const icmp = sessions.filter(s => s.proto === 'ICMP');
    assert.ok(icmp.length >= 1);
    assert.equal(icmp[0].ttl, 60);
  });

  it('skips static NAT lines (---)', () => {
    const raw = fix('nat-translations.txt');
    const sessions = cisco.parseNatTranslations(raw);
    const withDash = sessions.filter(s => s.src === '---' || s.dst === '---');
    assert.equal(withDash.length, 0);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(cisco.parseNatTranslations(''), []);
    assert.deepEqual(cisco.parseNatTranslations(null), []);
  });
});

// ── parseArp ─────────────────────────────────────────────────────────────────

describe('cisco: parseArp', () => {
  it('parses ARP table and converts MAC notation', () => {
    const raw = fix('arp.txt');
    const map = cisco.parseArp(raw);
    assert.equal(map.size, 5);
    assert.equal(map.get('192.168.1.10'), 'aa:bb:cc:11:02:00');
    assert.equal(map.get('192.168.1.1'),  'aa:bb:cc:00:01:01');
    assert.equal(map.get('203.0.113.1'),  'aa:bb:cc:00:01:00');
  });

  it('returns empty map for blank input', () => {
    assert.equal(cisco.parseArp('').size, 0);
  });
});

// ── parseNdpNeighbors ─────────────────────────────────────────────────────────

describe('cisco: parseNdpNeighbors', () => {
  it('parses NDP neighbors and skips FE80 link-local addresses', () => {
    const raw = fix('ipv6-neighbors.txt');
    const map = cisco.parseNdpNeighbors(raw);
    // FE80 addresses must be excluded
    for (const addrs of map.values()) {
      for (const a of addrs) {
        assert.ok(!a.startsWith('fe80:'), `unexpected link-local: ${a}`);
      }
    }
  });

  it('groups multiple IPv6 addresses per MAC', () => {
    const raw = fix('ipv6-neighbors.txt');
    const map = cisco.parseNdpNeighbors(raw);
    const mac = 'aa:bb:cc:11:02:00';
    const addrs = map.get(mac);
    assert.ok(Array.isArray(addrs) && addrs.length >= 1);
    assert.ok(addrs.some(a => a.startsWith('2001:')));
  });

  it('returns empty map for blank input', () => {
    assert.equal(cisco.parseNdpNeighbors('').size, 0);
  });
});

// ── parseLanIp ────────────────────────────────────────────────────────────────

describe('cisco: parseLanIp', () => {
  it('extracts the LAN (private) IP from ip interface brief', () => {
    const raw = fix('ip-interface-brief.txt');
    assert.equal(cisco.parseLanIp(raw), '192.168.1.1');
  });

  it('returns empty string when no private IP present', () => {
    assert.equal(cisco.parseLanIp('Interface  IP-Address  Status\nGi0/0  203.0.113.1  up  up'), '');
  });
});

// ── isCiscoIos ────────────────────────────────────────────────────────────────

describe('cisco: isCiscoIos', () => {
  it('returns true for show version output', () => {
    assert.ok(cisco.isCiscoIos(fix('show-version.txt')));
  });

  it('returns false for non-Cisco text', () => {
    assert.ok(!cisco.isCiscoIos('Yamaha RTX1210 rev.14.01.38'));
  });

  it('returns false for null/empty', () => {
    assert.ok(!cisco.isCiscoIos(null));
    assert.ok(!cisco.isCiscoIos(''));
  });
});

// ── cisco-adapter contract ────────────────────────────────────────────────────

describe('cisco-adapter: router-interface contract', () => {
  it('has kind "cisco"', () => {
    assert.equal(adapter.kind, 'cisco');
  });

  it('satisfies all required methods', () => {
    for (const method of REQUIRED_METHODS) {
      assert.equal(typeof adapter[method], 'function', `missing: ${method}`);
    }
  });

  it('exposes parser helpers for tests', () => {
    assert.equal(typeof adapter.parseNatTranslations, 'function');
    assert.equal(typeof adapter.parseArp, 'function');
    assert.equal(typeof adapter.parseNdpNeighbors, 'function');
    assert.equal(typeof adapter.parseLanIp, 'function');
    assert.equal(typeof adapter.dotMacToColon, 'function');
    assert.equal(typeof adapter.isCiscoIos, 'function');
  });
});

// ── isPrivilegeError（特権不足の検出） ─────────────────────────────────────────

describe('cisco: isPrivilegeError', () => {
  it('detects "% Invalid input" from user-mode NAT command', () => {
    const raw = fix('nat-translations-privilege-error.txt');
    assert.equal(cisco.isPrivilegeError(raw), true);
  });

  it('detects "% Access denied"', () => {
    assert.equal(cisco.isPrivilegeError('% Access denied\nRouter>'), true);
  });

  it('returns false for a normal NAT table', () => {
    assert.equal(cisco.isPrivilegeError(fix('nat-translations.txt')), false);
  });

  it('returns false for empty/null input', () => {
    assert.equal(cisco.isPrivilegeError(''), false);
    assert.equal(cisco.isPrivilegeError(null), false);
  });
});

// ── parseNatTranslations の形式差分（privilege エラー・static エントリ） ────────

describe('cisco: parseNatTranslations format variants', () => {
  it('returns 0 sessions for privilege-error output (must be caught by isPrivilegeError, not treated as empty table)', () => {
    const raw = fix('nat-translations-privilege-error.txt');
    assert.equal(cisco.parseNatTranslations(raw).length, 0);
  });

  it('ignores static "---" entries without ports', () => {
    const raw = fix('nat-translations.txt');
    const sessions = cisco.parseNatTranslations(raw);
    // fixture の static 行 (--- 203.0.113.1 192.168.1.100 --- ---) はセッション化されない
    assert.ok(sessions.every(s => s.src !== '192.168.1.100'), 'static entry must not appear as a session');
  });

  it('ignores header and prompt lines', () => {
    const raw = 'Pro  Inside global  Inside local  Outside local  Outside global\nRouter#\n';
    assert.equal(cisco.parseNatTranslations(raw).length, 0);
  });
});
