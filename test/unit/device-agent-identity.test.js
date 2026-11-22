'use strict';

// The device list and what Agents know of their own computers (P3-199,
// P3-200): rows that are not devices are not made and are hidden, the row a
// computer is on gets its name, maker, model and IPv6 addresses, and the row
// it left is offered for merging.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const devices = require('../../src/devices');
const {
  buildAgentDeviceIdentities, createAgentDeviceIdentityReader,
} = require('../../src/device-agent-identity');

const HOUR = 60 * 60 * 1000;

beforeEach(() => devices._initForTest());
after(() => devices._initForTest());

function rowAt(ip) {
  return devices.getAll({ includeArchived: true }).find(row => row.ip === ip);
}

describe('端末でない行を作らず、残っていれば非表示にする', () => {
  it('起動時の書き込みでも、IPv6・ループバック・Agentの仮想アダプターの行は作らない', () => {
    const history = new Map([
      ['a', { src: '2001:db8::10', firstSeen: 1, lastSeen: 2 }],
      ['b', { src: 'fe80::1', firstSeen: 1, lastSeen: 2 }],
      ['c', { src: '127.0.0.1', firstSeen: 1, lastSeen: 2 }],
      ['d', { src: '198.51.100.1', agentHost: 'pc', firstSeen: 1, lastSeen: 2 }],
      ['e', { src: '192.0.2.20', srcMac: 'aa:bb:cc:00:00:20', firstSeen: 1, lastSeen: 2 }],
    ]);
    devices.seedFromConnectionHistory(history);
    assert.deepEqual(devices.getAll().map(row => row.ip), ['192.0.2.20']);
  });

  it('Agentの通信だけでは、.1と.255の行を新しく作らない。ある行は更新する', () => {
    assert.equal(devices.observeDevice({ ip: '198.51.100.1', source: 'agent' }), null);
    assert.equal(devices.observeDevice({ ip: '192.0.2.255', source: 'agent' }), null);
    assert.ok(devices.observeDevice({ ip: '192.0.2.30', source: 'agent' }));
    // A router saw the gateway first; the Agent's sighting keeps it current.
    devices.observeDevice({ ip: '192.0.2.1', mac: 'aa:bb:cc:00:00:01', source: 'nat', lastSeen: 1000 });
    assert.ok(devices.observeDevice({ ip: '192.0.2.1', source: 'agent', lastSeen: 5000 }));
    assert.equal(rowAt('192.0.2.1').lastSeen, 5000);
  });

  it('前の版が作った端末でない行は非表示にし、消さない。ふつうの行はそのまま', () => {
    devices.upsert({ ip: '2001:db8::10', source: 'nat' });
    devices.upsert({ ip: '127.0.0.1', source: 'nat' });
    devices.upsert({ ip: '198.51.100.1', source: 'agent' });
    devices.upsert({ ip: '192.0.2.255', source: 'agent' });
    devices.upsert({ ip: '192.0.2.1', mac: 'aa:bb:cc:00:00:01', source: 'agent' });
    devices.upsert({ ip: '192.0.2.40', source: 'agent' });
    devices.upsert({ ip: '192.0.2.50', mac: 'aa:bb:cc:00:00:50', source: 'nat' });

    assert.equal(devices.archiveNonDevices(), 4);
    assert.deepEqual(devices.getAll().map(row => row.ip).sort(), ['192.0.2.1', '192.0.2.40', '192.0.2.50']);
    assert.equal(rowAt('2001:db8::10').status, 'archived');
    assert.equal(devices.archiveNonDevices(), 0, 'nothing left the second time');
  });
});

function fakeAgents(list) {
  return { listAgents: () => list };
}

function fakeIngest(addressesByAgent, hardware = new Map()) {
  return {
    listAgentAddresses: ({ agentId }) => ({ addresses: addressesByAgent[agentId] || [], collectors: [] }),
    listAgentHardware: () => hardware,
  };
}

describe('AgentのPCがいる行に、名前・メーカー・機種・IPv6を付ける', () => {
  const now = 10 * 24 * HOUR;

  it('ルーターがMACを知っているLANのアドレスを選び、仮想アダプターとリンクローカルは選ばない', () => {
    devices.upsert({ ip: '192.0.2.45', mac: 'f2:1a:20:00:00:45', dnsName: 'Mac', source: 'dhcp' });
    devices.upsert({ ip: '198.51.100.9', source: 'agent' });
    const identities = buildAgentDeviceIdentities({
      agentIdentities: fakeAgents([{ agentId: 'm1', platform: 'macos', hostName: 'Studio Mac', lastSeenAt: now - HOUR }]),
      agentIngest: fakeIngest({ m1: [
        { address: '198.51.100.1', lastUsedAt: now - HOUR },
        { address: '198.51.100.9', lastUsedAt: now - HOUR },
        { address: '2001:db8::45', lastUsedAt: now - HOUR },
        { address: '192.0.2.45', lastUsedAt: now - 2 * HOUR },
        { address: '2001:db8::46', lastUsedAt: now - 2 * HOUR },
      ] }, new Map([['m1', { manufacturer: 'Apple', model: 'Mac14,2' }]])),
      devices,
      now,
    });
    assert.deepEqual([...identities.keys()], ['192.0.2.45']);
    const mac = identities.get('192.0.2.45');
    assert.equal(mac.hostName, 'Studio Mac');
    assert.equal(mac.manufacturer, 'Apple');
    assert.equal(mac.model, 'Mac14,2');
    assert.deepEqual(mac.ipv6, ['2001:db8::45', '2001:db8::46']);
  });

  it('ルーターから見えない仮想マシンでも、行があればそこに付ける', () => {
    devices.upsert({ ip: '198.51.100.134', source: 'agent' });
    const identities = buildAgentDeviceIdentities({
      agentIdentities: fakeAgents([{ agentId: 'w1', platform: 'windows', hostName: 'VM-PC', lastSeenAt: now }]),
      agentIngest: fakeIngest({ w1: [
        { address: '198.51.100.255', lastUsedAt: now },
        { address: '198.51.100.134', lastUsedAt: now },
      ] }),
      devices,
      now,
    });
    assert.equal(identities.get('198.51.100.134')?.hostName, 'VM-PC');
  });

  it('24時間届いていないAgentと、取り消したAgentは付けない', () => {
    devices.upsert({ ip: '192.0.2.60', mac: 'aa:bb:cc:00:00:60', source: 'nat' });
    const addresses = [{ address: '192.0.2.60', lastUsedAt: now - 30 * HOUR }];
    const identities = buildAgentDeviceIdentities({
      agentIdentities: fakeAgents([
        { agentId: 'old', hostName: 'old', lastSeenAt: now - 25 * HOUR },
        { agentId: 'gone', hostName: 'gone', lastSeenAt: now, revokedAt: now - HOUR },
      ]),
      agentIngest: fakeIngest({ old: addresses, gone: addresses }),
      devices,
      now,
    });
    assert.equal(identities.size, 0);
  });
});

describe('アドレスが変わったら、前の行をまとめる候補に出す', () => {
  it('前のアドレスで、その後に何も見ていなければ候補に出す。理由にAgentの名前', () => {
    devices.upsert({ ip: '192.0.2.70', mac: 'aa:bb:cc:00:00:70', source: 'nat', lastSeen: 1_000_000 });
    devices.noteAgentAddress({ agentId: 'm1', hostName: 'Studio Mac', ip: '192.0.2.70', at: 1_000_000 });
    devices.upsert({ ip: '192.0.2.71', mac: 'aa:bb:cc:00:00:70', source: 'nat', lastSeen: 2_000_000 });
    assert.equal(devices.noteAgentAddress({ agentId: 'm1', hostName: 'Studio Mac', ip: '192.0.2.71', at: 2_000_000 }), 1);
    const [candidate] = devices.getMergeCandidates('pending');
    assert.ok(candidate);
    assert.deepEqual(JSON.parse(candidate.reasons), ['sameAgent="Studio Mac"']);
  });

  it('前のアドレスを後で別の機器が使っていれば、候補に出さない', () => {
    devices.upsert({ ip: '192.0.2.80', source: 'nat', lastSeen: 1_000_000 });
    devices.noteAgentAddress({ agentId: 'm1', ip: '192.0.2.80', at: 1_000_000 });
    devices.upsert({ ip: '192.0.2.80', source: 'nat', lastSeen: 1_000_000 + HOUR });
    devices.upsert({ ip: '192.0.2.81', source: 'nat', lastSeen: 2_000_000 });
    assert.equal(devices.noteAgentAddress({ agentId: 'm1', ip: '192.0.2.81', at: 2_000_000 }), 0);
    assert.equal(devices.getMergeCandidates('pending').length, 0);
  });

  it('画面を開くたびの読み込みは1分のあいだ使い回し、そのつど居場所を記録する', () => {
    devices.upsert({ ip: '192.0.2.90', mac: 'aa:bb:cc:00:00:90', source: 'nat' });
    let reads = 0;
    let clock = 5_000_000;
    const agentIngest = fakeIngest({ m1: [{ address: '192.0.2.90', lastUsedAt: clock }] });
    const counting = { ...agentIngest, listAgentAddresses: options => { reads += 1; return agentIngest.listAgentAddresses(options); } };
    const read = createAgentDeviceIdentityReader({
      agentIdentities: fakeAgents([{ agentId: 'm1', hostName: 'm', lastSeenAt: clock }]),
      agentIngest: counting, devices,
    }, { clock: () => clock });
    read();
    read();
    assert.equal(reads, 1);
    clock += 61_000;
    read();
    assert.equal(reads, 2);
  });
});
