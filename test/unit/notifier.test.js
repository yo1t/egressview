// Unit tests for Slack notifier module
// Run: node --test test/unit/notifier.test.js

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const notifier = require('../../src/notifier');

function makeEntry(overrides = {}) {
  return {
    src: '192.168.1.10',
    dst: '185.220.101.45',
    dport: 443,
    proto: 'TCP',
    srcVendor: 'Apple',
    srcMdnsName: 'MacBook-Pro',
    srcDnsName: null,
    dstHost: 'evil.example.com',
    country: 'RU',
    city: 'Moscow',
    org: 'Evil Corp',
    lastSeen: 1700000000000,
    threat: { source: 'feodo', tag: 'Emotet C2' },
    ...overrides,
  };
}

beforeEach(() => {
  notifier._resetCooldown();
  notifier.configure({ enabled: false, token: '', userId: '', cooldownMinutes: 60 });
});

describe('configure / getConfig', () => {
  it('stores enabled flag', () => {
    notifier.configure({ enabled: true });
    assert.equal(notifier.getConfig().enabled, true);
  });

  it('stores userId', () => {
    notifier.configure({ userId: 'U01ABC' });
    assert.equal(notifier.getConfig().userId, 'U01ABC');
  });

  it('stores cooldownMinutes', () => {
    notifier.configure({ cooldownMinutes: 30 });
    assert.equal(notifier.getConfig().cooldownMinutes, 30);
  });

  it('getConfig does not expose token value', () => {
    notifier.configure({ token: 'xoxb-secret' });
    const cfg = notifier.getConfig();
    assert(!('token' in cfg), 'token must not appear in getConfig()');
    assert.equal(cfg.tokenSet, true);
  });

  it('tokenSet is false when token is empty', () => {
    notifier.configure({ token: '' });
    assert.equal(notifier.getConfig().tokenSet, false);
  });
});

describe('notify — skip conditions', () => {
  it('returns false when disabled', async () => {
    notifier.configure({ enabled: false, token: 'xoxb-x', userId: 'U01' });
    const result = await notifier.notify(makeEntry());
    assert.equal(result, false);
  });

  it('returns false when token is empty', async () => {
    notifier.configure({ enabled: true, token: '', userId: 'U01' });
    const result = await notifier.notify(makeEntry());
    assert.equal(result, false);
  });

  it('returns false when userId is empty', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: '' });
    const result = await notifier.notify(makeEntry());
    assert.equal(result, false);
  });

  it('returns false when threat is null', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    const result = await notifier.notify(makeEntry({ threat: null }));
    assert.equal(result, false);
  });
});

describe('notify — cooldown', () => {
  beforeEach(() => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01', cooldownMinutes: 60 });
    notifier._setHttpPost(async () => ({ ok: true }));
  });

  it('sends first notification', async () => {
    const result = await notifier.notify(makeEntry());
    assert.equal(result, true);
  });

  it('suppresses second notification within cooldown', async () => {
    await notifier.notify(makeEntry());
    const result = await notifier.notify(makeEntry());
    assert.equal(result, false);
  });

  it('allows notification for different dst', async () => {
    await notifier.notify(makeEntry({ dst: '1.2.3.4' }));
    const result = await notifier.notify(makeEntry({ dst: '5.6.7.8' }));
    assert.equal(result, true);
  });

  it('allows re-notification after cooldown expires', async () => {
    notifier.configure({ cooldownMinutes: 0.001 }); // ~60ms
    await notifier.notify(makeEntry());
    await new Promise(r => setTimeout(r, 100));
    const result = await notifier.notify(makeEntry());
    assert.equal(result, true);
  });
});

describe('notify — Slack API error handling', () => {
  beforeEach(() => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
  });

  it('returns false on Slack API error', async () => {
    notifier._setHttpPost(async () => ({ ok: false, error: 'invalid_auth' }));
    const result = await notifier.notify(makeEntry());
    assert.equal(result, false);
  });

  it('returns false on network error', async () => {
    notifier._setHttpPost(async () => { throw new Error('ECONNREFUSED'); });
    const result = await notifier.notify(makeEntry());
    assert.equal(result, false);
  });
});

describe('notify — message content', () => {
  it('message includes threat tag', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notify(makeEntry());
    assert(captured.text.includes('Emotet C2'), 'threat tag missing from message');
  });

  it('message includes source IP', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notify(makeEntry());
    assert(captured.text.includes('192.168.1.10'), 'src IP missing from message');
  });

  it('message sent to configured userId', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U99XYZ' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notify(makeEntry());
    assert.equal(captured.channel, 'U99XYZ');
  });
});

describe('test()', () => {
  it('returns error when token missing', async () => {
    notifier.configure({ token: '', userId: 'U01' });
    const result = await notifier.test();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'token_or_userid_missing');
  });

  it('returns error when userId missing', async () => {
    notifier.configure({ token: 'xoxb-x', userId: '' });
    const result = await notifier.test();
    assert.equal(result.ok, false);
  });

  it('returns ok on success', async () => {
    notifier.configure({ token: 'xoxb-x', userId: 'U01' });
    notifier._setHttpPost(async () => ({ ok: true }));
    const result = await notifier.test();
    assert.equal(result.ok, true);
  });

  it('returns error on Slack failure', async () => {
    notifier.configure({ token: 'xoxb-x', userId: 'U01' });
    notifier._setHttpPost(async () => ({ ok: false, error: 'invalid_auth' }));
    const result = await notifier.test();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_auth');
  });
});

describe('_buildMessage', () => {
  it('uses mDNS name when available', () => {
    const msg = notifier._buildMessage(makeEntry({ srcMdnsName: 'my-mac' }));
    assert(msg.includes('my-mac'));
  });

  it('falls back to DNS name when no mDNS', () => {
    const msg = notifier._buildMessage(makeEntry({ srcMdnsName: null, srcDnsName: 'myhost.local' }));
    assert(msg.includes('myhost.local'));
  });

  it('falls back to IP when no names', () => {
    const msg = notifier._buildMessage(makeEntry({ srcMdnsName: null, srcDnsName: null }));
    assert(msg.includes('192.168.1.10'));
  });

  it('includes feed source', () => {
    const msg = notifier._buildMessage(makeEntry());
    assert(msg.includes('feodo'));
  });
});

describe('notifyNewDevice()', () => {
  function makeDeviceEntry(overrides = {}) {
    return {
      src: '192.168.1.50',
      srcMac: 'aa:bb:cc:dd:ee:ff',
      srcVendor: 'Samsung',
      srcMdnsName: 'Galaxy-S25',
      srcDnsName: null,
      lastSeen: 1700000000000,
      ...overrides,
    };
  }

  beforeEach(() => {
    notifier.configure({ enabled: false, token: '', userId: '' });
  });

  it('returns false when disabled', async () => {
    notifier.configure({ enabled: false, token: 'xoxb-x', userId: 'U01' });
    assert.equal(await notifier.notifyNewDevice(makeDeviceEntry()), false);
  });

  it('returns false when token is empty', async () => {
    notifier.configure({ enabled: true, token: '', userId: 'U01' });
    assert.equal(await notifier.notifyNewDevice(makeDeviceEntry()), false);
  });

  it('returns false when userId is empty', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: '' });
    assert.equal(await notifier.notifyNewDevice(makeDeviceEntry()), false);
  });

  it('returns true on success', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    notifier._setHttpPost(async () => ({ ok: true }));
    assert.equal(await notifier.notifyNewDevice(makeDeviceEntry()), true);
  });

  it('returns false on Slack API error', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    notifier._setHttpPost(async () => ({ ok: false, error: 'invalid_auth' }));
    assert.equal(await notifier.notifyNewDevice(makeDeviceEntry()), false);
  });

  it('message includes device IP', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notifyNewDevice(makeDeviceEntry());
    assert(captured.text.includes('192.168.1.50'), 'IP missing from message');
  });

  it('message includes vendor when present', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notifyNewDevice(makeDeviceEntry());
    assert(captured.text.includes('Samsung'), 'vendor missing from message');
  });

  it('message omits vendor line when absent', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notifyNewDevice(makeDeviceEntry({ srcVendor: null }));
    assert(!captured.text.includes('ベンダー') && !captured.text.includes('Vendor:'), 'vendor line should be absent');
  });

  it('message sent to configured userId', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U99XYZ' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notifyNewDevice(makeDeviceEntry());
    assert.equal(captured.channel, 'U99XYZ');
  });
});

describe('_buildMessage — language', () => {
  it('ja: uses Japanese labels', () => {
    const msg = notifier._buildMessage(makeEntry(), 'ja');
    assert(msg.includes('脅威検出'), 'ja title missing');
    assert(msg.includes('フィード'), 'ja feed label missing');
    assert(msg.includes('送信元'), 'ja src label missing');
    assert(msg.includes('宛先'), 'ja dst label missing');
  });

  it('en: uses English labels', () => {
    const msg = notifier._buildMessage(makeEntry(), 'en');
    assert(msg.includes('Threat Detected'), 'en title missing');
    assert(msg.includes('Feed:'), 'en feed label missing');
    assert(msg.includes('Source:'), 'en src label missing');
    assert(msg.includes('Destination:'), 'en dst label missing');
  });

  it('en: message uses English when language is configured as en', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01', language: 'en' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notify(makeEntry());
    assert(captured.text.includes('Threat Detected'), 'English title missing when language=en');
  });

  it('ja: message uses Japanese when language is configured as ja', async () => {
    notifier.configure({ enabled: true, token: 'xoxb-x', userId: 'U01', language: 'ja' });
    let captured = null;
    notifier._setHttpPost(async (body) => { captured = body; return { ok: true }; });
    await notifier.notify(makeEntry());
    assert(captured.text.includes('脅威検出'), 'Japanese title missing when language=ja');
  });
});
