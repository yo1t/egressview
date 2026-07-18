'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const { createConntrackAdapter } = require('../../src/pollers/conntrack-adapter');
const {
  createConntrackPoller,
  parseIpNeighbors,
  parseLanIp,
} = require('../../src/pollers/conntrack-poller');

const SESSION = 'ipv4 2 tcp 6 118 ESTABLISHED src=10.0.0.10 dst=198.51.100.10 sport=50000 dport=443 src=198.51.100.10 dst=192.0.2.1 sport=443 dport=50000';

function fakeClientFactory(scripts, { fingerprint = 'a'.repeat(64), rejectHost = false } = {}) {
  return class FakeClient extends EventEmitter {
    connect(options) {
      this.options = options;
      queueMicrotask(() => {
        if (rejectHost || !options.hostVerifier(fingerprint)) this.emit('error', new Error('Host key verification failed'));
        else this.emit('ready');
      });
    }
    exec(command, callback) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      callback(null, stream);
      queueMicrotask(() => {
        const result = scripts[command] ?? '';
        if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr));
        else if (result) stream.emit('data', Buffer.from(result));
        stream.emit('close', result.code || 0);
      });
    }
    end() { queueMicrotask(() => this.emit('close')); }
  };
}

function readyPoller(scripts, overrides = {}) {
  const poller = createConntrackPoller({ Client: fakeClientFactory(scripts, overrides) });
  poller.configure({
    ip: '192.168.1.1', user: 'root', pass: 'secret', enabled: true,
    hostFp: overrides.expectedHostFp || 'a'.repeat(64),
  });
  return new Promise(resolve => poller.connect(() => resolve(poller)));
}

describe('Linux conntrack poller', () => {
  it('implements the common router adapter contract', () => {
    const adapter = createConntrackAdapter({
      id: 'conntrack-12345678',
      pollerOptions: { Client: fakeClientFactory({}) },
    });
    assert.equal(adapter.kind, 'conntrack');
    assert.equal(adapter.label, 'Linux conntrack');
  });

  it('falls back to conntrack -L when procfs is unavailable', async () => {
    const poller = await readyPoller({
      'cat /proc/net/nf_conntrack': { stderr: 'No such file or directory', code: 1 },
      'conntrack -L': SESSION,
    });
    const sessions = await poller.fetchSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].src, '10.0.0.10');
    poller.disconnect();
  });

  it('reports an actionable error when neither acquisition path is permitted', async () => {
    const poller = await readyPoller({
      'cat /proc/net/nf_conntrack': { stderr: 'Permission denied', code: 1 },
      'conntrack -L': { stderr: 'Operation not permitted', code: 1 },
    });
    await assert.rejects(poller.fetchSessions(), /permission-denied/);
    poller.disconnect();
  });

  it('persists the first host fingerprint before becoming ready', async () => {
    let saves = 0;
    const statuses = [];
    const poller = createConntrackPoller({ Client: fakeClientFactory({}) });
    poller.configure({
      ip: '192.168.1.1', user: 'root', pass: 'secret', enabled: true, hostFp: '',
      onSaveConfig: () => { saves++; },
      onStatus: state => statuses.push(state.state),
    });
    await new Promise(resolve => poller.connect(resolve));
    assert.equal(saves, 1);
    assert.equal(poller.getHostFp(), 'a'.repeat(64));
    assert.equal(statuses.at(-1), 'ready');
    poller.disconnect();
  });

  it('fails closed when the first host fingerprint cannot be persisted', async () => {
    const statuses = [];
    const poller = createConntrackPoller({ Client: fakeClientFactory({}) });
    poller.configure({
      ip: '192.168.1.1', user: 'root', pass: 'secret', enabled: true, hostFp: '',
      onSaveConfig: () => { throw new Error('config read only'); },
      onStatus: state => statuses.push(state),
    });
    poller.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(poller.isReady(), false);
    assert.match(statuses.at(-1).message, /config read only/);
  });

  it('parses IPv4 and IPv6 neighbor caches and a private LAN address', () => {
    const arp = parseIpNeighbors('10.0.0.2 dev br0 lladdr AA:BB:CC:DD:EE:FF REACHABLE', 4);
    const ndp = parseIpNeighbors('2001:db8::2 dev br0 lladdr aa:bb:cc:dd:ee:ff STALE\nfe80::1 dev br0 lladdr aa:bb:cc:dd:ee:ff', 6);
    assert.equal(arp.get('10.0.0.2'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(ndp.has('2001:db8::2'), true);
    assert.equal(ndp.has('fe80::1'), false);
    assert.equal(parseLanIp('2: br0 inet 192.168.50.1/24 brd 192.168.50.255 scope global br0'), '192.168.50.1');
  });
});
