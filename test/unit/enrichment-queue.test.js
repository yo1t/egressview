'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../../src/enrichment-queue');

beforeEach(() => queue._resetForTest());

describe('refreshCachedEnrichmentForDestinations', () => {
  it('updates changed entries and emits a delta update', () => {
    const historyMap = new Map([
      ['a', { src: '1.1.1.1', dst: '8.8.8.8', dstHost: '8.8.8.8', country: null, org: null, lat: null, lon: null, city: null }],
    ]);
    const appended = [];
    const emitted = [];

    queue.init({
      history: {
        getConnectionHistory: () => historyMap,
        appendHistoryLog: (entry) => appended.push({ ...entry }),
      },
      enrichment: {
        getDnsCache: () => new Map([['8.8.8.8', { host: 'dns.google', expires: Date.now() + 1000, source: 'dnsmasq' }]]),
        getRdapCache: () => new Map([['8.8.8.8', { country: 'US', org: 'Google' }]]),
        getGeoCache: () => new Map([['8.8.8.8', { lat: 1, lon: 2, city: 'Mountain View', countryCode: 'US' }]]),
        isPtrJunk: () => false,
      },
      io: { emit: (...args) => emitted.push(args) },
      logger: { error: () => {} },
    });

    queue.refreshCachedEnrichmentForDestinations(['8.8.8.8']);

    assert.equal(historyMap.get('a').dstHost, 'dns.google');
    assert.equal(historyMap.get('a').org, 'Google');
    assert.equal(appended.length, 1);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0][0], 'connections-update');
    assert.equal(emitted[0][1].partial, true);
  });

  it('does not emit when no fields change', () => {
    const historyMap = new Map([
      ['a', { src: '1.1.1.1', dst: '8.8.8.8', dstHost: 'dns.google', country: 'US', org: 'Google', lat: 1, lon: 2, city: 'Mountain View' }],
    ]);
    const emitted = [];

    queue.init({
      history: {
        getConnectionHistory: () => historyMap,
        appendHistoryLog: () => { throw new Error('should not append'); },
      },
      enrichment: {
        getDnsCache: () => new Map([['8.8.8.8', { host: 'dns.google', expires: Date.now() + 1000, source: 'dnsmasq' }]]),
        getRdapCache: () => new Map([['8.8.8.8', { country: 'US', org: 'Google' }]]),
        getGeoCache: () => new Map([['8.8.8.8', { lat: 1, lon: 2, city: 'Mountain View', countryCode: 'US' }]]),
        isPtrJunk: () => false,
      },
      io: { emit: (...args) => emitted.push(args) },
      logger: { error: () => {} },
    });

    queue.refreshCachedEnrichmentForDestinations(['8.8.8.8']);
    assert.equal(emitted.length, 0);
  });
});

describe('queueConnectionEnrichment', () => {
  it('batches unique IPs and refreshes caches once', async () => {
    const historyMap = new Map([
      ['a', { src: '1.1.1.1', dst: '8.8.8.8', dstHost: '8.8.8.8' }],
    ]);
    const calls = { reverseDns: [], rdap: [], geo: [] };

    queue.init({
      history: {
        getConnectionHistory: () => historyMap,
        appendHistoryLog: () => {},
      },
      enrichment: {
        reverseDns: async (ip) => { calls.reverseDns.push(ip); },
        lookupRdapBatch: async (ips) => { calls.rdap.push([...ips]); },
        lookupGeoBatch: async (ips) => { calls.geo.push([...ips]); },
        getDnsCache: () => new Map(),
        getRdapCache: () => new Map(),
        getGeoCache: () => new Map(),
        isPtrJunk: () => false,
      },
      io: { emit: () => {} },
      logger: { error: () => {} },
    });

    queue.queueConnectionEnrichment(['8.8.8.8', '8.8.8.8', '1.1.1.1']);
    await queue._waitForIdleForTest();

    assert.deepEqual(calls.reverseDns.sort(), ['1.1.1.1', '8.8.8.8']);
    assert.equal(calls.rdap.length, 1);
    assert.deepEqual(calls.rdap[0].sort(), ['1.1.1.1', '8.8.8.8']);
    assert.equal(calls.geo.length, 1);
  });

  it('logs and recovers from background errors', async () => {
    const errors = [];

    queue.init({
      history: {
        getConnectionHistory: () => new Map(),
        appendHistoryLog: () => {},
      },
      enrichment: {
        reverseDns: async () => {},
        lookupRdapBatch: async () => { throw new Error('boom'); },
        lookupGeoBatch: async () => {},
        getDnsCache: () => new Map(),
        getRdapCache: () => new Map(),
        getGeoCache: () => new Map(),
        isPtrJunk: () => false,
      },
      io: { emit: () => {} },
      logger: { error: (...args) => errors.push(args.join(' ')) },
    });

    queue.queueConnectionEnrichment(['8.8.8.8']);
    await queue._waitForIdleForTest();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /background queue error/);
  });

  it('refreshes stale startup entries without issuing PTR lookups', async () => {
    const calls = { reverseDns: [], rdap: [], geo: [] };

    queue.init({
      history: {
        getConnectionHistory: () => new Map(),
        appendHistoryLog: () => {},
      },
      enrichment: {
        reverseDns: async (ip) => { calls.reverseDns.push(ip); },
        lookupRdapBatch: async (ips, concurrency) => { calls.rdap.push({ ips: [...ips], concurrency }); },
        lookupGeoBatch: async (ips) => { calls.geo.push([...ips]); },
        getDnsCache: () => new Map(),
        getRdapCache: () => new Map(),
        getGeoCache: () => new Map(),
        isPtrJunk: () => false,
      },
      io: { emit: () => {} },
      logger: { error: () => {} },
      backgroundDelayMs: 0,
    });

    queue.queueStaleConnectionEnrichment(['8.8.8.8', '1.1.1.1']);
    await queue._waitForIdleForTest();

    assert.deepEqual(calls.reverseDns, []);
    assert.deepEqual(calls.rdap, [{ ips: ['8.8.8.8', '1.1.1.1'], concurrency: 2 }]);
    assert.deepEqual(calls.geo, [['8.8.8.8', '1.1.1.1']]);
  });

  it('promotes live traffic ahead of remaining stale startup work', async () => {
    const rdapBatches = [];
    let releaseDelay;
    let delayStarted;
    const delayStartedPromise = new Promise(resolve => { delayStarted = resolve; });

    queue.init({
      history: {
        getConnectionHistory: () => new Map(),
        appendHistoryLog: () => {},
      },
      enrichment: {
        reverseDns: async () => {},
        lookupRdapBatch: async (ips, concurrency) => { rdapBatches.push({ ips: [...ips], concurrency }); },
        lookupGeoBatch: async () => {},
        getDnsCache: () => new Map(),
        getRdapCache: () => new Map(),
        getGeoCache: () => new Map(),
        isPtrJunk: () => false,
      },
      io: { emit: () => {} },
      logger: { error: () => {} },
      delay: () => {
        delayStarted();
        return new Promise(resolve => { releaseDelay = resolve; });
      },
    });

    const staleIps = Array.from({ length: 26 }, (_, index) => `203.0.113.${index + 1}`);
    queue.queueStaleConnectionEnrichment(staleIps);
    await delayStartedPromise;
    queue.queueConnectionEnrichment(['8.8.8.8']);
    releaseDelay();
    await queue._waitForIdleForTest();

    assert.equal(rdapBatches.length, 3);
    assert.equal(rdapBatches[0].ips.length, 25);
    assert.deepEqual(rdapBatches[1], { ips: ['8.8.8.8'], concurrency: undefined });
    assert.deepEqual(rdapBatches[2], { ips: ['203.0.113.26'], concurrency: 2 });
  });
});
