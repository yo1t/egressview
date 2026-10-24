'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { alertFromLogRow } = require('../../src/mcp-tools');

// 2026-10-24: get_alerts returned feed, confidence and detail as null for every
// threat, because it read columns the detection log does not have.
describe('MCP get_alerts: 検出ログの行', () => {
  it('脅威の行は、フィード・確度・内容と、宛先のホスト名・ポートを返す', () => {
    const alert = alertFromLogRow({
      type: 'threat', detectedAt: 1792800000000, slackSent: 1,
      src: '192.168.1.26', srcDnsName: 'iPhone', srcMdnsName: null,
      dst: '45.125.32.130', dstHost: 'spk.example', dport: 443, proto: 'TCP',
      threatSource: 'spamhaus', threatConfidence: null, threatTag: 'Spamhaus DROP (hijacked network)',
    });
    assert.deepEqual(alert, {
      type: 'threat', detectedAt: new Date(1792800000000).toISOString(),
      src: '192.168.1.26', srcName: 'iPhone', dst: '45.125.32.130', host: 'spk.example',
      dport: 443, proto: 'TCP', feed: 'spamhaus', confidence: null,
      detail: 'Spamhaus DROP (hijacked network)', slackSent: true,
    });
  });

  it('確度が付いた行は確度を返し、新しい端末の行は空のまま', () => {
    assert.equal(alertFromLogRow({ type: 'threat', threatSource: 'urlhaus', threatConfidence: 'low' }).confidence, 'low');
    const device = alertFromLogRow({ type: 'new_device', src: '192.168.1.9', srcMdnsName: 'printer.local', slackSent: 0 });
    assert.equal(device.srcName, 'printer.local');
    assert.equal(device.feed, null);
    assert.equal(device.detail, null);
    assert.equal(device.slackSent, false);
  });
});
