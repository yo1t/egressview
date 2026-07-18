'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createManualThreatLookup,
  isPublicIpAddress,
} = require('../../src/manual-threat-lookup');

function responseFor(url) {
  if (url.includes('abuseipdb')) return { data: { data: { abuseConfidenceScore: 42, totalReports: 7, countryCode: 'US' } } };
  if (url.includes('virustotal')) return { data: { data: { attributes: { reputation: -3, last_analysis_stats: { malicious: 2, suspicious: 1 } } } } };
  return { data: { pulse_info: { count: 1, pulses: [{ id: 'p1', name: 'Test pulse' }] }, reputation: 1 } };
}

describe('manual threat lookup', () => {
  it('accepts public addresses and rejects local or documentation ranges', () => {
    assert.equal(isPublicIpAddress('8.8.8.8'), true);
    assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
    for (const ip of ['192.168.1.1', '127.0.0.1', '100.64.0.1', '198.51.100.1', '203.0.113.1', '::1', '2001:db8::1']) {
      assert.equal(isPublicIpAddress(ip), false, ip);
    }
  });

  it('queries only explicitly requested providers and returns normalized summaries', async () => {
    const calls = [];
    const service = createManualThreatLookup({
      http: { get: async (url, options) => { calls.push({ url, options }); return responseFor(url); } },
      now: () => 100_000,
    });
    service.configure({ keys: { abuseipdb: 'abuse-secret', virustotal: 'vt-secret', otx: 'otx-secret' } });
    const result = await service.lookup('8.8.8.8', ['abuseipdb', 'virustotal']);
    assert.equal(calls.length, 2);
    assert.equal(result.results.abuseipdb.summary.abuseConfidenceScore, 42);
    assert.equal(result.results.virustotal.summary.malicious, 2);
    assert.equal(result.results.otx, undefined);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });

  it('uses the cache before provider cooldown and never calls an unconfigured provider', async () => {
    let calls = 0;
    let time = 100_000;
    const service = createManualThreatLookup({
      http: { get: async url => { calls++; return responseFor(url); } },
      now: () => time,
    });
    service.configure({ keys: { abuseipdb: 'key' }, cacheTtlMinutes: 60, minIntervalSeconds: 30 });
    const first = await service.lookup('8.8.8.8', ['abuseipdb', 'otx']);
    time += 1_000;
    const second = await service.lookup('8.8.8.8', ['abuseipdb']);
    assert.equal(calls, 1);
    assert.equal(first.results.otx.ok, false);
    assert.equal(second.results.abuseipdb.cached, true);
  });

  it('applies provider cooldown to a different IP and sanitizes upstream errors', async () => {
    let time = 100_000;
    const service = createManualThreatLookup({
      http: { get: async url => responseFor(url) },
      now: () => time,
    });
    service.configure({ keys: { abuseipdb: 'key' }, minIntervalSeconds: 30 });
    await service.lookup('8.8.8.8', ['abuseipdb']);
    time += 1_000;
    const limited = await service.lookup('1.1.1.1', ['abuseipdb']);
    assert.match(limited.results.abuseipdb.error, /cooldown/i);

    const failed = createManualThreatLookup({
      http: { get: async () => { throw Object.assign(new Error('secret response'), { response: { status: 401, data: 'private' } }); } },
    });
    failed.configure({ keys: { otx: 'key' } });
    const result = await failed.lookup('8.8.4.4', ['otx']);
    assert.equal(result.results.otx.error, 'API key was rejected');
    assert.equal(JSON.stringify(result).includes('secret response'), false);
  });

  it('never exposes configured API keys', () => {
    const service = createManualThreatLookup();
    service.configure({ keys: { abuseipdb: 'secret' } });
    assert.deepEqual(service.getPublicConfig().providers.abuseipdb, { keySet: true });
    assert.equal(JSON.stringify(service.getPublicConfig()).includes('secret'), false);
  });
});
