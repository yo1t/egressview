// ASUS router poller: authentication, client list, netdev, mesh nodes
'use strict';
const logger = require('../logger');

const axios = require('axios');
const crypto = require('crypto');

let authToken = null;
let tokenExpiry = 0;
let routerIp = '192.168.1.1';
let asusEnabled = false;
let lastAsusUser = '';
let lastAsusPass = '';
let pollTimer = null;
let prevNetdev = {};
let prevPollTime = Date.now();
let latestAsusClients = [];
let asusRenewFailures = 0;
const ASUS_RENEW_MAX_FAILURES = 3;
// Transient errors (EPIPE, ECONNRESET, etc.) are common on home routers.
// Only surface to the UI after this many consecutive failures to avoid noise.
let consecutivePollErrors = 0;
const POLL_ERROR_THRESHOLD = 3;

// Callbacks
let onAuthRequired = () => {};
let onPollError = () => {};
let onNetworkUpdate = () => {};
let onSaveConfig = () => {};
let lookupVendorFn = () => '';
let getNodeMetaFn = () => ({ vendor: null, dnsName: null, mdnsName: null });

function configure(cfg) {
  if (cfg.routerIp !== undefined) routerIp = cfg.routerIp;
  if (cfg.enabled !== undefined) asusEnabled = cfg.enabled;
  if (cfg.user !== undefined) lastAsusUser = cfg.user;
  if (cfg.pass !== undefined) lastAsusPass = cfg.pass;
  if (cfg.onAuthRequired) onAuthRequired = cfg.onAuthRequired;
  if (cfg.onPollError) onPollError = cfg.onPollError;
  if (cfg.onNetworkUpdate) onNetworkUpdate = cfg.onNetworkUpdate;
  if (cfg.onSaveConfig) onSaveConfig = cfg.onSaveConfig;
  if (cfg.lookupVendor) lookupVendorFn = cfg.lookupVendor;
  if (cfg.getNodeMeta) getNodeMetaFn = cfg.getNodeMeta;
}

// SHA256 login with the ASUS router
async function loginToRouter(ip, username, password) {
  const base = `http://${ip}`;

  const id = crypto.randomBytes(5).toString('hex');
  const nonceRes = await axios.post(`${base}/get_Nonce.cgi`, JSON.stringify({ id }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  const nonce = nonceRes.data?.nonce;
  if (!nonce) throw new Error('ノンス取得失敗 — ルーターIPを確認してください');

  const cnonce = crypto.randomBytes(16).toString('hex');
  const loginAuth = crypto
    .createHash('sha256')
    .update(`${username}:${nonce}:${password}:${cnonce}`)
    .digest('hex');

  const params = new URLSearchParams({
    login_authorization: loginAuth,
    id,
    cnonce,
    login_captcha: '',
    action_mode: '',
    action_script: '',
    action_wait: '5',
    current_page: 'Main_Login.asp',
    next_page: '',
  });

  const res = await axios.post(`${base}/login_v2.cgi`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 8000,
    maxRedirects: 0,
    validateStatus: s => true,
  });

  const cookies = res.headers['set-cookie'] || [];
  for (const c of cookies) {
    const m = c.match(/asus_token=([^;]+)/);
    if (m && m[1] !== 'deleted') return m[1];
  }

  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (body.includes('index.asp')) return null;
  throw new Error('ユーザー名またはパスワードが違います');
}

async function apiGet(hook) {
  const base = `http://${routerIp}`;
  const res = await axios.get(`${base}/appGet.cgi`, {
    params: { hook },
    headers: {
      Cookie: `asus_token=${authToken}`,
      Referer: `http://${routerIp}/index.asp`,
    },
    timeout: 8000,
  });
  const data = typeof res.data === 'string' ? (() => {
    try { return JSON.parse(res.data); } catch { return res.data; }
  })() : res.data;

  if (typeof data === 'string' && data.includes('Main_Login')) {
    throw new Error('TOKEN_EXPIRED');
  }
  return data;
}

function parseClientList(raw) {
  const src = raw?.get_clientlist || raw;
  if (!src || typeof src !== 'object') return [];
  return Object.entries(src)
    .filter(([mac, info]) => mac !== 'maclist' && mac !== 'ClientAPILevel' && typeof info === 'object')
    .map(([mac, info]) => {
      const isWL = info.isWL;
      const connType = (isWL !== undefined && isWL !== null && isWL !== '')
        ? String(isWL) : String(info.type || '0');
      return {
        mac,
        ip: info.ip || '',
        name: info.nickName || info.name || mac,
        type: connType,
        isOnline: info.isOnline === '1' || info.isOnline === 1,
        rssi: parseInt(info.rssi || '0'),
        curRx: parseFloat(info.curRx || '0'),
        curTx: parseFloat(info.curTx || '0'),
        totalRx: parseInt(info.totalRx || '0'),
        totalTx: parseInt(info.totalTx || '0'),
        ipMethod: info.ipMethod || 'dhcp',
        internetMode: info.internetMode || 'allow',
        amesh_papMac: info.amesh_papMac || '',
        vendor: info.vendor || lookupVendorFn(mac),
      };
    })
    .filter(c => c.isOnline);
}

function computeRates(clients) {
  return clients.map(c => ({
    ...c,
    rxRate: (parseFloat(c.curRx) || 0) * 1024,
    txRate: (parseFloat(c.curTx) || 0) * 1024,
  }));
}

function parseNetdev(raw) {
  const nd = raw?.netdev || {};
  const dt = Math.max((Date.now() - prevPollTime) / 1000, 0.1);
  const result = {};
  for (const [key, val] of Object.entries(nd)) {
    const bytes = parseInt(val || '0', 16);
    const prev = prevNetdev[key] ?? bytes;
    result[key] = { bytes, rate: Math.max(0, bytes - prev) / dt };
    prevNetdev[key] = bytes;
  }
  return result;
}

function parseMeshNodes(raw) {
  return (raw?.get_cfg_clientlist || []).map(n => ({
    mac: n.mac,
    ip: n.ip,
    model: n.ui_model_name || n.model_name || 'AiMesh Node',
    alias: n.alias || n.mac,
    online: n.online === '1',
  }));
}

async function ensureAsusAuth() {
  if (authToken && Date.now() < tokenExpiry) return true;
  if (!asusEnabled || !lastAsusUser || !lastAsusPass) return false;
  try {
    const token = await loginToRouter(routerIp, lastAsusUser, lastAsusPass);
    authToken = token;
    tokenExpiry = Date.now() + 25 * 60 * 1000;
    asusRenewFailures = 0;
    logger.info('[auth] ASUS token auto-renewed');
    return true;
  } catch (e) {
    asusRenewFailures++;
    logger.error(`[auth] ASUS auto-renew failed (${asusRenewFailures}/${ASUS_RENEW_MAX_FAILURES}):`, e.message);
    if (asusRenewFailures >= ASUS_RENEW_MAX_FAILURES) {
      onAuthRequired('ASUSの自動再認証に失敗しました。設定から再ログインしてください。');
      stopPolling();
    }
    return false;
  }
}

async function poll() {
  if (!await ensureAsusAuth()) return;
  try {
    const now = Date.now();
    const [clientRaw, netdevRaw, meshRaw] = await Promise.all([
      apiGet('get_clientlist()'),
      apiGet('netdev()'),
      apiGet('get_cfg_clientlist()'),
    ]);
    const clients = parseClientList(clientRaw);
    const withRates = computeRates(clients);
    latestAsusClients = withRates;
    for (const c of withRates) {
      const meta = getNodeMetaFn(c.ip, c.mac);
      c.vendor   = c.vendor || meta.vendor;
      c.dnsName  = meta.dnsName;
      c.mdnsName = meta.mdnsName;
    }
    const netdev = parseNetdev(netdevRaw);
    const meshNodes = parseMeshNodes(meshRaw);
    prevPollTime = now;

    onNetworkUpdate({
      timestamp: now,
      routerIp,
      clients: withRates,
      netdev,
      meshNodes,
      wanRx: netdev['WIRED_rx']?.rate ?? 0,
      wanTx: netdev['WIRED_tx']?.rate ?? 0,
    });
    consecutivePollErrors = 0;
  } catch (err) {
    if (err.message === 'TOKEN_EXPIRED') {
      logger.info('[poll] Token expired, requiring re-login');
      authToken = null;
      consecutivePollErrors = 0;
      onAuthRequired('セッションが切れました。再ログインしてください。');
      stopPolling();
    } else {
      consecutivePollErrors++;
      logger.warn(`[poll error] (${consecutivePollErrors}/${POLL_ERROR_THRESHOLD})`, err.message);
      if (consecutivePollErrors >= POLL_ERROR_THRESHOLD) {
        onPollError(err.message);
      }
    }
  }
}

function startPolling(intervalMs) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, intervalMs);
  poll();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Login action (called from API route)
async function login(ip, username, password) {
  const token = await loginToRouter(ip, username, password);
  authToken = token;
  tokenExpiry = Date.now() + 25 * 60 * 1000;
  routerIp = ip;
  asusEnabled = true;
  lastAsusUser = username;
  lastAsusPass = password;
  prevNetdev = {};
  prevPollTime = Date.now();
  return token;
}

function disable() {
  authToken = null;
  asusEnabled = false;
  stopPolling();
}

function getClients() { return latestAsusClients; }
function getClientMac(ip) {
  const c = latestAsusClients.find(cl => cl.ip === ip);
  return c?.mac || null;
}
function isEnabled() { return asusEnabled; }
function isAuthenticated() { return !!authToken && Date.now() < tokenExpiry; }
function getRouterIp() { return routerIp; }
function getUser() { return lastAsusUser; }
function hasPass() { return !!lastAsusPass; }

module.exports = {
  configure,
  loginToRouter,
  login,
  disable,
  startPolling,
  stopPolling,
  poll,
  parseClientList,
  computeRates,
  parseNetdev,
  parseMeshNodes,
  apiGet,
  getClients,
  getClientMac,
  isEnabled,
  isAuthenticated,
  getRouterIp,
  getUser,
  hasPass,
};
