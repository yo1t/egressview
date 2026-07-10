'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../../src/beacon-scan-runner');

const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

beforeEach(() => runner._resetForTest());

describe('runBeaconScan', () => {
  it('filters allowlisted orgs unless threat intel hits', () => {
    const upserts = [];
    const prunes = [];
    const logs = [];

    runner.init({
      appState: {
        beaconConfig: {
          enabled: true,
          minObs: 4,
          maxCov: 0.5,
          minIntervalMs: 60_000,
          maxIntervalMs: 4 * 3600_000,
          whitelistDomains: [],
          orgAllowlist: ['Amazon'],
          scanIntervalMs: 10,
        },
      },
      beacons: {
        getEvents: () => [{}, {}],
        upsertBeacon: (c) => upserts.push(c),
        pruneCandidatesNotIn: (keys) => { prunes.push(keys); return 1; },
        pruneEvents: () => 2,
      },
      beaconDetector: {
        detectBeacons: () => [
          { src: 'a', dst: '1.1.1.1', dstHost: 'one', dport: 443, proto: 'TCP' },
          { src: 'b', dst: '2.2.2.2', dstHost: 'two', dport: 443, proto: 'TCP' },
        ],
      },
      threatIntel: {
        matchThreatIntel: (dst) => dst === '1.1.1.1' ? { source: 'x' } : null,
      },
      enrichment: {
        getRdapCache: () => new Map([
          ['1.1.1.1', { org: 'Amazon AWS' }],
          ['2.2.2.2', { org: 'Amazon Retail' }],
        ]),
      },
      logger: { info: (msg) => logs.push(msg) },
    });

    runner.runBeaconScan();

    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].dst, '1.1.1.1');
    assert.equal(prunes.length, 1);
    assert.deepEqual(prunes[0], ['a|1.1.1.1|443|TCP']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /1 candidate\(s\) from 2 events/);
  });

  it('returns early when beacon scanning is disabled', () => {
    let called = false;
    runner.init({
      appState: { beaconConfig: { enabled: false } },
      beacons: { getEvents: () => { called = true; return []; } },
      beaconDetector: { detectBeacons: () => [] },
      threatIntel: { matchThreatIntel: () => null },
      enrichment: { getRdapCache: () => new Map() },
      logger: { info: () => {} },
    });

    runner.runBeaconScan();
    assert.equal(called, false);
  });
});

describe('scheduleBeaconScan', () => {
  it('restarts the timer using the configured interval', async () => {
    let runs = 0;
    runner.init({
      appState: {
        beaconConfig: {
          enabled: true,
          minObs: 1,
          maxCov: 1,
          minIntervalMs: 1,
          maxIntervalMs: 2,
          whitelistDomains: [],
          orgAllowlist: [],
          scanIntervalMs: 5,
        },
      },
      beacons: {
        getEvents: () => [],
        upsertBeacon: () => {},
        pruneCandidatesNotIn: () => 0,
        pruneEvents: () => 0,
      },
      beaconDetector: { detectBeacons: () => { runs++; return []; } },
      threatIntel: { matchThreatIntel: () => null },
      enrichment: { getRdapCache: () => new Map() },
      logger: { info: () => {} },
    });

    runner.scheduleBeaconScan();
    await tick(14);
    runner.stopBeaconScan();

    assert.ok(runs >= 2);
  });
});
