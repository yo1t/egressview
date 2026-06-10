// Yamaha RTX SSH poller: connect, execute commands, parse NAT sessions
'use strict';
const logger = require('../logger');

const crypto = require('crypto');
const { Client: SshClient } = require('ssh2');

let yamahaShell   = null;
let yamahaConn    = null;
let yamahaReady   = false;
let shellBuf      = '';
let yamahaReconnectTimer = null;
let yamahaConnecting = false;
let shellResolve  = null;

// Yamaha ARP table cache (IP -> MAC)
const yamahaArpCache = new Map();
let yamahaArpLastRefresh = 0;
const YAMAHA_ARP_REFRESH_MS = 60 * 1000;

// Config (set externally via configure())
let yamahaIp = '';
let yamahaUser = '';
let yamahaPass = '';
let yamahaEnabled = true;
let yamahaHostFp = '';
let natDescriptor = '100';

// Callbacks (set externally)
let onStatus = () => {};
let onSaveConfig = () => {};

function configure(cfg) {
  if (cfg.ip !== undefined) yamahaIp = cfg.ip;
  if (cfg.user !== undefined) yamahaUser = cfg.user;
  if (cfg.pass !== undefined) yamahaPass = cfg.pass;
  if (cfg.enabled !== undefined) yamahaEnabled = cfg.enabled;
  if (cfg.hostFp !== undefined) yamahaHostFp = cfg.hostFp;
  if (cfg.natDescriptor !== undefined) natDescriptor = cfg.natDescriptor;
  if (cfg.onStatus) onStatus = cfg.onStatus;
  if (cfg.onSaveConfig) onSaveConfig = cfg.onSaveConfig;
}

function parseNatDetail(text) {
  const sessions = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(TCP|UDP|ICMP|GRE)\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)/);
    if (!m) continue;
    const [, proto, srcRaw, dstRaw, ttl] = m;
    if (dstRaw.includes('*')) continue;
    const splitAddr = s => { const p = s.lastIndexOf('.'); return [s.slice(0, p), parseInt(s.slice(p + 1))]; };
    const [src, sport] = splitAddr(srcRaw);
    const [dst, dport] = splitAddr(dstRaw);
    if (!src.startsWith('192.168.') && !src.startsWith('10.')) continue;
    sessions.push({ proto, src, sport, dst, dport, ttl: parseInt(ttl) });
  }
  return sessions;
}

function waitForPrompt(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (shellBuf.endsWith('> ')) { resolve(shellBuf); return; }
    shellResolve = resolve;
    setTimeout(() => { shellResolve = null; reject(new Error('SSH timeout')); }, timeoutMs);
  });
}

async function yamahaExec(cmd) {
  if (!yamahaReady || !yamahaShell) throw new Error('Yamaha not connected');
  shellBuf = '';
  yamahaShell.write(cmd + '\n');
  await waitForPrompt();
  return shellBuf;
}

function scheduleYamahaReconnect(ms) {
  if (yamahaReconnectTimer) { clearTimeout(yamahaReconnectTimer); }
  if (!yamahaEnabled) return;
  yamahaReconnectTimer = setTimeout(() => {
    yamahaReconnectTimer = null;
    connectYamaha();
  }, ms);
}

function connectYamaha(onReady) {
  if (!yamahaEnabled) return;
  if (!yamahaIp || !yamahaUser || !yamahaPass) {
    logger.info('[yamaha] credentials not configured yet — skip connect');
    return;
  }
  if (yamahaConnecting) {
    logger.info('[yamaha] Connect already in progress, skip');
    return;
  }
  if (yamahaReconnectTimer) { clearTimeout(yamahaReconnectTimer); yamahaReconnectTimer = null; }
  if (yamahaConn) { try { yamahaConn.removeAllListeners(); yamahaConn.end(); } catch {} yamahaConn = null; }
  yamahaReady = false;
  yamahaShell = null;
  yamahaConnecting = true;

  const conn = new SshClient();
  yamahaConn = conn;

  conn.on('ready', () => {
    conn.shell({ term: 'vt100', cols: 220, rows: 500 }, (err, stream) => {
      if (err) {
        logger.error('[yamaha] shell error:', err.message);
        yamahaConnecting = false;
        onStatus({ ready: false, message: 'シェル要求失敗: ' + err.message });
        scheduleYamahaReconnect(5000);
        return;
      }
      yamahaShell = stream;

      stream.on('data', chunk => {
        const text = chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        shellBuf += text;
        if (text.includes('---')) stream.write(' ');
        if (shellBuf.endsWith('> ') && shellResolve) {
          const r = shellResolve;
          shellResolve = null;
          r(shellBuf);
        }
      });

      stream.on('close', () => {
        yamahaReady = false;
        yamahaConnecting = false;
        logger.info('[yamaha] Shell closed, reconnecting in 3s…');
        scheduleYamahaReconnect(3000);
      });

      setTimeout(async () => {
        try {
          await waitForPrompt(8000);
          shellBuf = '';
          stream.write('console lines 0\n');
          await waitForPrompt(5000);
          yamahaReady = true;
          yamahaConnecting = false;
          logger.info('[yamaha] Connected to RTX — ready');
          onStatus({ ready: true, message: '接続済み' });
          if (onReady) onReady();
        } catch (e) {
          yamahaConnecting = false;
          logger.error('[yamaha] init error:', e.message);
          onStatus({ ready: false, message: '初期化失敗: ' + e.message });
          scheduleYamahaReconnect(5000);
        }
      }, 500);
    });
  });

  conn.on('error', err => {
    logger.error('[yamaha] SSH error:', err.message);
    yamahaReady = false;
    yamahaConnecting = false;
    onStatus({ ready: false, message: 'SSH接続失敗: ' + err.message });
    scheduleYamahaReconnect(5000);
  });

  const hostVerifier = (hashedKey) => {
    const fp = Buffer.isBuffer(hashedKey)
      ? hashedKey.toString('hex')
      : crypto.createHash('sha256').update(hashedKey).digest('hex');
    if (!yamahaHostFp) {
      yamahaHostFp = fp;
      onSaveConfig();
      logger.info('[yamaha] Host key recorded (TOFU):', fp.substring(0, 16) + '...');
      return true;
    }
    if (fp !== yamahaHostFp) {
      logger.error('[yamaha] ⚠️ HOST KEY MISMATCH! Possible MITM attack.');
      logger.error(`  Expected: ${yamahaHostFp.substring(0, 16)}...`);
      logger.error(`  Got:      ${fp.substring(0, 16)}...`);
      logger.error('  鍵を更新する場合は .widemap.json の yamaha.hostFp を削除してください');
      return false;
    }
    return true;
  };

  conn.connect({
    host: yamahaIp, port: 22,
    username: yamahaUser, password: yamahaPass,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    hostHash: 'sha256',
    hostVerifier,
    algorithms: { kex: ['curve25519-sha256@libssh.org','ecdh-sha2-nistp256',
                         'diffie-hellman-group14-sha256','diffie-hellman-group14-sha1'] },
  });
}

async function refreshYamahaArp() {
  if (!yamahaEnabled || !yamahaReady) return;
  try {
    const raw = await yamahaExec('show arp');
    const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/g;
    const newMap = new Map();
    let m;
    while ((m = re.exec(raw)) !== null) {
      newMap.set(m[1], m[2].toLowerCase());
    }
    yamahaArpCache.clear();
    for (const [k, v] of newMap) yamahaArpCache.set(k, v);
    yamahaArpLastRefresh = Date.now();
    logger.info(`[yamaha-arp] cache refreshed: ${newMap.size} entries`);
  } catch (e) {
    logger.error('[yamaha-arp] refresh failed:', e.message);
  }
}

async function fetchNatSessions() {
  const raw = await yamahaExec(`show nat descriptor address ${natDescriptor} detail`);
  return parseNatDetail(raw);
}

// IPv6 NDP cache: MAC → IPv6 address(es)
const yamahaNdpCache = new Map(); // mac → [ipv6, ...]
let yamahaNdpLastRefresh = 0;
const YAMAHA_NDP_REFRESH_MS = 120 * 1000; // every 2 min

async function refreshYamahaNdp() {
  if (!yamahaEnabled || !yamahaReady) return;
  try {
    const raw = await yamahaExec('show ipv6 neighbor cache');
    const newMap = new Map();
    // Parse lines like: "240d:1a:55e:ed00:5de6:a5c8:44fb:a1e5    6c:99:9d:88:88:a0 LAN1  REACHABLE"
    const re = /([0-9a-fA-F:]{6,45})\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+LAN1\s+\w+/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const ipv6 = m[1];
      const mac = m[2].toLowerCase();
      // Skip link-local (fe80::)
      if (ipv6.startsWith('fe80:')) continue;
      if (!newMap.has(mac)) newMap.set(mac, []);
      newMap.get(mac).push(ipv6);
    }
    yamahaNdpCache.clear();
    for (const [k, v] of newMap) yamahaNdpCache.set(k, v);
    yamahaNdpLastRefresh = Date.now();
    logger.info(`[yamaha-ndp] cache refreshed: ${newMap.size} entries`);
  } catch (e) {
    logger.error('[yamaha-ndp] refresh failed:', e.message);
  }
}

function getNdpByMac(mac) {
  if (!mac) return null;
  return yamahaNdpCache.get(mac.toLowerCase()) || null;
}

function needsNdpRefresh() { return Date.now() - yamahaNdpLastRefresh > YAMAHA_NDP_REFRESH_MS; }

function disconnect() {
  yamahaEnabled = false;
  yamahaReady = false;
  yamahaConnecting = false;
  if (yamahaReconnectTimer) { clearTimeout(yamahaReconnectTimer); yamahaReconnectTimer = null; }
  if (yamahaConn) { try { yamahaConn.removeAllListeners(); yamahaConn.end(); } catch {} yamahaConn = null; }
}

function reconnect() {
  yamahaReady = false;
  yamahaConnecting = false;
  if (yamahaConn) { try { yamahaConn.removeAllListeners(); yamahaConn.end(); } catch {} yamahaConn = null; }
  scheduleYamahaReconnect(500);
}

function getArpCache() { return yamahaArpCache; }
function getArpMac(ip) { return yamahaArpCache.get(ip) || null; }
function isReady() { return yamahaReady; }
function isEnabled() { return yamahaEnabled; }
function getIp() { return yamahaIp; }
function getUser() { return yamahaUser; }
function hasPass() { return !!yamahaPass; }
function getNat() { return natDescriptor; }
function getHostFp() { return yamahaHostFp; }
function needsArpRefresh() { return Date.now() - yamahaArpLastRefresh > YAMAHA_ARP_REFRESH_MS; }

module.exports = {
  configure,
  connectYamaha,
  disconnect,
  reconnect,
  yamahaExec,
  parseNatDetail,
  refreshYamahaArp,
  refreshYamahaNdp,
  fetchNatSessions,
  getArpCache,
  getArpMac,
  getNdpByMac,
  isReady,
  isEnabled,
  getIp,
  getUser,
  hasPass,
  getNat,
  getHostFp,
  needsArpRefresh,
  needsNdpRefresh,
};
