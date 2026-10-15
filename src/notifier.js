'use strict';
const logger = require('./logger');

const https = require('https');

let _enabled = false;
let _token = '';
let _userId = '';
let _displayName = '';
let _cooldownMs = 60 * 60 * 1000; // 1 hour default
let _language = 'ja';

// Per-detection delivery switches. These cover the two detections this module
// raises directly; the AI event rules are separate and live in
// ai-notification-service.js. Note that its `threat.enabled` gates AI analysis,
// not the plain threat DM below, so the two must not be conflated.
//
// Slack and history are independent on purpose: a new device appearing on the
// network is worth recording even when the operator does not want a DM for it.
// Defaults are true so that an upgrade never silently drops a notification the
// operator was already receiving.
const DETECTION_KINDS = ['threat', 'newDevice', 'lanScan'];
const _detection = {
  threat:    { slack: true, history: true },
  newDevice: { slack: true, history: true },
  // A program on an Agent's computer looking around the LAN (P3-191).
  lanScan:   { slack: true, history: true },
};

function configureDetection(input = {}) {
  for (const kind of DETECTION_KINDS) {
    const next = input?.[kind];
    if (!next || typeof next !== 'object') continue;
    if (typeof next.slack === 'boolean') _detection[kind].slack = next.slack;
    if (typeof next.history === 'boolean') _detection[kind].history = next.history;
  }
}

function getDetectionConfig() {
  return {
    threat:    { ..._detection.threat },
    newDevice: { ..._detection.newDevice },
    lanScan:   { ..._detection.lanScan },
  };
}

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

function configure({ enabled, token, userId, displayName, cooldownMinutes, language } = {}) {
  if (typeof enabled === 'boolean') _enabled = enabled;
  if (typeof token === 'string') _token = token;
  if (typeof userId === 'string') _userId = userId;
  if (typeof displayName === 'string') _displayName = displayName;
  if (typeof cooldownMinutes === 'number' && cooldownMinutes > 0 && cooldownMinutes <= 1440) {
    _cooldownMs = cooldownMinutes * 60 * 1000;
  }
  if (language === 'ja' || language === 'en') _language = language;
}

function getConfig() {
  return {
    enabled: _enabled,
    userId: _userId,
    displayName: _displayName,
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

  if (_enabled && _token && _userId && _detection.threat.slack) {
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

  // Always call back: the consumer also feeds the AI threat rules from this
  // hook, and those must keep observing detections even when the operator has
  // silenced the history entry. `record` says whether to store the row.
  if (_logCallback) _logCallback(entry, 'threat', slackSent, { record: _detection.threat.history });
  return slackSent;
}

const _TEST_MSG = {
  ja: '✅ EgressView — Slack通知の設定が完了しました。脅威検出時にこのDMに通知が届きます。',
  en: '✅ EgressView — Slack notifications configured. You will receive a DM here when a threat is detected.',
};

const _NEW_DEVICE_MSG = {
  ja: {
    title:  (name, _ip) => `🆕 *新規デバイス検出* — ${name}`,
    ip:     (ip)       => `*IPアドレス:* ${ip}`,
    vendor: (v)        => `*ベンダー:* ${v}`,
    mac:    (m)        => `*MAC:* ${m}`,
    time:   (ts)       => `*検出時刻:* ${new Date(ts).toLocaleString('ja-JP')}`,
  },
  en: {
    title:  (name, _ip) => `🆕 *New Device Detected* — ${name}`,
    ip:     (ip)       => `*IP Address:* ${ip}`,
    vendor: (v)        => `*Vendor:* ${v}`,
    mac:    (m)        => `*MAC:* ${m}`,
    time:   (ts)       => `*Detected at:* ${new Date(ts).toLocaleString('en-US')}`,
  },
};

const _AI_NOTIFICATION_TITLE = {
  ja: {
    scheduled: '📅 *定期AIレポート*',
    threat: '🚨 *脅威変化のAI分析*',
    manual: '✦ *AIイベント分析*',
    test: '✅ *AIイベント通知テスト*',
  },
  en: {
    scheduled: '📅 *Scheduled AI report*',
    threat: '🚨 *AI threat-change analysis*',
    manual: '✦ *AI event analysis*',
    test: '✅ *AI event notification test*',
  },
};

async function sendAiNotification({ triggerType, text, generatedAt, language } = {}) {
  if (!_enabled || !_token || !_userId) return false;
  const lang = language === 'en' ? 'en' : 'ja';
  const title = _AI_NOTIFICATION_TITLE[lang][triggerType] || _AI_NOTIFICATION_TITLE[lang].manual;
  const time = new Date(generatedAt || Date.now()).toLocaleString(lang === 'en' ? 'en-US' : 'ja-JP');
  try {
    const result = await _httpPost({
      channel: _userId,
      text: `${title}\n${String(text || '').slice(0, 3500)}\n_${time}_`,
    }, _token);
    if (!result.ok) {
      logger.error('[notifier] AI notification Slack error:', result.error);
      return false;
    }
    return true;
  } catch (err) {
    logger.error('[notifier] AI notification Slack post failed:', err.message);
    return false;
  }
}

async function notifyNewDevice(entry) {
  let slackSent = false;

  if (_enabled && _token && _userId && _detection.newDevice.slack) {
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

  if (_logCallback) {
    _logCallback(entry, 'new_device', slackSent, { record: _detection.newDevice.history });
  }
  return slackSent;
}

const _LAN_SCAN_MSG = {
  ja: {
    title:   host => `🔎 *LAN内の探索を検出* — ${host}`,
    program: name => `*プログラム:* ${name}`,
    sweep:   (n, min, sample) => `*内容:* ${min}分間にLAN内の${n}個のアドレスへ接続しました（例: ${sample}）`,
    probe:   (target, n, min, sample) => `*内容:* ${min}分間に${target}の${n}個のポートへ接続しました（例: ${sample}）`,
    advice:  '*確認すること:* ブラウザの拡張機能や、最近入れたプログラムに心当たりが無いかを確認してください。',
    probedTitle: (source, host) => `🔎 *LAN内からの探索を検出* — ${source} → ${host}`,
    probed:  (source, host, n, proto, min, sample) => `*内容:* ${source}が${min}分間に、${host}の${proto.toUpperCase()}の${n}個のポートへ接続を試みました（例: ${sample}）`,
    probedAdvice: '*確認すること:* 送り元の機器（スマホなど）に、心当たりの無いアプリや設定が無いかを確認してください。',
    time:    ts => `*検出時刻:* ${new Date(ts).toLocaleString('ja-JP')}`,
  },
  en: {
    title:   host => `🔎 *LAN scanning detected* — ${host}`,
    program: name => `*Program:* ${name}`,
    sweep:   (n, min, sample) => `*What happened:* connected to ${n} LAN addresses in ${min} minutes (e.g. ${sample})`,
    probe:   (target, n, min, sample) => `*What happened:* connected to ${n} ports on ${target} in ${min} minutes (e.g. ${sample})`,
    advice:  '*What to check:* browser extensions, and any program installed recently.',
    probedTitle: (source, host) => `🔎 *Probing from the LAN detected* — ${source} → ${host}`,
    probed:  (source, host, n, proto, min, sample) => `*What happened:* ${source} tried ${n} ${proto.toUpperCase()} ports on ${host} in ${min} minutes (e.g. ${sample})`,
    probedAdvice: '*What to check:* the sending device (a phone, say) for apps or settings you do not recognise.',
    time:    ts => `*Detected at:* ${new Date(ts).toLocaleString('en-US')}`,
  },
};

function lanScanSummary(finding) {
  return JSON.stringify({
    kind: finding.kind,
    protocol: finding.networkProtocol || null,
    host: finding.hostName || null,
    addresses: finding.addresses,
    ports: finding.ports,
    target: finding.target || null,
    windowMs: finding.windowMs,
    sample: finding.sample || [],
  });
}

/**
 * A program on an Agent's computer probing the LAN (lan-scan-detector.js).
 * The history row keeps the computer as the source and the details as a small
 * JSON summary in threatTag, which the notification log renders per language.
 */
async function notifyLanScan(finding) {
  let slackSent = false;
  const minutes = Math.max(1, Math.round((finding.windowMs || 120000) / 60000));
  const detectedAt = (finding.windowStart || Date.now()) + (finding.windowMs || 0);
  if (_enabled && _token && _userId && _detection.lanScan.slack) {
    const L = _LAN_SCAN_MSG[_language] || _LAN_SCAN_MSG.ja;
    const sample = (finding.sample || []).join(', ');
    const host = finding.hostName || finding.localAddress || '?';
    const lines = (finding.kind === 'probed' ? [
      L.probedTitle(finding.sourceAddress, host),
      L.probed(finding.sourceAddress, host, finding.ports, finding.networkProtocol || 'tcp', minutes, sample),
      L.probedAdvice,
      L.time(detectedAt),
    ] : [
      L.title(host),
      L.program(finding.processName || '?'),
      finding.kind === 'port-probe'
        ? L.probe(finding.target, finding.ports, minutes, sample)
        : L.sweep(finding.addresses, minutes, sample),
      L.advice,
      L.time(detectedAt),
    ]).join('\n');
    try {
      const result = await _httpPost({ channel: _userId, text: lines }, _token);
      if (!result.ok) logger.error('[notifier] lan-scan Slack error:', result.error);
      else slackSent = true;
    } catch (err) {
      logger.error('[notifier] notifyLanScan failed:', err.message);
    }
  }
  if (_logCallback) {
    // Probed: the sender is the source and the probed computer the
    // destination, so the history row names the device to look at.
    const probed = finding.kind === 'probed';
    _logCallback({
      src: probed ? finding.sourceAddress : (finding.localAddress || null),
      srcDnsName: probed ? null : (finding.hostName || null),
      dst: probed || finding.kind === 'port-probe' ? finding.target : null,
      dstHost: probed ? (finding.hostName || null) : null,
      proto: probed ? (finding.networkProtocol || null) : null,
      threat: { source: finding.processName || null, tag: lanScanSummary(finding), confidence: null },
      lastSeen: detectedAt,
    }, 'lan_scan', slackSent, { record: _detection.lanScan.history });
  }
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
  token ||= _token;
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
  token ||= _token;
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

module.exports = {
  notifyLanScan,
  configure,
  getConfig,
  notify,
  notifyNewDevice,
  configureDetection,
  getDetectionConfig,
  sendAiNotification,
  setLogCallback,
  test,
  verifyToken,
  lookupUser,
  _buildMessage,
  _setHttpPost,
  _resetCooldown,
  _resetLogCallback,
};
