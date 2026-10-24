// Unit tests for threat intelligence module
// Run: node --test test/unit/threat-intel.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCsvLine,
  parseFeodoTracker,
  parseThreatFox,
  parseUrlhaus,
  parseSpamhausDrop,
  matchThreatIntel,
  ipToNum,
  _applyFeedResults,
  _isFetching,
  _resetForTest,
} = require('../../src/threat-intel');

describe('parseCsvLine', () => {
  it('keeps commas inside quoted fields', () => {
    const fields = parseCsvLine('"a,b",c,"d,e,f"');
    assert.deepEqual(fields, ['a,b', 'c', 'd,e,f']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    const fields = parseCsvLine('"say ""hello""",world');
    assert.deepEqual(fields, ['say "hello"', 'world']);
  });
});

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

  it('parses malware names containing commas', () => {
    const csv = [
      '"first_seen_utc","ioc_id","ioc_value","ioc_type","threat_type","fk_malware","malware_alias","malware_malpedia","confidence_level","reference","reporter","tags"',
      '"2024-01-15 10:00:00","12345","103.140.207.95:9443","ip:port","botnet_cc","win.cobalt_strike","CobaltStrike, Variant A","","90","","reporter1",""',
    ].join('\n');
    const entries = parseThreatFox(csv);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tag, 'ThreatFox: CobaltStrike, Variant A');
  });
});

describe('parseThreatFox: keyed recent.csv (2026-10-22 onward)', () => {
  // The keyed export mixes IOC types and separates fields with ", ".
  const csv = [
    '# ThreatFox IOCs: recent additions - CSV format',
    '# "first_seen_utc","ioc_id","ioc_value","ioc_type","threat_type","fk_malware","malware_alias","malware_printable","last_seen_utc","confidence_level","is_compromised","reference","tags","anonymous","reporter"',
    '"2026-10-24 01:59:02", "1982523", "b0iyqov228.workers.dev", "domain", "payload_delivery", "php.shin_webshell", "None", "php.shin_webshell", "", "50", "True", "None", "None", "0", "r1"',
    '"2026-10-24 01:58:00", "1982524", "203.0.113.7:4444", "ip:port", "botnet_cc", "win.asyncrat", "None", "AsyncRAT", "", "75", "False", "None", "None", "0", "r2"',
    '"2026-10-24 01:57:00", "1982525", "http://198.51.100.9:8080/x", "url", "payload_delivery", "elf.mirai", "None", "Mirai", "", "75", "False", "None", "None", "0", "r3"',
  ].join('\n');

  it('マルウェア名は別名が無ければ表示名を使う', () => {
    const entries = parseThreatFox(csv);
    assert.deepEqual(entries.find(e => e.port === 4444),
      { ip: '203.0.113.7', port: 4444, source: 'threatfox', tag: 'ThreatFox: AsyncRAT' });
  });

  it('domainとurlも取り、改ざんされた正規サイトや確信度75未満は低信頼度にする', () => {
    const entries = parseThreatFox(csv);
    assert.deepEqual(entries.find(e => e.domain === 'b0iyqov228.workers.dev'), {
      domain: 'b0iyqov228.workers.dev', source: 'threatfox',
      tag: 'ThreatFox: php.shin_webshell (改ざんされた正規サイト)', confidence: 'low',
    });
    // A url whose host is an IPv4 address is matched as that address.
    assert.deepEqual(entries.find(e => e.ip === '198.51.100.9'), {
      ip: '198.51.100.9', port: null, source: 'threatfox', tag: 'ThreatFox: Mirai',
      confidence: 'high', url: 'http://198.51.100.9:8080/x',
    });
  });

  it('ハッシュは照合に使えないので取らない', () => {
    const withHash = `${csv}\n"2026-10-24 01:56:00", "1982526", "d41d8cd98f00b204e9800998ecf8427e", "md5_hash", "payload", "win.x", "None", "X", "", "100", "False", "None", "None", "0", "r4"`;
    assert.equal(parseThreatFox(withHash).length, 3);
  });

  it('URLのホスト名で照合し、共有サービス上のものは低信頼度', () => {
    const rows = [
      csv.split('\n')[1],
      '"2026-10-24 01:50:00", "2", "https://Evil-Payload.example.net/a/b.exe", "url", "payload_delivery", "win.x", "None", "LummaStealer", "", "100", "False", "None", "None", "0", "r"',
      '"2026-10-24 01:50:00", "3", "https://raw.githubusercontent.com/u/r/main/x.ps1", "url", "payload_delivery", "win.x", "None", "X", "", "100", "False", "None", "None", "0", "r"',
      '"2026-10-24 01:50:00", "4", "c2.example.org", "domain", "botnet_cc", "win.x", "None", "Remcos", "", "50", "False", "None", "None", "0", "r"',
    ].join('\n');
    const entries = parseThreatFox(rows);
    const byHost = Object.fromEntries(entries.map(e => [e.domain, e]));
    assert.equal(byHost['evil-payload.example.net'].confidence, 'high');
    assert.equal(byHost['evil-payload.example.net'].url, 'https://Evil-Payload.example.net/a/b.exe');
    assert.equal(byHost['raw.githubusercontent.com'].confidence, 'low');
    assert.match(byHost['raw.githubusercontent.com'].tag, /正規サービス上/);
    assert.equal(byHost['c2.example.org'].confidence, 'low', 'ThreatFox rated it 50');
  });
});

describe('ThreatFoxのドメインで照合する', () => {
  const header = '# "first_seen_utc","ioc_id","ioc_value","ioc_type","threat_type","fk_malware","malware_alias","malware_printable","last_seen_utc","confidence_level","is_compromised","reference","tags","anonymous","reporter"';
  const row = (value, type, level, compromised, malware = 'Remcos') =>
    `"2026-10-24 01:50:00", "1", "${value}", "${type}", "botnet_cc", "win.x", "None", "${malware}", "", "${level}", "${compromised}", "None", "None", "0", "r"`;
  const ok = (data) => ({ status: 'fulfilled', value: { data } });

  function freshModule() {
    delete require.cache[require.resolve('../../src/threat-intel')];
    return require('../../src/threat-intel');
  }

  it('ドメインとそのサブドメインに一致し、Agentにも確信度付きで渡る', () => {
    const intel = freshModule();
    intel._applyFeedResults([ok(''), ok([header, row('c2.example.org', 'domain', 100, 'False')].join('\n')), ok(''), ok('')]);
    assert.equal(intel.matchThreatIntel('203.0.113.50', 'c2.example.org')?.source, 'threatfox');
    assert.equal(intel.matchThreatIntel('203.0.113.50', 'a.c2.example.org')?.matchValue, 'c2.example.org');
    assert.deepEqual(intel.listIndicators().domains, [['c2.example.org', 'threatfox', 'ThreatFox: Remcos', 'high']]);
    assert.equal(intel.getStats().feeds.find(f => f.name === 'threatfox').entries, 1);
  });

  it('同じIPがip:portとurlにあれば、強いほうを残す', () => {
    const intel = freshModule();
    intel._applyFeedResults([ok(''), ok([
      header,
      row('203.0.113.9:443', 'ip:port', 100, 'False', 'CobaltStrike'),
      row('http://203.0.113.9/x', 'url', 50, 'False', 'Other'),
    ].join('\n')), ok(''), ok('')]);
    const hit = intel.matchThreatIntel('203.0.113.9', null);
    assert.equal(hit.tag, 'ThreatFox: CobaltStrike');
    assert.notEqual(hit.confidence, 'low');
  });

  it('次の取得で消えたドメインは照合から外れる', () => {
    const intel = freshModule();
    intel._applyFeedResults([ok(''), ok([header, row('old.example.org', 'domain', 100, 'False')].join('\n')), ok(''), ok('')]);
    intel._applyFeedResults([ok(''), ok([header, row('new.example.org', 'domain', 100, 'False')].join('\n')), ok(''), ok('')]);
    assert.equal(intel.matchThreatIntel('203.0.113.50', 'old.example.org'), null);
    assert.equal(intel.matchThreatIntel('203.0.113.50', 'new.example.org')?.source, 'threatfox');
  });

  it('ドメインもディスクに残り、再起動後に照合に使える', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-tf-')), 'h.sqlite');
    const first = freshModule();
    first.initDb(dbPath);
    first._applyFeedResults([ok(''), ok([header, row('kept.example.org', 'domain', 90, 'True')].join('\n')), ok(''), ok('')]);
    first.closeDb();
    const second = freshModule();
    second.initDb(dbPath);
    const hit = second.matchThreatIntel('203.0.113.50', 'kept.example.org');
    assert.equal(hit?.source, 'threatfox');
    assert.equal(hit?.confidence, 'low');
    second.closeDb();
  });
});

describe('abuseChExportUrl', () => {
  it('キーをパスに入れたabuse.chの鍵付きエクスポートを指す', () => {
    const { abuseChExportUrl } = require('../../src/threat-intel');
    assert.equal(abuseChExportUrl('urlhaus', 'k1'), 'https://urlhaus-api.abuse.ch/v2/files/exports/k1/recent.csv');
    assert.equal(abuseChExportUrl('threatfox', 'k1'), 'https://threatfox-api.abuse.ch/v2/files/exports/k1/recent.csv');
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

  it('parses URLs containing commas in the query string', () => {
    const csv = [
      '"id","dateadded","url","url_status","last_online","threat","tags","urlhaus_link","reporter"',
      '"12345","2024-01-15","https://evil.example/payload?x=1,2","online","2024-01-15","malware_download","","","reporter1"',
    ].join('\n');
    const entries = parseUrlhaus(csv);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, 'evil.example');
    assert.equal(entries[0].url, 'https://evil.example/payload?x=1,2');
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

  it('returns null for an IPv6 address', () => {
    assert.equal(ipToNum('2001:db8::1'), null);
  });

  it('returns null for ::1 (loopback IPv6)', () => {
    assert.equal(ipToNum('::1'), null);
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

// Every start of the production Hub re-saved and re-broadcast about 98,900
// connections (98,897 on 2026-09-22, 98,614 on 2026-09-23) whose threat
// verdict had not changed. Connections read back from the database carry no
// `threat` at all, and a match that finds nothing returns null; compared as
// JSON the two differ. The hourly re-match of the same cache finds 1 to 7.
describe('re-matching connections already in memory', () => {
  const { threatChanged, reMatchConnections } = require('../../src/threat-intel');

  // Shaped like a row hydrated from `connections`: there is no threat field.
  function loadedRow(dst) {
    return { src: '192.168.1.10', dst, dport: 443, proto: 'TCP', dstHost: null, lastSeen: 1 };
  }
  const hit = { source: 'feodo', tag: 'botnet_cc', matchType: 'ip', matchValue: '198.51.100.9' };
  const matchOnly = bad => dst => (dst === bad ? { ...hit } : null);

  it('treats "no verdict recorded" and "no match" as the same thing', () => {
    assert.equal(threatChanged(undefined, null), false);
    assert.equal(threatChanged(null, null), false);
    assert.equal(threatChanged(undefined, undefined), false);
  });

  it('still sees a threat appear, disappear or change', () => {
    assert.equal(threatChanged(undefined, hit), true);
    assert.equal(threatChanged(null, hit), true);
    assert.equal(threatChanged(hit, null), true);
    assert.equal(threatChanged(hit, { ...hit, tag: 'other' }), true);
    assert.equal(threatChanged(hit, { ...hit }), false);
  });

  it('reports nothing for clean connections just loaded from the database', async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => loadedRow(`203.0.113.${i % 250}`));
    const updated = await reMatchConnections(entries, { match: () => null });
    assert.equal(updated.length, 0, `${updated.length} unchanged connections would be re-saved and broadcast`);
  });

  it('reports only the connections whose verdict actually changed', async () => {
    const entries = [loadedRow('203.0.113.1'), loadedRow('198.51.100.9'), loadedRow('203.0.113.2')];
    const updated = await reMatchConnections(entries, { match: matchOnly('198.51.100.9') });
    assert.deepEqual(updated.map(entry => entry.dst), ['198.51.100.9']);
    assert.equal(updated[0].threat.tag, 'botnet_cc');
  });

  // The verdict is written back even when nothing changed, so the next pass
  // compares null with null rather than relying on the normalisation again.
  it('records the verdict on a loaded row without reporting it', async () => {
    const entry = loadedRow('203.0.113.5');
    assert.equal('threat' in entry, false);
    await reMatchConnections([entry], { match: () => null });
    assert.equal(entry.threat, null);
  });

  it('reports a threat that went away', async () => {
    const entry = { ...loadedRow('198.51.100.9'), threat: { ...hit } };
    const updated = await reMatchConnections([entry], { match: () => null });
    assert.equal(updated.length, 1);
    assert.equal(entry.threat, null);
  });

  it('gives the event loop a turn while it works through a large cache', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => loadedRow(`203.0.113.${i}`));
    let yielded = 0;
    const realSetImmediate = global.setImmediate;
    global.setImmediate = fn => { yielded += 1; return realSetImmediate(fn); };
    try {
      await reMatchConnections(entries, { match: () => null, chunk: 5 });
    } finally {
      global.setImmediate = realSetImmediate;
    }
    assert.equal(yielded, 2, 'did not yield every 5 entries');
  });
});
