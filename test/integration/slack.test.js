// Integration test for Slack notifier — sends a real DM
// Requires .widemap.json with: { "slack": { "token": "xoxb-...", "userId": "U..." } }
// Run: node --test test/integration/slack.test.js

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifier = require('../../src/notifier');

const CONFIG_FILE = path.join(__dirname, '..', '..', '.widemap.json');

function loadSlackConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data.slack || {};
  } catch {
    return {};
  }
}

describe('Slack integration', () => {
  let slackConfig;

  before(() => {
    slackConfig = loadSlackConfig();
    if (!slackConfig.token || !slackConfig.userId) {
      console.log('[slack integration] Skipping: no token/userId in .widemap.json');
    }
  });

  it('sends a test DM successfully', async (t) => {
    if (!slackConfig.token || !slackConfig.userId) {
      t.skip('slack.token and slack.userId required in .widemap.json');
      return;
    }
    notifier.configure({
      enabled: true,
      token: slackConfig.token,
      userId: slackConfig.userId,
    });
    const result = await notifier.test();
    assert.equal(result.ok, true, `Slack API returned error: ${result.error}`);
  });

  it('sends a threat notification DM', async (t) => {
    if (!slackConfig.token || !slackConfig.userId) {
      t.skip('slack.token and slack.userId required in .widemap.json');
      return;
    }
    notifier.configure({
      enabled: true,
      token: slackConfig.token,
      userId: slackConfig.userId,
      cooldownMinutes: 0,
    });
    notifier._resetCooldown();
    const result = await notifier.notify({
      src: '192.168.1.10',
      dst: '185.220.101.45',
      dport: 443,
      proto: 'TCP',
      srcVendor: 'Apple',
      srcMdnsName: 'test-device',
      srcDnsName: null,
      dstHost: 'test.example.com',
      country: 'RU',
      city: 'Moscow',
      org: 'Test Org',
      lastSeen: Date.now(),
      threat: { source: 'feodo', tag: '[TEST] Emotet C2 — integration test' },
    });
    assert.equal(result, true, 'notify() should return true on success');
  });
});
