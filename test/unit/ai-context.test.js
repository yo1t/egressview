'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildAiContext } = require('../../src/ai-context');

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
          { dst: '203.0.113.9', src: '192.168.1.10', srcDnsName: 'laptop-a', srcMdnsName: null, cnt: 2 },
          { dst: '198.51.100.5', src: '192.168.1.20', srcDnsName: null, srcMdnsName: 'phone-b', cnt: 8 },
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
    assert.deepEqual(context.threats[0].devices[0], { ip: '192.168.1.10', name: 'laptop-a', connections: 2 });
    assert.equal(context.threats[1].level, 'warn');
    assert.equal(context.threats[1].devices[0].name, 'phone-b');

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
});
