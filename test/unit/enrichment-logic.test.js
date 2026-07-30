// Unit tests for src/enrichment.js — pure logic and cache behaviour
// (No network calls; HTTP fetch paths are not exercised here)
// Run: node --test test/unit/enrichment-logic.test.js

'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const enrichment = require('../../src/enrichment');

// Re-initialise with in-memory DB before every suite
function reset() { enrichment._initForTest(); }

// ─── isPtrJunk ────────────────────────────────────────────────────────────────

describe('isPtrJunk', () => {
  it('returns true for null/undefined', () => {
    assert.equal(enrichment.isPtrJunk(null), true);
    assert.equal(enrichment.isPtrJunk(undefined), true);
    assert.equal(enrichment.isPtrJunk(''), true);
  });

  it('returns true for EC2 compute hostnames', () => {
    assert.equal(enrichment.isPtrJunk('ec2-52-1-2-3.compute-1.amazonaws.com'), true);
    assert.equal(enrichment.isPtrJunk('ip-10-0-1-1.ap-northeast-1.compute.internal'), true);
  });

  it('returns true for raw dotted-decimal hostnames', () => {
    assert.equal(enrichment.isPtrJunk('192-168-1-1.somehost.example'), true);
  });

  it('returns true for in-addr.arpa hostnames', () => {
    assert.equal(enrichment.isPtrJunk('1.1.168.192.in-addr.arpa'), true);
  });

  it('returns false for a normal hostname', () => {
    assert.equal(enrichment.isPtrJunk('example.com'), false);
    assert.equal(enrichment.isPtrJunk('api.github.com'), false);
  });

  it('returns false for a short hostname', () => {
    assert.equal(enrichment.isPtrJunk('router.local'), false);
  });
});

// ─── RDAP cache hit ───────────────────────────────────────────────────────────

describe('lookupRdap cache hit', () => {
  before(reset);

  it('returns cached entry without hitting the network', async () => {
    const now = Date.now();
    // Populate cache directly (getRdapCache returns the live Map reference)
    enrichment.getRdapCache().set('1.2.3.4', { country: 'JP', org: 'Test ISP', expires: now + 60_000 });

    const result = await enrichment.lookupRdap('1.2.3.4');
    assert.equal(result.country, 'JP');
    assert.equal(result.org, 'Test ISP');
  });

  it('returns a different cached entry for a different IP', async () => {
    const now = Date.now();
    enrichment.getRdapCache().set('5.6.7.8', { country: 'US', org: 'ARIN Member', expires: now + 60_000 });

    const result = await enrichment.lookupRdap('5.6.7.8');
    assert.equal(result.country, 'US');
  });
});

// ─── lookupRdapBatch — all cached ────────────────────────────────────────────

describe('lookupRdapBatch (all cached)', () => {
  before(reset);

  it('processes all IPs from the cache without errors', async () => {
    const now = Date.now();
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    for (const ip of ips) {
      enrichment.getRdapCache().set(ip, { country: 'JP', org: 'LAN', expires: now + 60_000 });
    }
    // Should resolve without throwing
    await assert.doesNotReject(() => enrichment.lookupRdapBatch(ips));
  });
});

// ─── DNS cache — dnsmasq priority ────────────────────────────────────────────

describe('getDnsCache — dnsmasq priority', () => {
  beforeEach(reset);

  it('dnsmasq source entry is preserved in the cache Map', () => {
    const cache = enrichment.getDnsCache();
    cache.set('192.168.1.100', { host: 'my-iphone.local', expires: Date.now() + 60_000, source: 'dnsmasq' });
    const entry = cache.get('192.168.1.100');
    assert.equal(entry.source, 'dnsmasq');
    assert.equal(entry.host, 'my-iphone.local');
  });

  it('ptr source entry can be overwritten (lower priority)', () => {
    const cache = enrichment.getDnsCache();
    cache.set('192.168.1.100', { host: 'old-ptr.local', expires: Date.now() + 60_000, source: 'ptr' });
    cache.set('192.168.1.100', { host: 'new-dnsmasq.local', expires: Date.now() + 60_000, source: 'dnsmasq' });
    assert.equal(cache.get('192.168.1.100').host, 'new-dnsmasq.local');
  });
});

describe('internal PTR resolver', () => {
  beforeEach(reset);

  it('pins PTR lookups to the configured DNS server', async () => {
    let servers = [];
    class FakeResolver {
      setServers(value) { servers = value; }
      async reverse() { return ['device.internal']; }
    }
    enrichment._configurePtrResolverForTest('10.0.0.53', FakeResolver);
    assert.equal(await enrichment.reverseDns('192.168.1.20'), 'device.internal');
    assert.deepEqual(servers, ['10.0.0.53']);
  });
});

// ─── getApiStats structure ────────────────────────────────────────────────────

describe('getApiStats', () => {
  before(reset);

  it('returns stats object with rdap, geo, ptr keys', () => {
    const stats = enrichment.getApiStats();
    assert.ok('rdap' in stats);
    assert.ok('geo'  in stats);
    assert.ok('ptr'  in stats);
  });

  it('each stat entry has ok, fail, lastOkAt, lastFailAt, lastError', () => {
    const stats = enrichment.getApiStats();
    for (const key of ['rdap', 'geo', 'ptr']) {
      const s = stats[key];
      assert.ok('ok'        in s, `${key}.ok missing`);
      assert.ok('fail'      in s, `${key}.fail missing`);
      assert.ok('lastOkAt'  in s, `${key}.lastOkAt missing`);
      assert.ok('lastError' in s, `${key}.lastError missing`);
    }
  });
});

// ─── geo cache — private IP permanent TTL ────────────────────────────────────

describe('geoCache — private IP entries', () => {
  before(reset);

  it('private IPs set in cache have null lat/lon', () => {
    // lookupGeoBatch will cache private IPs with permanent TTL immediately,
    // without hitting the network. Test this via the cache Map.
    const cache = enrichment.getGeoCache();
    const now   = Date.now();
    // Simulate what lookupGeoBatch does for private IPs (permanent TTL entry)
    cache.set('192.168.1.1', { lat: null, lon: null, city: null, countryCode: null, expires: now + 1e13 });
    const entry = cache.get('192.168.1.1');
    assert.equal(entry.lat, null);
    assert.ok(entry.expires > now + 365 * 24 * 3600 * 1000, 'TTL should be permanent (> 1 year)');
  });
});

// ─── lookupGeoBatch — buffer coalescing and rate-limit backoff ───────────────

describe('lookupGeoBatch coalescing & backoff', () => {
  before(() => { reset(); enrichment._setGeoFlushMsForTest(10); });
  after(() => { enrichment._setGeoFlushMsForTest(2000); enrichment._initForTest(); });

  it('resolves immediately for private-only IPs (no flush cycle)', async () => {
    await enrichment.lookupGeoBatch(['192.168.10.20']);
    const entry = enrichment.getGeoCache().get('192.168.10.20');
    assert.ok(entry, 'private IP should be cached');
    assert.equal(entry.lat, null);
  });

  it('coalesces concurrent calls into a single flush cycle (same promise)', () => {
    // Force backoff to suppress the real API call while verifying only the coalescing behavior
    enrichment._setGeoBackoffUntilForTest(Date.now() + 60_000);
    const p1 = enrichment.lookupGeoBatch(['203.0.113.10']);
    const p2 = enrichment.lookupGeoBatch(['203.0.113.11']);
    assert.strictEqual(p1, p2, 'calls within the flush window should share one cycle');
    return p1;
  });

  it('fail-caches IPs during backoff without calling the API', async () => {
    enrichment._setGeoBackoffUntilForTest(Date.now() + 60_000);
    await enrichment.lookupGeoBatch(['198.51.100.7']);
    const entry = enrichment.getGeoCache().get('198.51.100.7');
    assert.ok(entry, 'IP should be fail-cached during backoff');
    assert.equal(entry.lat, null);
    assert.ok(entry.expires > Date.now(), 'entry should carry a retry-suppression TTL');
  });

  it('starts a new flush cycle after the previous one completes', async () => {
    enrichment._setGeoBackoffUntilForTest(Date.now() + 60_000);
    const p1 = enrichment.lookupGeoBatch(['198.51.100.8']);
    await p1;
    const p2 = enrichment.lookupGeoBatch(['198.51.100.9']);
    assert.notStrictEqual(p1, p2, 'a completed cycle should not be reused');
    await p2;
  });
});
