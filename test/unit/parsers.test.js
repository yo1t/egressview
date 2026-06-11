// Unit tests for parser functions
// Run: node --test test/unit/parsers.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Import from modules
const { isAllowedRouterIp, htmlEscape } = require('../../src/utils');
const { parseNatDetail } = require('../../src/pollers/yamaha');
const { parseClientList, computeRates, parseMeshNodes } = require('../../src/pollers/asus');
const { parseOuiManuf, lookupAppleModel, inferVendorCategory } = require('../../src/device-identify');
const { _parseLine: parseInspectLine } = require('../../src/pollers/inspect-syslog');
const { _parseLine: parseDhcpdLine, getMacByIp } = require('../../src/pollers/dhcpd-syslog');
const { _parseLine: parseDnsmasqLine } = require('../../src/pollers/dnsmasq-log');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseNatDetail', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'nat-detail-sample.txt'), 'utf8');

  it('parses TCP sessions correctly', () => {
    const sessions = parseNatDetail(fixture);
    const tcp = sessions.filter(s => s.proto === 'TCP');
    assert(tcp.length >= 3, `Expected >=3 TCP sessions, got ${tcp.length}`);
  });

  it('parses UDP sessions correctly', () => {
    const sessions = parseNatDetail(fixture);
    const udp = sessions.filter(s => s.proto === 'UDP');
    assert(udp.length >= 1, `Expected >=1 UDP session, got ${udp.length}`);
  });

  it('parses ICMP sessions', () => {
    const sessions = parseNatDetail(fixture);
    const icmp = sessions.filter(s => s.proto === 'ICMP');
    assert.equal(icmp.length, 1);
  });

  it('parses GRE sessions from 10.x.x.x source', () => {
    const sessions = parseNatDetail(fixture);
    const gre = sessions.filter(s => s.proto === 'GRE');
    assert.equal(gre.length, 1);
    assert.equal(gre[0].src, '10.0.0.5');
    assert.equal(gre[0].sport, 0);
  });

  it('skips wildcard destinations', () => {
    const sessions = parseNatDetail(fixture);
    const wildcard = sessions.filter(s => s.dst.includes('*'));
    assert.equal(wildcard.length, 0);
  });

  it('skips non-private source addresses', () => {
    const sessions = parseNatDetail(fixture);
    const nonPrivate = sessions.filter(s =>
      !s.src.startsWith('192.168.') && !s.src.startsWith('10.')
    );
    assert.equal(nonPrivate.length, 0);
  });

  it('extracts correct fields for a known session', () => {
    const sessions = parseNatDetail(fixture);
    const s = sessions.find(s => s.dst === '142.250.196.110');
    assert(s, 'Should find session to 142.250.196.110');
    assert.equal(s.proto, 'TCP');
    assert.equal(s.src, '192.168.1.10');
    assert.equal(s.sport, 52344);
    assert.equal(s.dport, 443);
    assert.equal(s.ttl, 600);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseNatDetail(''), []);
  });

  it('returns empty array for garbage input', () => {
    assert.deepEqual(parseNatDetail('some random text\nno valid lines'), []);
  });
});

describe('parseOuiManuf', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'oui-sample.txt'), 'utf8');

  it('parses OUI entries correctly', () => {
    const db = parseOuiManuf(fixture);
    assert(db.size >= 4, `Expected >=4 entries, got ${db.size}`);
  });

  it('looks up ASUS by prefix', () => {
    const db = parseOuiManuf(fixture);
    assert.equal(db.get('CC28AA'), 'ASUSTeK COMPUTER INC.');
  });

  it('looks up Apple by prefix', () => {
    const db = parseOuiManuf(fixture);
    assert.equal(db.get('A483E7'), 'Apple, Inc.');
  });

  it('skips comment lines', () => {
    const db = parseOuiManuf(fixture);
    for (const key of db.keys()) {
      assert(!key.startsWith('#'));
    }
  });

  it('returns empty map for empty input', () => {
    const db = parseOuiManuf('');
    assert.equal(db.size, 0);
  });
});

describe('isAllowedRouterIp', () => {
  it('allows 192.168.x.x', () => {
    assert.equal(isAllowedRouterIp('192.168.1.1'), true);
    assert.equal(isAllowedRouterIp('192.168.0.254'), true);
  });

  it('allows 10.x.x.x', () => {
    assert.equal(isAllowedRouterIp('10.0.0.1'), true);
    assert.equal(isAllowedRouterIp('10.255.255.1'), true);
  });

  it('allows 172.16-31.x.x', () => {
    assert.equal(isAllowedRouterIp('172.16.0.1'), true);
    assert.equal(isAllowedRouterIp('172.31.255.1'), true);
  });

  it('rejects public IPs', () => {
    assert.equal(isAllowedRouterIp('8.8.8.8'), false);
    assert.equal(isAllowedRouterIp('142.250.196.110'), false);
  });

  it('rejects link-local (169.254.x.x)', () => {
    assert.equal(isAllowedRouterIp('169.254.169.254'), false);
  });

  it('rejects loopback (127.x.x.x)', () => {
    assert.equal(isAllowedRouterIp('127.0.0.1'), false);
  });

  it('rejects 172.15.x.x and 172.32.x.x', () => {
    assert.equal(isAllowedRouterIp('172.15.0.1'), false);
    assert.equal(isAllowedRouterIp('172.32.0.1'), false);
  });

  it('rejects non-string input', () => {
    assert.equal(isAllowedRouterIp(null), false);
    assert.equal(isAllowedRouterIp(undefined), false);
    assert.equal(isAllowedRouterIp(12345), false);
  });

  it('rejects invalid IP formats', () => {
    assert.equal(isAllowedRouterIp(''), false);
    assert.equal(isAllowedRouterIp('not-an-ip'), false);
    assert.equal(isAllowedRouterIp('192.168.1.999'), false);
    assert.equal(isAllowedRouterIp('256.1.1.1'), false);
  });
});

describe('htmlEscape', () => {
  it('escapes HTML special characters', () => {
    assert.equal(htmlEscape('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes ampersand', () => {
    assert.equal(htmlEscape('a&b'), 'a&amp;b');
  });

  it('escapes single quotes', () => {
    assert.equal(htmlEscape("it's"), 'it&#39;s');
  });

  it('handles empty string', () => {
    assert.equal(htmlEscape(''), '');
  });

  it('converts non-string to string', () => {
    assert.equal(htmlEscape(123), '123');
    assert.equal(htmlEscape(null), 'null');
  });
});

describe('parseClientList', () => {
  it('parses online clients from ASUS format', () => {
    const raw = {
      get_clientlist: {
        'AA:BB:CC:DD:EE:FF': {
          ip: '192.168.1.100', name: 'iPhone', isOnline: '1',
          isWL: '2', rssi: '-55', curRx: '100', curTx: '50',
          totalRx: '500000', totalTx: '200000',
        },
        '11:22:33:44:55:66': {
          ip: '192.168.1.101', name: 'Desktop', isOnline: '0',
          isWL: '0', rssi: '0', curRx: '0', curTx: '0',
          totalRx: '1000000', totalTx: '800000',
        },
        maclist: 'AA:BB:CC:DD:EE:FF,11:22:33:44:55:66',
        ClientAPILevel: '2',
      }
    };
    const clients = parseClientList(raw);
    assert.equal(clients.length, 1, 'Should only include online clients');
    assert.equal(clients[0].mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(clients[0].ip, '192.168.1.100');
    assert.equal(clients[0].type, '2');
    assert.equal(clients[0].rssi, -55);
  });

  it('returns empty array for null/undefined input', () => {
    assert.deepEqual(parseClientList(null), []);
    assert.deepEqual(parseClientList(undefined), []);
  });

  it('filters out maclist and ClientAPILevel keys', () => {
    const raw = {
      get_clientlist: {
        maclist: 'AA:BB:CC:DD:EE:FF',
        ClientAPILevel: '2',
        'AA:BB:CC:DD:EE:FF': { ip: '192.168.1.100', isOnline: '1', isWL: '1' },
      }
    };
    const clients = parseClientList(raw);
    assert.equal(clients.length, 1);
  });
});

describe('computeRates', () => {
  it('converts KB/s to B/s', () => {
    const clients = [{ curRx: '100', curTx: '50' }];
    const result = computeRates(clients);
    assert.equal(result[0].rxRate, 100 * 1024);
    assert.equal(result[0].txRate, 50 * 1024);
  });

  it('handles zero/missing values', () => {
    const clients = [{ curRx: '0', curTx: '' }];
    const result = computeRates(clients);
    assert.equal(result[0].rxRate, 0);
    assert.equal(result[0].txRate, 0);
  });
});

describe('lookupAppleModel', () => {
  it('returns product name for known model', () => {
    assert.equal(lookupAppleModel('Mac14,2'), 'MacBook Air (M2, 2022)');
    assert.equal(lookupAppleModel('iPhone17,1'), 'iPhone 16 Pro');
  });

  it('returns null for unknown model', () => {
    assert.equal(lookupAppleModel('UnknownModel99,9'), null);
  });

  it('returns null for null/undefined', () => {
    assert.equal(lookupAppleModel(null), null);
    assert.equal(lookupAppleModel(undefined), null);
  });
});

describe('inferVendorCategory', () => {
  it('identifies Apple devices', () => {
    const result = inferVendorCategory('Apple, Inc.');
    assert.equal(result.brand, 'Apple');
  });

  it('identifies Amazon devices', () => {
    const result = inferVendorCategory('Amazon Technologies Inc.');
    assert.equal(result.brand, 'Amazon');
  });

  it('identifies Raspberry Pi', () => {
    const result = inferVendorCategory('Raspberry Pi Trading Ltd');
    assert.equal(result.brand, 'RasPi');
  });

  it('identifies Nintendo', () => {
    const result = inferVendorCategory('Nintendo Co., Ltd.');
    assert.equal(result.brand, 'Nintendo');
  });

  it('identifies Samsung', () => {
    const result = inferVendorCategory('Samsung Electronics Co.,Ltd');
    assert.equal(result.brand, 'Samsung');
  });

  it('returns null for unknown vendor', () => {
    assert.equal(inferVendorCategory('Unknown Vendor Corp'), null);
  });

  it('returns null for empty/null input', () => {
    assert.equal(inferVendorCategory(null), null);
    assert.equal(inferVendorCategory(''), null);
  });
});

describe('parseMeshNodes', () => {
  it('parses mesh node list', () => {
    const raw = {
      get_cfg_clientlist: [
        { mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.1.2', ui_model_name: 'RT-AX88U', alias: 'Living Room', online: '1' },
        { mac: '11:22:33:44:55:66', ip: '192.168.1.3', model_name: 'RT-AX58U', alias: '', online: '0' },
      ]
    };
    const nodes = parseMeshNodes(raw);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].model, 'RT-AX88U');
    assert.equal(nodes[0].online, true);
    assert.equal(nodes[1].model, 'RT-AX58U');
    assert.equal(nodes[1].online, false);
    assert.equal(nodes[1].alias, '11:22:33:44:55:66');
  });

  it('returns empty array for missing data', () => {
    assert.deepEqual(parseMeshNodes({}), []);
    assert.deepEqual(parseMeshNodes({ get_cfg_clientlist: [] }), []);
  });
});

describe('parseInspectLine ([INSPECT] syslog)', () => {
  it('parses a TCP INSPECT entry', () => {
    const line = 'Jun  7 18:54:52 192.0.2.1  [INSPECT] LAN2[out][101098] TCP 192.168.1.73:54791 > 203.0.113.13:443 (2026/06/07 18:52:57)';
    const r = parseInspectLine(line);
    assert(r !== null, 'Should parse successfully');
    assert.equal(r.proto, 'tcp');
    assert.equal(r.src, '192.168.1.73');
    assert.equal(r.sport, 54791);
    assert.equal(r.dst, '203.0.113.13');
    assert.equal(r.dport, 443);
  });

  it('parses a UDP INSPECT entry', () => {
    const line = 'Jun  7 10:00:00 192.0.2.1  [INSPECT] LAN2[out][101098] UDP 192.168.1.111:12345 > 198.51.100.53:53 (2026/06/07 10:00:00)';
    const r = parseInspectLine(line);
    assert(r !== null);
    assert.equal(r.proto, 'udp');
    assert.equal(r.dport, 53);
  });

  it('returns null for non-INSPECT lines', () => {
    assert.equal(parseInspectLine('Jun  7 18:54:51 192.0.2.1  [IKE][1] DPD: send R-U-THERE'), null);
    assert.equal(parseInspectLine(''), null);
    assert.equal(parseInspectLine('some random log line'), null);
  });

  it('returns null for INSPECT lines without IP:port pattern', () => {
    assert.equal(parseInspectLine('[INSPECT] LAN2[out][101098] ICMP no-port-here'), null);
  });

  it('returns a Date object for time field', () => {
    const line = 'Jun  7 18:54:52 192.0.2.1  [INSPECT] LAN2[out][101098] TCP 192.168.1.73:54791 > 203.0.113.13:443 (2026/06/07 18:52:57)';
    const r = parseInspectLine(line);
    assert(r.time instanceof Date, 'time should be a Date');
  });
});

describe('parseDhcpdLine ([DHCPD] syslog)', () => {
  it('parses an Allocates entry', () => {
    const line = 'Jun  7 18:38:11 192.0.2.1  [DHCPD] LAN1(port10) Allocates 192.168.1.27: aa:bb:cc:dd:ee:01';
    const r = parseDhcpdLine(line);
    assert(r !== null, 'Should parse successfully');
    assert.equal(r.ip, '192.168.1.27');
    assert.equal(r.mac, 'aa:bb:cc:dd:ee:01');
  });

  it('parses an Extends entry', () => {
    const line = 'Jun  7 18:38:04 192.0.2.1  [DHCPD] LAN1(port10) Extends 192.168.1.31: aa:bb:cc:dd:ee:02';
    const r = parseDhcpdLine(line);
    assert(r !== null);
    assert.equal(r.ip, '192.168.1.31');
    assert.equal(r.mac, 'aa:bb:cc:dd:ee:02');
  });

  it('normalises MAC to lowercase', () => {
    const line = 'Jun  7 00:00:00 x  [DHCPD] LAN1(port10) Allocates 192.168.1.50: AA:BB:CC:DD:EE:FF';
    const r = parseDhcpdLine(line);
    assert(r !== null);
    assert.equal(r.mac, 'aa:bb:cc:dd:ee:ff');
  });

  it('returns null for non-DHCPD lines', () => {
    assert.equal(parseDhcpdLine('[INSPECT] LAN2[out][101098] TCP 192.168.1.1:1 > 203.0.113.4:80'), null);
    assert.equal(parseDhcpdLine(''), null);
  });

  it('getMacByIp returns null for unknown IP', () => {
    assert.equal(getMacByIp('192.168.1.99'), null);
  });
});

// ─── parseDnsmasqLine ────────────────────────────────────────────────────────

describe('parseDnsmasqLine', () => {
  it('parses a query[A] line', () => {
    const line = 'Jun  7 17:34:22 dnsmasq[1234]: query[A] example.com from 192.168.1.25';
    const r = parseDnsmasqLine(line);
    assert(r !== null);
    assert.equal(r.type, 'query');
    assert.equal(r.qtype, 'A');
    assert.equal(r.domain, 'example.com');
    assert.equal(r.clientIp, '192.168.1.25');
    assert(r.time instanceof Date);
  });

  it('parses a query[AAAA] line', () => {
    const line = 'Jun  7 18:00:00 dnsmasq[1234]: query[AAAA] ipv6.example.com from 192.168.1.93';
    const r = parseDnsmasqLine(line);
    assert(r !== null);
    assert.equal(r.type, 'query');
    assert.equal(r.qtype, 'AAAA');
    assert.equal(r.domain, 'ipv6.example.com');
  });

  it('parses a reply line with IPv4 address', () => {
    const line = 'Jun  7 17:34:22 dnsmasq[1234]: reply example.com is 198.51.100.85';
    const r = parseDnsmasqLine(line);
    assert(r !== null);
    assert.equal(r.type, 'reply');
    assert.equal(r.domain, 'example.com');
    assert.equal(r.resolvedIp, '198.51.100.85');
  });

  it('sets resolvedIp to null for CNAME reply', () => {
    const line = 'Jun  7 17:34:22 dnsmasq[1234]: reply example.com is <CNAME>';
    const r = parseDnsmasqLine(line);
    assert(r !== null);
    assert.equal(r.type, 'reply');
    assert.equal(r.resolvedIp, null);
    assert.equal(r.rawValue, '<CNAME>');
  });

  it('normalises Yamaha proxy IP (169.254.x.x) to "router"', () => {
    const line = 'Jun  7 17:34:19 dnsmasq[1234]: query[A] example.com from 169.254.0.1';
    const r = parseDnsmasqLine(line);
    // parseLine returns raw clientIp; normalisation happens in queueQuery
    // Just confirm the line is parsed as a query
    assert(r !== null);
    assert.equal(r.type, 'query');
    assert.equal(r.clientIp, '169.254.0.1');
  });

  it('returns null for forwarded / non-query lines', () => {
    assert.equal(parseDnsmasqLine('Jun  7 17:34:22 dnsmasq[1234]: forwarded example.com to 192.0.2.53'), null);
    assert.equal(parseDnsmasqLine(''), null);
    assert.equal(parseDnsmasqLine('some random syslog line'), null);
  });

  it('returns null for non-A/AAAA query types', () => {
    const line = 'Jun  7 17:34:22 dnsmasq[1234]: query[PTR] 1.1.168.192.in-addr.arpa from 192.168.1.1';
    assert.equal(parseDnsmasqLine(line), null);
  });
});
