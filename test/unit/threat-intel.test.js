// Unit tests for threat intelligence module
// Run: node --test test/unit/threat-intel.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFeodoTracker,
  parseThreatFox,
  parseUrlhaus,
  parseSpamhausDrop,
  matchThreatIntel,
  fetchThreatIntel,
  ipToNum,
  _applyFeedResults,
  _isFetching,
  _resetForTest,
} = require('../../src/threat-intel');

describe('parseFeodoTracker', () => {
  const sample = `# Feodo Tracker Blocklist
# First seen,DstIP,DstPort,Last Online,C2 Status
2024-01-15 10:00:00,185.215.113.43,447,2024-01-15,online
2024-01-14 08:00:00,91.215.85.142,443,2024-01-14,online
# comment line
invalid line
2024-01-13 12:00:00,45.155.205.233,8080,2024-01-13,offline`;

  it('parses valid entries', () => {
    const entries = parseFeodoTracker(sample);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].ip, '185.215.113.43');
    assert.equal(entries[0].port, 447);
    assert.equal(entries[0].source, 'feodo');
  });

  it('skips comments and invalid lines', () => {
    const entries = parseFeodoTracker('# comment\ninvalid\n');
    assert.equal(entries.length, 0);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseFeodoTracker(''), []);
  });
});

describe('parseThreatFox', () => {
  const sample = `"first_seen_utc","ioc_id","ioc_value","ioc_type","threat_type","fk_malware","malware_alias","malware_malpedia","confidence_level","reference","reporter","tags"
"2024-01-15 10:00:00","12345","103.140.207.95:9443","ip:port","botnet_cc","win.cobalt_strike","CobaltStrike","","90","","reporter1",""
# comment
"2024-01-14 08:00:00","12346","192.168.1.1:bad","ip:port","botnet_cc","win.test","Test","","80","","reporter2",""`;

  it('parses valid IP:port entries', () => {
    const entries = parseThreatFox(sample);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].ip, '103.140.207.95');
    assert.equal(entries[0].port, 9443);
    assert.equal(entries[0].source, 'threatfox');
    assert(entries[0].tag.includes('CobaltStrike'));
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(parseThreatFox(''), []);
  });
});

describe('parseUrlhaus', () => {
  const sample = `# URLhaus CSV
"id","dateadded","url","url_status","last_online","threat","tags","urlhaus_link","reporter"
"12345","2024-01-15","http://185.215.113.43/malware.exe","online","2024-01-15","malware_download","","","reporter1"
"12346","2024-01-15","https://evil-domain.xyz/payload","online","2024-01-15","malware_download","","","reporter2"`;

  it('parses IP-based URLs', () => {
    const entries = parseUrlhaus(sample);
    const ipEntry = entries.find(e => e.type === 'ip');
    assert(ipEntry);
    assert.equal(ipEntry.value, '185.215.113.43');
    assert.equal(ipEntry.source, 'urlhaus');
  });

  it('parses domain-based URLs', () => {
    const entries = parseUrlhaus(sample);
    const domainEntry = entries.find(e => e.type === 'domain');
    assert(domainEntry);
    assert.equal(domainEntry.value, 'evil-domain.xyz');
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(parseUrlhaus(''), []);
  });
});

describe('parseSpamhausDrop', () => {
  const sample = `; Spamhaus DROP List
; Last-Modified: Mon, 15 Jan 2024
1.10.16.0/20 ; SB001
5.188.10.0/23 ; SB002
223.0.0.0/8 ; SB003`;

  it('parses CIDR entries', () => {
    const entries = parseSpamhausDrop(sample);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].prefix, 20);
    assert.equal(entries[0].source, 'spamhaus');
  });

  it('skips comment lines', () => {
    const entries = parseSpamhausDrop('; just comments\n; more comments\n');
    assert.equal(entries.length, 0);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(parseSpamhausDrop(''), []);
  });
});

describe('ipToNum', () => {
  it('converts 0.0.0.0', () => {
    assert.equal(ipToNum('0.0.0.0'), 0);
  });

  it('converts 255.255.255.255', () => {
    assert.equal(ipToNum('255.255.255.255'), 0xFFFFFFFF);
  });

  it('converts 192.168.1.1', () => {
    assert.equal(ipToNum('192.168.1.1'), (192 << 24 | 168 << 16 | 1 << 8 | 1) >>> 0);
  });
});

describe('matchThreatIntel (integration with parsed data)', () => {
  // Manually load test data into the module
  // We use fetchThreatIntel indirectly by calling parse functions and checking match

  it('returns null for safe IPs', () => {
    const result = matchThreatIntel('8.8.8.8', 'dns.google');
    assert.equal(result, null);
  });

  it('returns null for private IPs', () => {
    const result = matchThreatIntel('192.168.1.1', null);
    assert.equal(result, null);
  });
});

// ─── _applyFeedResults: URLhaus failure preserves existing domains ────────────

describe('_applyFeedResults: URLhaus fetch failure keeps previous domain data', () => {
  // Use fulfilled URLhaus CSV to pre-populate, then simulate a URLhaus failure
  // and verify the existing low-confidence domains survive.

  const urlhausCsv = [
    '# URLhaus CSV',
    '"id","dateadded","url","url_status","last_online","threat","tags","urlhaus_link","reporter"',
    '"1","2024-01-15","https://raw.githubusercontent.com/evil/payload.exe","online","2024-01-15","malware_download","","",""',
  ].join('\n');

  const ok   = (data) => ({ status: 'fulfilled', value: { data } });
  const fail = (msg)  => ({ status: 'rejected',  reason: new Error(msg) });
  const empty = ok('');

  it('pre-populates low-confidence domain via URLhaus', () => {
    _resetForTest();
    _applyFeedResults([empty, empty, ok(urlhausCsv), empty]);

    const hit = matchThreatIntel('185.199.108.133', 'raw.githubusercontent.com');
    assert.ok(hit, 'should match low-confidence domain');
    assert.equal(hit.confidence, 'low');
    assert.equal(hit.source, 'urlhaus');
  });

  it('URLhaus fetch failure leaves existing domain data intact', () => {
    _resetForTest();
    // First successful fetch: populate URLhaus domain
    _applyFeedResults([empty, empty, ok(urlhausCsv), empty]);
    const statsBefore = { domains: matchThreatIntel('185.199.108.133', 'raw.githubusercontent.com') };
    assert.ok(statsBefore.domains, 'pre-condition: domain match exists');

    // Second fetch: URLhaus fails — existing data must survive
    _applyFeedResults([empty, empty, fail('connect ETIMEDOUT'), empty]);

    const hit = matchThreatIntel('185.199.108.133', 'raw.githubusercontent.com');
    assert.ok(hit, 'domain match should still exist after URLhaus failure');
    assert.equal(hit.confidence, 'low');
  });

  it('URLhaus fetch failure does not affect non-URLhaus IP data', () => {
    _resetForTest();
    const feodoCsv = '# Feodo\n2024-01-15,203.0.113.99,443,2024-01-15,online\n';
    // Load Feodo + URLhaus
    _applyFeedResults([ok(feodoCsv), empty, ok(urlhausCsv), empty]);
    assert.ok(matchThreatIntel('203.0.113.99', null), 'Feodo IP should match');

    // URLhaus fails on next cycle — Feodo data must survive too
    _applyFeedResults([ok(feodoCsv), empty, fail('timeout'), empty]);
    assert.ok(matchThreatIntel('203.0.113.99', null), 'Feodo IP should still match');
  });
});

// ─── fetchThreatIntel: fetching flag reset on unexpected error ────────────────
// The try/finally guard in fetchThreatIntel ensures fetching=false even on
// unexpected parse exceptions. We verify this by testing that _applyFeedResults
// itself does not corrupt state on bad input, and that the fetching flag starts
// and ends at false when the module is idle.

describe('fetchThreatIntel: fetching flag and state isolation', () => {
  it('_isFetching() is false when not running', () => {
    _resetForTest();
    assert.equal(_isFetching(), false);
  });

  it('_applyFeedResults with all-failed results leaves live data unchanged', () => {
    _resetForTest();
    // Seed some known-good URLhaus data
    const urlhausCsv = [
      '"id","dateadded","url","url_status","last_online","threat","tags","urlhaus_link","reporter"',
      '"1","2024-01-15","https://raw.githubusercontent.com/evil/x.exe","online","","","","",""',
    ].join('\n');
    _applyFeedResults([
      { status: 'fulfilled', value: { data: '' } },
      { status: 'fulfilled', value: { data: '' } },
      { status: 'fulfilled', value: { data: urlhausCsv } },
      { status: 'fulfilled', value: { data: '' } },
    ]);
    assert.ok(matchThreatIntel('1.2.3.4', 'raw.githubusercontent.com'), 'pre-condition');

    // All four feeds fail — live data must be untouched
    const allFail = [
      { status: 'rejected', reason: new Error('timeout') },
      { status: 'rejected', reason: new Error('timeout') },
      { status: 'rejected', reason: new Error('timeout') },
      { status: 'rejected', reason: new Error('timeout') },
    ];
    _applyFeedResults(allFail);
    assert.ok(matchThreatIntel('1.2.3.4', 'raw.githubusercontent.com'),
      'domain match must survive all-failure cycle');
  });
});
