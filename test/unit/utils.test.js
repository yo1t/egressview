// Unit tests for src/utils.js
// Run: node --test test/unit/utils.test.js

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedRouterIp, isAllowedLogPath, parseTimestamp, parsePositiveInt } = require('../../src/utils');

// ─── isAllowedRouterIp ────────────────────────────────────────────────────────

describe('isAllowedRouterIp', () => {
  it('accepts 10.x.x.x', () => assert.equal(isAllowedRouterIp('10.0.0.1'), true));
  it('accepts 172.16.x.x', () => assert.equal(isAllowedRouterIp('172.16.0.1'), true));
  it('accepts 172.31.x.x', () => assert.equal(isAllowedRouterIp('172.31.255.254'), true));
  it('accepts 192.168.x.x', () => assert.equal(isAllowedRouterIp('192.168.1.1'), true));

  it('rejects public IP', () => assert.equal(isAllowedRouterIp('8.8.8.8'), false));
  it('rejects 172.15.x.x (below /12)', () => assert.equal(isAllowedRouterIp('172.15.0.1'), false));
  it('rejects 172.32.x.x (above /12)', () => assert.equal(isAllowedRouterIp('172.32.0.1'), false));
  it('rejects 169.254.x.x (link-local)', () => assert.equal(isAllowedRouterIp('169.254.1.1'), false));
  it('rejects 127.0.0.1 (loopback)', () => assert.equal(isAllowedRouterIp('127.0.0.1'), false));
  it('rejects non-string', () => assert.equal(isAllowedRouterIp(null), false));
  it('rejects malformed string', () => assert.equal(isAllowedRouterIp('not-an-ip'), false));
  it('rejects octet > 255', () => assert.equal(isAllowedRouterIp('192.168.1.256'), false));
});

// ─── isAllowedLogPath ─────────────────────────────────────────────────────────

describe('isAllowedLogPath', () => {
  afterEach(() => { delete process.env.EGRESSVIEW_LOG_PATH_PREFIXES; });

  it('accepts /var/log/ paths', () =>
    assert.equal(isAllowedLogPath('/var/log/dnsmasq-queries.log'), true));
  it('accepts nested /var/log/ paths', () =>
    assert.equal(isAllowedLogPath('/var/log/remote/router.log'), true));
  it('accepts /private/var/log/ (macOS real path)', () =>
    assert.equal(isAllowedLogPath('/private/var/log/yamaha-router.log'), true));
  it('accepts /opt/homebrew/var/log/ (Homebrew Apple Silicon)', () =>
    assert.equal(isAllowedLogPath('/opt/homebrew/var/log/dnsmasq.log'), true));
  it('accepts /usr/local/var/log/ (Homebrew Intel)', () =>
    assert.equal(isAllowedLogPath('/usr/local/var/log/dnsmasq.log'), true));

  it('rejects /etc/shadow', () =>
    assert.equal(isAllowedLogPath('/etc/shadow'), false));
  it('rejects /tmp paths (symlink risk)', () =>
    assert.equal(isAllowedLogPath('/tmp/fake.log'), false));
  it('rejects /home paths', () =>
    assert.equal(isAllowedLogPath('/home/user/x.log'), false));
  it('rejects traversal out of /var/log', () =>
    assert.equal(isAllowedLogPath('/var/log/../../etc/shadow'), false));
  it('rejects traversal even with normalize-resistant form', () =>
    assert.equal(isAllowedLogPath('/var/log/x/../../../etc/shadow'), false));
  it('rejects relative paths', () =>
    assert.equal(isAllowedLogPath('var/log/x.log'), false));
  it('rejects null bytes', () =>
    assert.equal(isAllowedLogPath('/var/log/x\x00.log'), false));
  it('rejects non-string', () =>
    assert.equal(isAllowedLogPath(null), false));
  it('rejects prefix without separator boundary (/var/logs/)', () =>
    assert.equal(isAllowedLogPath('/var/logs/evil.log'), false));

  it('accepts extra prefixes via EGRESSVIEW_LOG_PATH_PREFIXES', () => {
    process.env.EGRESSVIEW_LOG_PATH_PREFIXES = '/srv/log/,/data/logs';
    assert.equal(isAllowedLogPath('/srv/log/router.log'), true);
    assert.equal(isAllowedLogPath('/data/logs/router.log'), true); // trailing slash is added automatically
    assert.equal(isAllowedLogPath('/data/logs-evil/x.log'), false);
  });
  it('ignores relative entries in EGRESSVIEW_LOG_PATH_PREFIXES', () => {
    process.env.EGRESSVIEW_LOG_PATH_PREFIXES = 'relative/path,/ok/dir/';
    assert.equal(isAllowedLogPath('relative/path/x.log'), false);
    assert.equal(isAllowedLogPath('/ok/dir/x.log'), true);
  });
});

// ─── parseTimestamp ───────────────────────────────────────────────────────────

describe('parseTimestamp', () => {
  it('parses a valid epoch ms string', () => {
    assert.equal(parseTimestamp('1700000000000'), 1700000000000);
  });

  it('parses a numeric string with leading zeros', () => {
    assert.equal(parseTimestamp('0100'), 100); // parseInt base 10
  });

  it('returns null for undefined', () => assert.equal(parseTimestamp(undefined), null));
  it('returns null for null',      () => assert.equal(parseTimestamp(null),      null));
  it('returns null for empty string', () => assert.equal(parseTimestamp(''),     null));

  it('returns null for non-numeric string', () => {
    assert.equal(parseTimestamp('abc'), null);
  });

  it('returns null for partial numeric string "123abc"', () => {
    // Strict integer-string check: trailing non-digit characters are rejected.
    assert.equal(parseTimestamp('123abc'), null);
  });

  it('returns null for "NaN"', () => {
    assert.equal(parseTimestamp('NaN'), null);
  });

  it('returns null for Infinity string', () => {
    assert.equal(parseTimestamp('Infinity'), null);
  });

  it('returns null for float string "1700000000000.9"', () => {
    // Decimal point is not allowed; only plain integer strings are accepted.
    assert.equal(parseTimestamp('1700000000000.9'), null);
  });
});

// ─── parsePositiveInt ─────────────────────────────────────────────────────────

describe('parsePositiveInt', () => {
  it('accepts integer 1', () => assert.equal(parsePositiveInt(1), 1));
  it('accepts integer 24', () => assert.equal(parsePositiveInt(24), 24));
  it('accepts numeric string "7"', () => assert.equal(parsePositiveInt('7'), 7));
  it('accepts numeric string "100"', () => assert.equal(parsePositiveInt('100'), 100));

  it('returns null for 0', () => assert.equal(parsePositiveInt(0), null));
  it('returns null for negative', () => assert.equal(parsePositiveInt(-1), null));
  it('returns null for null', () => assert.equal(parsePositiveInt(null), null));
  it('returns null for undefined', () => assert.equal(parsePositiveInt(undefined), null));
  it('returns null for non-numeric string', () => assert.equal(parsePositiveInt('abc'), null));
  it('returns null for empty string', () => assert.equal(parsePositiveInt(''), null));
  it('returns null for float', () => assert.equal(parsePositiveInt(1.5), null));
  it('returns null for float string "2.5"', () => assert.equal(parsePositiveInt('2.5'), null));
  it('returns null for Infinity', () => assert.equal(parsePositiveInt(Infinity), null));
  it('returns null for NaN', () => assert.equal(parsePositiveInt(NaN), null));
});
