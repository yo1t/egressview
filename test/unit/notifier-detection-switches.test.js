// Unit tests for per-detection notification delivery switches (P2-76)
// Run: node --test test/unit/notifier-detection-switches.test.js

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const notifier = require('../../src/notifier');

// The cooldown map is keyed on `src|dst` and lives for the module's lifetime,
// so each case needs its own destination or a later notify is suppressed.
let dstCounter = 0;
function threatEntry() {
  dstCounter += 1;
  return {
    src: '192.168.1.10',
    dst: `198.51.100.${dstCounter}`,
    dport: 443,
    proto: 'TCP',
    lastSeen: 1700000000000,
    threat: { source: 'feodo', tag: 'Emotet C2' },
  };
}

function newDeviceEntry() {
  return {
    src: '192.168.1.55',
    srcMac: 'aa:bb:cc:dd:ee:ff',
    srcVendor: 'Apple',
    lastSeen: 1700000000000,
  };
}

function setup() {
  const posts = [];
  const logged = [];
  notifier._setHttpPost(async (body) => { posts.push(body); return { ok: true }; });
  notifier.setLogCallback((entry, type, slackSent, options) => {
    logged.push({ type, slackSent, options });
  });
  notifier.configure({
    enabled: true, token: 'xoxb-test', userId: 'U1', cooldownMinutes: 1440,
  });
  // Restore the shipped defaults before each case; the module holds state.
  notifier.configureDetection({
    threat: { slack: true, history: true },
    newDevice: { slack: true, history: true },
  });
  return { posts, logged };
}

describe('検出イベント通知の配信スイッチ', () => {
  beforeEach(() => { setup(); });

  it('既定では脅威・新規デバイスとも Slack と履歴の両方が有効', () => {
    const config = notifier.getDetectionConfig();
    assert.deepEqual(config, {
      threat: { slack: true, history: true },
      newDevice: { slack: true, history: true },
    });
  });

  it('newDevice.slack を false にすると Slack へ送らず履歴には残る', async () => {
    const { posts, logged } = setup();
    notifier.configureDetection({ newDevice: { slack: false } });
    await notifier.notifyNewDevice(newDeviceEntry());
    assert.equal(posts.length, 0);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].type, 'new_device');
    assert.equal(logged[0].options.record, true);
  });

  it('newDevice.history を false にすると record:false を渡す', async () => {
    const { posts, logged } = setup();
    notifier.configureDetection({ newDevice: { history: false } });
    await notifier.notifyNewDevice(newDeviceEntry());
    assert.equal(posts.length, 1, 'Slackは独立して有効なままであること');
    assert.equal(logged[0].options.record, false);
  });

  it('threat.slack を false にしても脅威観測用のコールバックは呼ばれる', async () => {
    const { posts, logged } = setup();
    notifier.configureDetection({ threat: { slack: false } });
    await notifier.notify(threatEntry());
    assert.equal(posts.length, 0);
    assert.equal(logged.length, 1, 'AIルールの入力を絶やさないため必ず呼ぶ');
    assert.equal(logged[0].type, 'threat');
  });

  it('threat.history を false にしても record 以外は通常どおり', async () => {
    const { posts, logged } = setup();
    notifier.configureDetection({ threat: { history: false } });
    await notifier.notify(threatEntry());
    assert.equal(posts.length, 1);
    assert.equal(logged[0].options.record, false);
    assert.equal(logged[0].slackSent, true);
  });

  it('両チャネルを false にすると Slack も履歴も止まる', async () => {
    const { posts, logged } = setup();
    notifier.configureDetection({ newDevice: { slack: false, history: false } });
    await notifier.notifyNewDevice(newDeviceEntry());
    assert.equal(posts.length, 0);
    assert.equal(logged[0].options.record, false);
  });

  it('片方の検出を無効にしても、もう片方には影響しない', async () => {
    const { posts } = setup();
    notifier.configureDetection({ newDevice: { slack: false } });
    await notifier.notify(threatEntry());
    assert.equal(posts.length, 1, '脅威通知は独立して届くこと');
  });

  it('boolean 以外の値と未知のキーは無視する', () => {
    setup();
    notifier.configureDetection({
      threat: { slack: 'no', history: 1 },
      unknownKind: { slack: false },
      newDevice: null,
    });
    assert.deepEqual(notifier.getDetectionConfig(), {
      threat: { slack: true, history: true },
      newDevice: { slack: true, history: true },
    });
  });

  it('getDetectionConfig の戻り値を書き換えても内部状態は変わらない', () => {
    setup();
    const config = notifier.getDetectionConfig();
    config.threat.slack = false;
    assert.equal(notifier.getDetectionConfig().threat.slack, true);
  });

  it('Slack 全体が無効なら個別設定に関係なく送信しない', async () => {
    const { posts } = setup();
    notifier.configure({ enabled: false });
    notifier.configureDetection({ newDevice: { slack: true } });
    await notifier.notifyNewDevice(newDeviceEntry());
    assert.equal(posts.length, 0);
    notifier.configure({ enabled: true });
  });
});
