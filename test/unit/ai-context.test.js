'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  buildAiContext, MAX_DEVICE_INVENTORY, MAX_NETWORK_NODES, MAX_DEVICES_PER_NODE, MAX_CONTEXT_BYTES,
} = require('../../src/ai-context');

const baseFacts = {
  range: { from: 1, to: 2, durationMs: 1 },
  previousRange: { from: 0, to: 1, durationMs: 1 },
  collection: { health: 'ok', enabledCount: 1, readyCount: 1 },
  current: { connections: 10, devices: 3, destinations: 3, safe: 5, warn: 8, danger: 2 },
  previous: { connections: 5, devices: 2, destinations: 2, safe: 5, warn: 0, danger: 0 },
};

describe('AI context', () => {
  it('includes destination IPs/hostnames and prioritizes threats with contacting devices', () => {
    const dstRows = [
      { dst: '203.0.113.9', dstHost: 'evil.example', cnt: 2 },    // danger
      { dst: '198.51.100.5', dstHost: 'warn.example', cnt: 8 },   // warn
      { dst: '93.184.216.34', dstHost: 'example.com', cnt: 50 },  // safe
    ];
    const threatIntel = {
      matchThreatIntel(ip) {
        if (ip === '203.0.113.9') return { confidence: 'high', source: 'feodo', tag: 'Emotet C2' };
        if (ip === '198.51.100.5') return { confidence: 'low', source: 'urlhaus', tag: 'suspicious' };
        return null;
      },
    };
    const history = {
      groupServiceByTimeRange: () => [{ dport: 443, proto: 'tcp', count: 50 }],
      groupDstByTimeRange: () => dstRows,
      groupSrcForDstsByTimeRange: (_from, _to, dsts) => {
        assert.ok(dsts.includes('203.0.113.9'));
        return [
          { dst: '203.0.113.9', src: '192.168.1.10', srcDnsName: 'laptop-a', srcMdnsName: null, srcMac: 'AA:BB:CC:00:11:22', cnt: 2 },
          { dst: '198.51.100.5', src: '192.168.1.20', srcDnsName: null, srcMdnsName: 'phone-b', srcMac: null, cnt: 8 },
        ];
      },
    };

    const context = buildAiContext({
      facts: baseFacts,
      history,
      routers: [{ enabled: true, kind: 'cisco', id: 'router.internal', displayName: 'core-fw' }],
      from: 1,
      to: 2,
      threatIntel,
    });

    // Threats: danger before warn, with linked devices (dns then mdns fallback).
    assert.equal(context.threats.length, 2);
    assert.equal(context.threats[0].ip, '203.0.113.9');
    assert.equal(context.threats[0].level, 'danger');
    assert.equal(context.threats[0].host, 'evil.example');
    assert.equal(context.threats[0].source, 'feodo');
    assert.deepEqual(context.threats[0].devices[0], { ip: '192.168.1.10', name: 'laptop-a', mac: 'AA:BB:CC:00:11:22', connections: 2 });
    assert.equal(context.threats[1].level, 'warn');
    assert.equal(context.threats[1].devices[0].name, 'phone-b');
    assert.equal(context.threats[1].devices[0].mac, null);

    // Top destinations sorted by connections, with IP + hostname.
    assert.equal(context.topDestinations[0].ip, '93.184.216.34');
    assert.equal(context.topDestinations[0].connections, 50);
    assert.deepEqual(context.topServices, [{ port: 443, protocol: 'tcp', connections: 50 }]);

    // No longer anonymized: identifying connection data is present, but router
    // display names are still not exposed.
    assert.equal(context.privacy.anonymized, false);
    const serialized = JSON.stringify(context);
    assert.ok(serialized.includes('203.0.113.9'));
    assert.ok(serialized.includes('laptop-a'));
    assert.equal(serialized.includes('core-fw'), false);
    assert.deepEqual(context.collection.routerKinds, { cisco: 1 });
  });

  it('builds destinations without threats when no threat intel is available', () => {
    const context = buildAiContext({
      facts: { range: {}, previousRange: {}, collection: {}, current: {}, previous: {} },
      routers: [],
      from: 0,
      to: 1,
      threatIntel: null,
      history: {
        groupServiceByTimeRange: () => [],
        groupDstByTimeRange: () => [{ dst: '8.8.8.8', dstHost: 'dns.google', cnt: 3 }, { dst: '1.1.1.1', dstHost: '1.1.1.1', cnt: 1 }],
        groupSrcForDstsByTimeRange: () => [],
      },
    });
    assert.deepEqual(context.threats, []);
    assert.equal(context.topDestinations[0].ip, '8.8.8.8');
    assert.equal(context.topDestinations[0].host, 'dns.google');
    // When the hostname equals the IP it is reported as null (no useful name).
    assert.equal(context.topDestinations[1].host, null);
  });

  it('bounds the service and destination lists', () => {
    const services = Array.from({ length: 30 }, (_, i) => ({ dport: i, proto: 'tcp', count: 1 }));
    const dsts = Array.from({ length: 40 }, (_, i) => ({ dst: `10.0.0.${i}`, dstHost: null, cnt: i }));
    const context = buildAiContext({
      facts: { range: {}, previousRange: {}, collection: {}, current: {}, previous: {} },
      routers: [],
      from: 0,
      to: 1,
      threatIntel: null,
      history: {
        groupServiceByTimeRange: () => services,
        groupDstByTimeRange: () => dsts,
        groupSrcForDstsByTimeRange: () => [],
      },
    });
    assert.equal(context.topServices.length, 20);
    assert.equal(context.topDestinations.length, 15);
  });

  it('adds a bounded device inventory and ASUS topology without private database fields', () => {
    const knownDevices = Array.from({ length: 40 }, (_, i) => ({
      ip: `192.168.1.${i + 1}`,
      mac: `AA:BB:CC:DD:EE:${String(i).padStart(2, '0')}`,
      vendor: `Vendor ${i}`,
      dnsName: `device-${i}.example`,
      ipv6Addr: `2001:db8::${i}`,
      firstSeen: 100 + i,
      lastSeen: 200 + i,
      sources: 'asus,arp',
      noteKey: `private-note-${i}`,
      deviceId: `private-id-${i}`,
      status: 'online',
    }));
    const activity = [
      { src: '192.168.1.2', srcMac: knownDevices[1].mac, count: 99, firstSeen: 150, lastSeen: 250 },
      { src: '192.168.1.99', srcMac: '12:34:56:78:90:AB', srcVendor: 'Observed vendor', srcMdnsName: 'observed-only', count: 30, firstSeen: 160, lastSeen: 260 },
    ];
    const meshNodes = Array.from({ length: 12 }, (_, i) => ({
      mac: `00:11:22:33:44:${String(i).padStart(2, '0')}`,
      ip: `192.168.50.${i + 1}`,
      alias: `mesh-${i}`,
      model: 'ASUS Node',
      online: true,
    }));
    const clients = Array.from({ length: 8 }, (_, i) => ({
      ip: `192.168.1.${i + 1}`,
      mac: knownDevices[i].mac,
      name: `client-${i}`,
      vendor: `Vendor ${i}`,
      type: '2',
      rssi: -40 - i,
      amesh_papMac: meshNodes[0].mac.toLowerCase(),
    }));
    clients.push({ ip: '192.168.1.250', mac: '22:22:22:22:22:22', name: 'unassigned' });

    const context = buildAiContext({
      facts: baseFacts,
      routers: [],
      from: 100,
      to: 300,
      history: {
        groupServiceByTimeRange: () => [],
        groupDstByTimeRange: () => [],
        groupSrcForDstsByTimeRange: () => [],
        groupSrcByTimeRange: (_from, _to, limit) => {
          assert.equal(limit, MAX_DEVICE_INVENTORY);
          return activity;
        },
      },
      devices: { getAll: () => knownDevices },
      asus: { getClients: () => clients, getMeshNodes: () => meshNodes },
    });

    assert.equal(context.schemaVersion, 3);
    assert.equal(context.deviceInventory.totalKnown, 40);
    assert.equal(context.deviceInventory.included, MAX_DEVICE_INVENTORY);
    assert.equal(context.deviceInventory.devices[0].connections, 99);
    assert.equal(context.deviceInventory.devices[0].name, 'device-1.example');
    assert.equal(context.deviceInventory.devices[1].name, 'observed-only');
    assert.deepEqual(context.deviceInventory.devices[0].sources, ['asus', 'arp']);
    assert.equal(context.networkTopology.nodes.length, MAX_NETWORK_NODES);
    assert.equal(context.networkTopology.nodes[0].connectedDevices, 8);
    assert.equal(context.networkTopology.nodes[0].sampleDevices.length, MAX_DEVICES_PER_NODE);
    assert.equal(context.networkTopology.unassignedDevices, 1);
    assert.equal(context.networkTopology.nodes[0].ip, undefined);

    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes('private-note'), false);
    assert.equal(serialized.includes('private-id'), false);
    assert.equal(serialized.includes('192.168.50.'), false);
    assert.ok(Buffer.byteLength(serialized) <= MAX_CONTEXT_BYTES);
    assert.equal(context.limits.serializedBytes, Buffer.byteLength(serialized));
    assert.ok(context.privacy.excluded.includes('userNotes'));
    assert.ok(context.privacy.excluded.includes('nodeManagementAddress'));
  });

  it('does not mix global inventory or ASUS topology into a selected source', () => {
    const sourceScope = { sourceKind: 'agent', sourceId: 'agent-1' };
    const history = {
      groupServiceByTimeRange: (_from, _to, options) => {
        assert.deepEqual(options.sourceScope, sourceScope);
        return [];
      },
      groupDstByTimeRange: () => [],
      groupSrcForDstsByTimeRange: () => [],
      groupSrcByTimeRange: () => [{
        src: '192.0.2.10', srcMac: 'AA:BB:CC:DD:EE:10', count: 3,
      }],
    };
    const context = buildAiContext({
      facts: baseFacts,
      routers: [],
      from: 100,
      to: 300,
      sourceScope,
      history,
      devices: { getAll: () => [
        { ip: '192.0.2.10', mac: 'AA:BB:CC:DD:EE:10', dnsName: 'selected-device' },
        { ip: '192.0.2.20', mac: 'AA:BB:CC:DD:EE:20', dnsName: 'unrelated-device' },
      ] },
      asus: {
        getClients: () => [{ ip: '192.0.2.20', mac: 'AA:BB:CC:DD:EE:20' }],
        getMeshNodes: () => [{ mac: '00:11:22:33:44:55', alias: 'global-node' }],
      },
    });

    assert.deepEqual(context.sourceScope, sourceScope);
    assert.deepEqual(context.deviceInventory.devices.map(device => device.name), ['selected-device']);
    assert.equal(context.networkTopology, null);
    assert.equal(JSON.stringify(context).includes('unrelated-device'), false);
    assert.equal(JSON.stringify(context).includes('global-node'), false);
  });

  it('trims duplicated detail to enforce the final serialized byte limit', () => {
    const long = 'x'.repeat(253);
    const destinations = Array.from({ length: 40 }, (_, i) => ({
      dst: `203.0.113.${i}`, dstHost: `${i}.${long}`, cnt: 100 - i,
    }));
    const context = buildAiContext({
      facts: baseFacts,
      routers: [],
      from: 100,
      to: 300,
      threatIntel: { matchThreatIntel: () => ({ confidence: 'high', source: long, tag: long }) },
      history: {
        groupServiceByTimeRange: () => [],
        groupDstByTimeRange: () => destinations,
        groupSrcByTimeRange: () => Array.from({ length: 30 }, (_, i) => ({
          src: `192.168.1.${i}`, srcMac: `AA:BB:CC:DD:EE:${String(i).padStart(2, '0')}`,
          srcDnsName: long, srcVendor: long, count: 100 - i,
        })),
        groupSrcForDstsByTimeRange: (_from, _to, dsts) => dsts.flatMap(dst =>
          Array.from({ length: 5 }, (_, i) => ({
            dst, src: `192.168.2.${i}`, srcDnsName: long,
            srcMac: `11:22:33:44:55:${String(i).padStart(2, '0')}`, cnt: 10,
          }))),
      },
      devices: { getAll: () => [] },
      asus: {
        getMeshNodes: () => Array.from({ length: 10 }, (_, i) => ({
          mac: `00:11:22:33:44:${String(i).padStart(2, '0')}`, alias: long, model: long, online: true,
        })),
        getClients: () => Array.from({ length: 50 }, (_, i) => ({
          ip: `192.168.3.${i}`, mac: `22:33:44:55:66:${String(i).padStart(2, '0')}`,
          name: long, vendor: long, amesh_papMac: `00:11:22:33:44:${String(Math.floor(i / 5)).padStart(2, '0')}`,
        })),
      },
    });

    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= MAX_CONTEXT_BYTES);
    assert.equal(context.limits.serializedBytes, Buffer.byteLength(JSON.stringify(context)));
  });
});
