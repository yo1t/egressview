'use strict';

const https = require('https');

let _enabled = false;
let _token = '';
let _userId = '';
let _cooldownMs = 60 * 60 * 1000; // 1 hour default
let _language = 'ja';

// cooldown tracking: 'src|dst' → lastNotifiedAt (ms)
const _cooldown = new Map();

// injectable for tests
let _httpPost = _defaultHttpPost;

function _defaultHttpPost(body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'invalid_json' }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function configure({ enabled, token, userId, cooldownMinutes, language } = {}) {
  if (typeof enabled === 'boolean') _enabled = enabled;
  if (typeof token === 'string') _token = token;
  if (typeof userId === 'string') _userId = userId;
  if (typeof cooldownMinutes === 'number' && cooldownMinutes > 0) {
    _cooldownMs = cooldownMinutes * 60 * 1000;
  }
  if (language === 'ja' || language === 'en') _language = language;
}

function getConfig() {
  return {
    enabled: _enabled,
    userId: _userId,
    cooldownMinutes: Math.round(_cooldownMs / 60000),
    tokenSet: _token.length > 0,
  };
}

const _MSG = {
  ja: {
    title:   (tag)  => `🚨 *脅威検出* — ${tag}`,
    feed:    (feed) => `*フィード:* ${feed}`,
    src:     (name, ip, vendor) => `*送信元:* ${name} (${ip})${vendor ? ' / ' + vendor : ''}`,
    dst:     (dst, dport, proto) => `*宛先:* ${dst}  port ${dport}/${proto}`,
    geo:     (geo)  => `*場所/組織:* ${geo}`,
    time:    (ts)   => `*検出時刻:* ${new Date(ts).toLocaleString('ja-JP')}`,
  },
  en: {
    title:   (tag)  => `🚨 *Threat Detected* — ${tag}`,
    feed:    (feed) => `*Feed:* ${feed}`,
    src:     (name, ip, vendor) => `*Source:* ${name} (${ip})${vendor ? ' / ' + vendor : ''}`,
    dst:     (dst, dport, proto) => `*Destination:* ${dst}  port ${dport}/${proto}`,
    geo:     (geo)  => `*Location/Org:* ${geo}`,
    time:    (ts)   => `*Detected at:* ${new Date(ts).toLocaleString('en-US')}`,
  },
};

function _buildMessage(entry, lang) {
  const L = _MSG[lang || _language] || _MSG.ja;
  const src = entry.srcMdnsName || entry.srcDnsName || entry.src;
  const dst = entry.dstHost !== entry.dst ? `${entry.dstHost} (${entry.dst})` : entry.dst;
  const geo = [entry.city, entry.country, entry.org].filter(Boolean).join(' / ');
  const tag = entry.threat?.tag || '';
  const feed = entry.threat?.source || '';

  return [
    L.title(tag),
    L.feed(feed),
    L.src(src, entry.src, entry.srcVendor),
    L.dst(dst, entry.dport, entry.proto),
    geo ? L.geo(geo) : null,
    L.time(entry.lastSeen),
  ].filter(Boolean).join('\n');
}

async function notify(entry) {
  if (!_enabled || !_token || !_userId) return false;
  if (!entry.threat) return false;

  const key = `${entry.src}|${entry.dst}`;
  const last = _cooldown.get(key);
  if (last && Date.now() - last < _cooldownMs) return false;

  _cooldown.set(key, Date.now());

  try {
    const result = await _httpPost({
      channel: _userId,
      text: _buildMessage(entry),
    }, _token);
    if (!result.ok) {
      console.error('[notifier] Slack error:', result.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notifier] Slack post failed:', err.message);
    return false;
  }
}

const _TEST_MSG = {
  ja: '✅ Widemap — Slack通知の設定が完了しました。脅威検出時にこのDMに通知が届きます。',
  en: '✅ Widemap — Slack notifications configured. You will receive a DM here when a threat is detected.',
};

async function test() {
  if (!_token || !_userId) return { ok: false, error: 'token_or_userid_missing' };
  try {
    const result = await _httpPost({
      channel: _userId,
      text: _TEST_MSG[_language] || _TEST_MSG.ja,
    }, _token);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// test seam only — not for production use
function _setHttpPost(fn) { _httpPost = fn; }
function _resetCooldown() { _cooldown.clear(); }

module.exports = { configure, getConfig, notify, test, _buildMessage, _setHttpPost, _resetCooldown };
