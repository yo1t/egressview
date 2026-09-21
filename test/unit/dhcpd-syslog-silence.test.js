'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const dhcpd = require('../../src/pollers/dhcpd-syslog');

// P3-151. This collector spent months switched on and receiving nothing. It
// logged "tailing <file>" at every start, which reads like success, and never
// mentioned that no line ever arrived: the file was zero bytes and had never
// held a [DHCPD] entry. A collector that collects nothing has to be the one to
// say so, because nobody goes looking for an absence.
function captureWarnings(run) {
  const logger = require('../../src/logger');
  const original = logger.warn;
  const warnings = [];
  logger.warn = (...args) => warnings.push(args.join(' '));
  try { run(); } finally { logger.warn = original; }
  return warnings;
}

beforeEach(() => { dhcpd.stop(); });
afterEach(() => { dhcpd.stop(); });

describe('何も届いていない収集経路は、自分でそう言う', () => {
  it('有効なのに1件も届いていなければ警告する', () => {
    dhcpd.configure({ enabled: true, logFile: '/var/log/nothing-arrives-here.log' });
    dhcpd.start();
    // Pretend the grace period has passed.
    const warnings = captureWarnings(() => dhcpd._checkSilence());
    // Inside the grace period it says nothing; the status carries the truth.
    assert.equal(warnings.length, 0, '猶予期間中に鳴ってはいけない');
    assert.equal(dhcpd.status().leasesSeen, 0);
    assert.equal(dhcpd.status().enabled, true);
  });

  it('何が失われるかまで言う。黙って不安にさせない', () => {
    dhcpd.configure({ enabled: true, logFile: '/var/log/nothing-arrives-here.log' });
    dhcpd.start();
    dhcpd._setStartedAtForTest(Date.now() - 16 * 60 * 1000);
    const warnings = captureWarnings(() => dhcpd._checkSilence());
    assert.equal(warnings.length, 1, '猶予期間を過ぎたら鳴らなければならない');
    // The operator needs three things: that it is on, that nothing arrives,
    // and that this is not data loss.
    assert.match(warnings[0], /switched on/);
    assert.match(warnings[0], /nothing-arrives-here\.log/);
    assert.match(warnings[0], /nothing is missing/);
  });

  it('1件でも届いていれば、二度と鳴らない', () => {
    dhcpd.configure({ enabled: true, logFile: '/var/log/whatever.log' });
    dhcpd.start();
    dhcpd._setStartedAtForTest(Date.now() - 16 * 60 * 1000);
    assert.equal(captureWarnings(() => dhcpd._checkSilence()).length, 1, '前提: まだ届いていない');

    dhcpd._noteLeaseForTest({ ip: '192.0.2.27', mac: 'aa:bb:cc:dd:ee:ff' });
    assert.equal(captureWarnings(() => dhcpd._checkSilence()).length, 0,
      '届いているのに鳴り続けてはいけない');
    assert.equal(dhcpd.status().leasesSeen, 1);
    assert.equal(dhcpd.getMacByIp('192.0.2.27'), 'aa:bb:cc:dd:ee:ff');
  });

  it('無効なら、届いていなくても鳴らない', () => {
    dhcpd.configure({ enabled: false, logFile: '/var/log/off.log' });
    dhcpd.start();
    const warnings = captureWarnings(() => dhcpd._checkSilence());
    assert.equal(warnings.length, 0, '切ってあるものについて文句を言ってはいけない');
    assert.equal(dhcpd.status().enabled, false);
  });

  it('状態を外から読める', () => {
    dhcpd.configure({ enabled: true, logFile: '/var/log/x.log' });
    dhcpd.start();
    const s = dhcpd.status();
    assert.equal(s.logFile, '/var/log/x.log');
    assert.equal(s.leasesSeen, 0);
    assert.equal(s.tracking, 0);
    assert.ok(s.silentFor >= 0);
  });
});
