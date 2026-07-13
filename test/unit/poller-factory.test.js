// Unit tests for poller instance isolation (P2-30 PR 1).
// createCiscoPoller / createYamahaPoller must give each instance its own
// config, caches, and connection state so multiple routers can coexist.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const cisco  = require('../../src/pollers/cisco');
const yamaha = require('../../src/pollers/yamaha');
const { createCiscoAdapter }  = require('../../src/pollers/cisco-adapter');
const { createYamahaAdapter } = require('../../src/pollers/yamaha-adapter');
const { validateRouterPoller, REQUIRED_METHODS } = require('../../src/pollers/router-interface');

describe('createCiscoPoller: instance isolation', () => {
  it('keeps config separate between instances', () => {
    const a = cisco.createCiscoPoller({ id: 'cisco-aaaaaaaa' });
    const b = cisco.createCiscoPoller({ id: 'cisco-bbbbbbbb' });
    a.configure({ ip: '192.168.1.1', user: 'ua', pass: 'pa' });
    b.configure({ ip: '192.168.2.1', user: 'ub', pass: 'pb' });
    assert.equal(a.getIp(), '192.168.1.1');
    assert.equal(b.getIp(), '192.168.2.1');
    assert.equal(a.getUser(), 'ua');
    assert.equal(b.getUser(), 'ub');
  });

  it('keeps ARP caches separate between instances', () => {
    const a = cisco.createCiscoPoller();
    const b = cisco.createCiscoPoller();
    a.getArpCache().set('192.168.1.10', 'aa:bb:cc:dd:ee:01');
    assert.equal(a.getArpMac('192.168.1.10'), 'aa:bb:cc:dd:ee:01');
    assert.equal(b.getArpMac('192.168.1.10'), null);
  });

  it('does not share state with the default module instance', () => {
    const a = cisco.createCiscoPoller();
    a.configure({ ip: '10.99.99.1' });
    assert.notEqual(cisco.getIp(), '10.99.99.1');
  });

  it('reports its id', () => {
    assert.equal(cisco.createCiscoPoller({ id: 'cisco-12345678' }).getId(), 'cisco-12345678');
    assert.equal(cisco.createCiscoPoller().getId(), '');
  });

  it('enabled/ready flags are per instance', () => {
    const a = cisco.createCiscoPoller();
    const b = cisco.createCiscoPoller();
    a.configure({ enabled: true });
    assert.equal(a.isEnabled(), true);
    assert.equal(b.isEnabled(), false);
    assert.equal(a.isReady(), false);
  });
});

describe('createYamahaPoller: instance isolation', () => {
  it('keeps config separate between instances', () => {
    const a = yamaha.createYamahaPoller({ id: 'yamaha-aaaaaaaa' });
    const b = yamaha.createYamahaPoller({ id: 'yamaha-bbbbbbbb' });
    a.configure({ ip: '192.168.1.2', natDescriptor: '100' });
    b.configure({ ip: '192.168.2.2', natDescriptor: '200' });
    assert.equal(a.getIp(), '192.168.1.2');
    assert.equal(b.getIp(), '192.168.2.2');
    assert.equal(a.getNat(), '100');
    assert.equal(b.getNat(), '200');
  });

  it('keeps ARP caches separate between instances', () => {
    const a = yamaha.createYamahaPoller();
    const b = yamaha.createYamahaPoller();
    a.getArpCache().set('192.168.1.20', 'aa:bb:cc:dd:ee:02');
    assert.equal(a.getArpMac('192.168.1.20'), 'aa:bb:cc:dd:ee:02');
    assert.equal(b.getArpMac('192.168.1.20'), null);
  });

  it('does not share state with the default module instance', () => {
    const a = yamaha.createYamahaPoller();
    a.configure({ ip: '10.88.88.1' });
    assert.notEqual(yamaha.getIp(), '10.88.88.1');
  });
});

describe('adapter factories', () => {
  it('createCiscoAdapter({id}) satisfies the router poller contract', () => {
    const adapter = createCiscoAdapter({ id: 'cisco-deadbeef' });
    assert.doesNotThrow(() => validateRouterPoller(adapter));
    assert.equal(adapter.kind, 'cisco');
    assert.equal(adapter.id, 'cisco-deadbeef');
    for (const m of REQUIRED_METHODS) assert.equal(typeof adapter[m], 'function');
  });

  it('createYamahaAdapter({id}) satisfies the router poller contract', () => {
    const adapter = createYamahaAdapter({ id: 'yamaha-deadbeef' });
    assert.doesNotThrow(() => validateRouterPoller(adapter));
    assert.equal(adapter.kind, 'yamaha');
    assert.equal(adapter.id, 'yamaha-deadbeef');
  });

  it('adapter instances are isolated from each other and the singleton', () => {
    const a = createCiscoAdapter({ id: 'cisco-11111111' });
    const b = createCiscoAdapter({ id: 'cisco-22222222' });
    a.configure({ ip: '172.16.0.1' });
    b.configure({ ip: '172.16.0.2' });
    assert.equal(a.getIp(), '172.16.0.1');
    assert.equal(b.getIp(), '172.16.0.2');
    const singleton = require('../../src/pollers/cisco-adapter');
    assert.notEqual(singleton.getIp(), '172.16.0.1');
    assert.notEqual(singleton.getIp(), '172.16.0.2');
  });

  it('createCiscoAdapter() without id wraps the legacy singleton', () => {
    const adapter = createCiscoAdapter();
    const legacy  = require('../../src/pollers/cisco');
    // Both must read the same underlying config state
    assert.equal(adapter.getIp(), legacy.getIp());
  });
});
