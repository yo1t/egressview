'use strict';

// The feeds are parsed on a worker thread so the hourly refresh does not stop
// the Hub (P3-184: 643 ms on the main thread, measured 2026-10-10).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const threatIntel = require('../../src/threat-intel');

const FEODO = '# header\n2026-01-01 00:00:00,198.51.100.9,443,2026-01-02,online,Dridex\n';
const URLHAUS = '# header\n"1","2026-01-01 00:00:00","https://bad.example/x.bin","online","2026-01-02","malware_download","exe","https://urlhaus.abuse.ch/url/1/","reporter"\n';
const SPAMHAUS = '; header\n203.0.113.0/24 ; SBL1\n';
const ok = data => ({ status: 'fulfilled', value: { data } });
const failed = message => ({ status: 'rejected', reason: new Error(message) });

describe('脅威フィードの解析を別スレッドで行う (P3-184)', () => {
  it('別スレッドの解析結果は、このスレッドで解析したものと同じ', async () => {
    const results = [ok(FEODO), ok(''), ok(URLHAUS), ok(SPAMHAUS)];
    const parsed = await threatIntel._parseFeedsOffThread(results);
    assert.deepEqual(parsed.feodo, threatIntel.parseFeodoTracker(FEODO));
    assert.deepEqual(parsed.urlhaus, threatIntel.parseUrlhaus(URLHAUS));
    assert.deepEqual(parsed.spamhaus, threatIntel.parseSpamhausDrop(SPAMHAUS));
    assert.deepEqual(parsed.threatfox, []);
  });

  it('取れなかったフィードは解析に渡さない', async () => {
    const parsed = await threatIntel._parseFeedsOffThread([failed('503'), ok(''), failed('timeout'), ok(SPAMHAUS)]);
    assert.equal(parsed.feodo, undefined);
    assert.equal(parsed.urlhaus, undefined);
    assert.ok(Array.isArray(parsed.spamhaus));
  });

  it('解析済みの結果を渡すと、適用はそれを使う', () => {
    threatIntel._resetForTest();
    const results = [ok(FEODO), ok(''), ok(''), ok('')];
    threatIntel._applyFeedResults(results, {
      deferCache: true,
      parsed: { feodo: [{ ip: '192.0.2.77', port: 443, source: 'feodo', tag: 'test' }] },
    });
    assert.equal(threatIntel.matchThreatIntel('192.0.2.77', null)?.source, 'feodo');
    assert.equal(threatIntel.matchThreatIntel('198.51.100.9', null), null, 'the text was not parsed again');
    threatIntel._resetForTest();
  });

  it('定期取得は別スレッドの解析を使う', () => {
    const source = require('node:fs').readFileSync(require.resolve('../../src/threat-intel'), 'utf8');
    const fetch = source.slice(source.indexOf('async function fetchThreatIntel()'));
    assert.match(fetch, /await parseFeedsOffThread\(results\)/);
    assert.match(fetch, /_applyFeedResults\(results, \{ deferCache: true, parsed \}\)/);
  });
});
