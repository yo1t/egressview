'use strict';
const logger = require('./logger');

const https = require('https');

let _enabled = false;
let _token = '';
let _userId = '';
let _cooldownMs = 60 * 60 * 1000; // 1 hour default
let _language = 'ja';

// cooldown tracking: 'src|dst' → lastNotifiedAt (ms)
const _cooldown = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, last] of _cooldown) {
    if (now - last >= _cooldownMs) _cooldown.delete(key);
  }
}, 60 * 60_000).unref();

// injectable for tests
let _httpPost = _defaultHttpPost;

// optional callback to persist every detection/notification event
let _logCallback = null;
function setLogCallback(fn) { _logCallback = fn; }

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
  if (typeof cooldownMinutes === 'number' && cooldownMinutes > 0 && cooldownMinutes <= 1440) {
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
  if (!entry.threat) return false;

  let slackSent = false;

  if (_enabled && _token && _userId) {
    const key = `${entry.src}|${entry.dst}`;
    const last = _cooldown.get(key);
    if (!last || Date.now() - last >= _cooldownMs) {
      _cooldown.set(key, Date.now());
      try {
        const result = await _httpPost({
          channel: _userId,
          text: _buildMessage(entry),
        }, _token);
        if (!result.ok) logger.error('[notifier] Slack error:', result.error);
        else slackSent = true;
      } catch (err) {
        logger.error('[notifier] Slack post failed:', err.message);
      }
    }
  }

  if (_logCallback) _logCallback(entry, 'threat', slackSent);
  return slackSent;
}

const _TEST_MSG = {
  ja: '✅ EgressView — Slack通知の設定が完了しました。脅威検出時にこのDMに通知が届きます。',
  en: '✅ EgressView — Slack notifications configured. You will receive a DM here when a threat is detected.',
};

const _NEW_DEVICE_MSG = {
  ja: {
    title:  (name, ip) => `🆕 *新規デバイス検出* — ${name}`,
    ip:     (ip)       => `*IPアドレス:* ${ip}`,
    vendor: (v)        => `*ベンダー:* ${v}`,
    mac:    (m)        => `*MAC:* ${m}`,
    time:   (ts)       => `*検出時刻:* ${new Date(ts).toLocaleString('ja-JP')}`,
  },
  en: {
    title:  (name, ip) => `🆕 *New Device Detected* — ${name}`,
    ip:     (ip)       => `*IP Address:* ${ip}`,
    vendor: (v)        => `*Vendor:* ${v}`,
    mac:    (m)        => `*MAC:* ${m}`,
    time:   (ts)       => `*Detected at:* ${new Date(ts).toLocaleString('en-US')}`,
  },
};

async function notifyNewDevice(entry) {
  let slackSent = false;

  if (_enabled && _token && _userId) {
    const L = _NEW_DEVICE_MSG[_language] || _NEW_DEVICE_MSG.ja;
    const name = entry.srcMdnsName || entry.srcDnsName || entry.src;
    const lines = [
      L.title(name, entry.src),
      L.ip(entry.src),
      entry.srcVendor ? L.vendor(entry.srcVendor) : null,
      entry.srcMac    ? L.mac(entry.srcMac)        : null,
      L.time(entry.lastSeen),
    ].filter(Boolean).join('\n');
    try {
      const result = await _httpPost({ channel: _userId, text: lines }, _token);
      if (!result.ok) logger.error('[notifier] new-device Slack error:', result.error);
      else slackSent = true;
    } catch (err) {
      logger.error('[notifier] notifyNewDevice failed:', err.message);
    }
  }

  if (_logCallback) _logCallback(entry, 'new_device', slackSent);
  return slackSent;
}

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
function _resetLogCallback() { _logCallback = null; }

// ─── Slack API helpers ────────────────────────────────────────────────────────

const SLACK_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function _slackGet(method, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, res => {
      let data = '';
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > SLACK_MAX_BYTES) { req.destroy(); return reject(new Error('Slack response too large')); }
        data += chunk;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'invalid_json' }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Verify token and get workspace info
async function verifyToken(token) {
  if (!token) return { ok: false, error: 'token_missing' };
  try {
    const result = await _slackGet('auth.test', token);
    if (result.ok) {
      return { ok: true, team: result.team, teamId: result.team_id, user: result.user, userId: result.user_id };
    }
    return { ok: false, error: result.error || 'unknown' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Look up user by username (display name or real name)
async function lookupUser(username, token) {
  if (!token || !username) return { ok: false, error: 'missing_params' };
  const name = username.replace(/^@/, '').toLowerCase();
  try {
    // Use users.list (paginated, but for small workspaces one page is enough)
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const result = await _slackGet(`users.list?limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, token);
      if (!result.ok) return { ok: false, error: result.error };
      const match = (result.members || []).find(m => {
        if (m.deleted || m.is_bot) return false;
        const n = (m.name || '').toLowerCase();
        const dn = (m.profile?.display_name || '').toLowerCase();
        const rn = (m.real_name || '').toLowerCase();
        return n === name || dn === name || rn === name;
      });
      if (match) {
        return { ok: true, userId: match.id, name: match.name, realName: match.real_name, displayName: match.profile?.display_name };
      }
      cursor = result.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return { ok: false, error: 'user_not_found' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { configure, getConfig, notify, notifyNewDevice, setLogCallback, test, verifyToken, lookupUser, _buildMessage, _setHttpPost, _resetCooldown, _resetLogCallback };
