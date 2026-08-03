// Fuzz tests for parsers that read untrusted external input (P2-71)
//
// Run (short, PR gate):  node --test test/fuzz/parsers.fuzz.test.js
// Run (long, on demand): FUZZ_ITERATIONS=20000 npm run test:fuzz
// Reproduce a failure:   FUZZ_SEED=123456 npm run test:fuzz
//
// Scope is deliberately narrow: functions that turn a string from a router,
// a syslog file or a conntrack table into structured data. Those strings come
// from devices EgressView does not control, and a parser that throws takes a
// poller down while one that never returns hangs it.
//
// Three properties are asserted for every generated input:
//   1. it does not throw
//   2. it returns within a time budget (catches catastrophic backtracking)
//   3. the return value has the declared shape
//
// No network I/O, and no real credentials or captured production logs: every
// sample below is synthetic and uses documentation address ranges.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { forEachInput, describeFailure } = require('./fuzz-lib');

const conntrack = require('../../src/pollers/conntrack');
const cisco = require('../../src/pollers/cisco');
const yamaha = require('../../src/pollers/yamaha');
const asus = require('../../src/pollers/asus');
const dnsmasq = require('../../src/pollers/dnsmasq-log');
const inspectSyslog = require('../../src/pollers/inspect-syslog');
const dhcpd = require('../../src/pollers/dhcpd-syslog');
const conntrackPoller = require('../../src/pollers/conntrack-poller');

// A short run keeps the PR gate fast; the nightly/manual run raises it.
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 300;
const SEED = Number(process.env.FUZZ_SEED) || Math.floor(Math.random() * 2 ** 31);

// Shape assertions. A parser returning undefined, or an array with a
// non-object element, is a defect even when it does not throw: the callers
// index into these results without re-checking.
const isArrayOfObjects = (value) =>
  Array.isArray(value) && value.every(item => item !== null && typeof item === 'object');
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringOrNullish = (value) =>
  value === null || value === undefined || typeof value === 'string';
const isObjectOrNull = (value) => value === null || isPlainObject(value);
const isNumberOrNull = (value) =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

// Synthetic samples only. RFC 5737 / RFC 3849 documentation addresses.
const CONNTRACK_SAMPLES = [
  'tcp      6 431999 ESTABLISHED src=192.0.2.10 dst=198.51.100.7 sport=51234 dport=443 src=198.51.100.7 dst=203.0.113.1 sport=443 dport=51234 [ASSURED] mark=0 use=1',
  'udp      17 29 src=192.0.2.11 dst=198.51.100.8 sport=53 dport=53 [UNREPLIED] src=198.51.100.8 dst=192.0.2.11 sport=53 dport=53 mark=0 use=1',
  'icmp     1 30 src=192.0.2.12 dst=198.51.100.9 type=8 code=0 id=1 mark=0 use=1',
];

const CISCO_NAT_SAMPLES = [
  'tcp 203.0.113.1:51234    192.0.2.10:51234   198.51.100.7:443    198.51.100.7:443',
  'udp 203.0.113.1:53       192.0.2.11:53      198.51.100.8:53     198.51.100.8:53',
  '--- 203.0.113.1          192.0.2.10         ---                 ---',
];

const CISCO_ARP_SAMPLES = [
  'Internet  192.0.2.10             12   aabb.ccdd.eeff  ARPA   GigabitEthernet0/1',
  'Internet  192.0.2.11              -   aabb.ccdd.0000  ARPA   Vlan1',
];

const CISCO_NDP_SAMPLES = [
  '2001:db8::1                                 12 aabb.ccdd.eeff  REACH Gi0/1',
  '2001:db8::2                                  0 aabb.ccdd.0000  STALE Vl1',
];

const YAMAHA_NAT_SAMPLES = [
  'NAT/IP Masquerade Descriptor  1, Referenced by IP Interface',
  'Outer  203.0.113.1',
  'tcp 192.0.2.10.51234 198.51.100.7.443 203.0.113.1.51234',
  'Session Total: 100, Free: 4000',
];

const ASUS_CLIENT_SAMPLES = [
  '{"aa:bb:cc:dd:ee:ff":{"ip":"192.0.2.10","name":"laptop","isOnline":"1","rssi":"-52"}}',
  '{"get_clientlist":{"maclist":["aa:bb:cc:dd:ee:ff"]}}',
];

const ASUS_NETDEV_SAMPLES = [
  'INTERNET rx=0x1234 tx=0x5678',
  'WIRED rx=0 tx=0',
];

const SYSLOG_SAMPLES = [
  'Aug  3 12:34:56 router dhcpd: DHCPACK on 192.0.2.10 to aa:bb:cc:dd:ee:ff (laptop) via eth0',
  'Aug  3 12:34:56 dnsmasq[1234]: query[A] example.test from 192.0.2.10',
  'Aug  3 12:34:56 dnsmasq[1234]: reply example.test is 198.51.100.7',
  '2026-08-03 12:34:56 [INSPECT] PASS TCP 192.0.2.10:51234 > 198.51.100.7:443',
];

const IP_NEIGH_SAMPLES = [
  '192.0.2.10 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
  '2001:db8::1 dev eth0 lladdr aa:bb:cc:dd:ee:ff STALE',
];

const IP_ADDR_SAMPLES = [
  '2: eth0    inet 192.0.2.1/24 brd 192.0.2.255 scope global eth0',
  '1: lo    inet 127.0.0.1/8 scope host lo',
];

const TARGETS = [
  ['conntrack.parseConntrack', (s) => conntrack.parseConntrack(s), isArrayOfObjects, CONNTRACK_SAMPLES],
  ['conntrack.parseConntrackLine', (s) => conntrack.parseConntrackLine(s), isObjectOrNull, CONNTRACK_SAMPLES],
  ['cisco.parseNatTranslations', (s) => cisco.parseNatTranslations(s), isArrayOfObjects, CISCO_NAT_SAMPLES],
  ['cisco.parseCiscoAge', (s) => cisco.parseCiscoAge(s), isNumberOrNull, ['12', '00:01:02', '1w2d']],
  ['cisco.parseArp', (s) => cisco.parseArp(s), isPlainObject, CISCO_ARP_SAMPLES],
  ['cisco.parseNdpNeighbors', (s) => cisco.parseNdpNeighbors(s), isPlainObject, CISCO_NDP_SAMPLES],
  ['cisco.parseLanIp', (s) => cisco.parseLanIp(s), isStringOrNullish, IP_ADDR_SAMPLES],
  ['cisco.parseNatInsideInterfaces', (s) => cisco.parseNatInsideInterfaces(s), isArrayOfObjects, ['ip nat inside', 'interface GigabitEthernet0/1']],
  ['yamaha.parseNatDetail', (s) => yamaha.parseNatDetail(s), isArrayOfObjects, YAMAHA_NAT_SAMPLES],
  ['yamaha.parseNatDescriptorCandidates', (s) => yamaha.parseNatDescriptorCandidates(s), isArrayOfObjects, YAMAHA_NAT_SAMPLES],
  ['yamaha.parseLanIp', (s) => yamaha.parseLanIp(s), isStringOrNullish, ['LAN1 address: 192.0.2.1/24']],
  ['asus.parseClientList', (s) => asus.parseClientList(s), isArrayOfObjects, ASUS_CLIENT_SAMPLES],
  ['asus.parseNetdev', (s) => asus.parseNetdev(s), isPlainObject, ASUS_NETDEV_SAMPLES],
  ['asus.parseMeshNodes', (s) => asus.parseMeshNodes(s), isArrayOfObjects, ASUS_CLIENT_SAMPLES],
  ['dnsmasq._parseLine', (s) => dnsmasq._parseLine(s), isObjectOrNull, SYSLOG_SAMPLES],
  ['inspectSyslog._parseLine', (s) => inspectSyslog._parseLine(s), isObjectOrNull, SYSLOG_SAMPLES],
  ['dhcpd._parseLine', (s) => dhcpd._parseLine(s), isObjectOrNull, SYSLOG_SAMPLES],
  ['conntrackPoller.parseIpNeighbors', (s) => conntrackPoller.parseIpNeighbors(s, 4), isPlainObject, IP_NEIGH_SAMPLES],
  ['conntrackPoller.parseLanIp', (s) => conntrackPoller.parseLanIp(s), isStringOrNullish, IP_ADDR_SAMPLES],
];

describe(`外部入力パーサのfuzz (seed=${SEED}, iterations=${ITERATIONS})`, () => {
  for (const [name, call, shapeOk, samples] of TARGETS) {
    it(`${name}: 例外を投げず、時間内に、定義済みshapeを返す`, () => {
      const failures = forEachInput({ samples, iterations: ITERATIONS, seed: SEED }, (input) => {
        const result = call(input);
        if (!shapeOk(result)) {
          throw new Error(`unexpected shape: ${Object.prototype.toString.call(result)}`);
        }
      });
      assert.deepEqual(
        failures.map(describeFailure),
        [],
        `${name} failed. Reproduce with FUZZ_SEED=${SEED}`
      );
    });
  }

  it('プロトタイプ汚染を持ち込まない', () => {
    // Several of these build objects keyed by parsed field names.
    const polluting = [
      '{"__proto__":{"polluted":true}}',
      '__proto__=polluted',
      'src=__proto__ dst=constructor',
      'Internet  __proto__  12  aabb.ccdd.eeff  ARPA  Gi0/1',
    ];
    for (const [name, call] of TARGETS) {
      for (const input of polluting) {
        try { call(input); } catch { /* covered by the case above */ }
        assert.equal({}.polluted, undefined, `${name} polluted Object.prototype`);
      }
    }
  });
});
