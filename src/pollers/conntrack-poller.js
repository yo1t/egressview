'use strict';

const crypto = require('crypto');
const { Client: SshClient } = require('ssh2');
const logger = require('../logger');
const { abortError, attachAbortHandler } = require('./abort-signal');
const {
  ACQUISITION_COMMANDS,
  classifyConntrackOutput,
  isPrivateIpv4,
  parseConntrack,
} = require('./conntrack');

const SSH_ALGORITHMS = Object.freeze({
  kex: [
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1',
  ],
});
const ARP_REFRESH_MS = 5 * 60 * 1000;
const NDP_REFRESH_MS = 10 * 60 * 1000;

function hostFingerprint(hashedKey) {
  if (Buffer.isBuffer(hashedKey)) return hashedKey.toString('hex');
  const value = String(hashedKey || '');
  return /^[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : crypto.createHash('sha256').update(value).digest('hex');
}

function parseIpNeighbors(text, family) {
  const result = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([^\s]+)\s+dev\s+\S+(?:\s+lladdr\s+([0-9a-f:]{17}))?/i);
    if (!match?.[2]) continue;
    const ip = match[1].toLowerCase();
    const isV6 = ip.includes(':');
    if ((family === 6) !== isV6 || (isV6 && ip.startsWith('fe80:'))) continue;
    result.set(ip, match[2].toLowerCase());
  }
  return result;
}

function ndpByMac(neighbors) {
  const result = new Map();
  for (const [ip, mac] of neighbors) {
    if (!result.has(mac)) result.set(mac, []);
    result.get(mac).push(ip);
  }
  return result;
}

function parseLanIp(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\//);
    if (match && isPrivateIpv4(match[1]) && !match[1].startsWith('127.')) return match[1];
  }
  return '';
}

function createConntrackPoller({
  id = '',
  Client = SshClient,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const tag = `[conntrack${id ? `:${id}` : ''}]`;
  let config = {};
  let connection = null;
  let ready = false;
  let reconnectTimer = null;
  let manualClose = false;
  let arpCache = new Map();
  let ndpCache = new Map();
  let arpRefreshedAt = 0;
  let ndpRefreshedAt = 0;

  function status(state, message = '') {
    config.onStatus?.({ ready: state === 'ready', state, message });
  }

  function configure(next = {}) {
    config = { ...config, ...next, port: Number(next.port || config.port || 22) };
  }

  function sshOptions({ expectedHostFp = config.hostFp, onFingerprint } = {}) {
    return {
      host: config.ip,
      port: config.port || 22,
      username: config.user,
      password: config.pass,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: key => {
        const fingerprint = hostFingerprint(key);
        if (expectedHostFp && fingerprint !== expectedHostFp) {
          logger.error(`${tag} Host key mismatch`);
          return false;
        }
        if (!expectedHostFp) {
          try { onFingerprint?.(fingerprint); }
          catch (error) {
            logger.error(`${tag} Host key persistence failed: ${error.message}`);
            return false;
          }
        }
        return true;
      },
      algorithms: SSH_ALGORITHMS,
    };
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (manualClose || !config.enabled || reconnectTimer) return;
    status('reconnecting', 'SSH connection lost');
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, 5_000);
  }

  function connect(onReady) {
    if (!config.enabled || connection) return;
    manualClose = false;
    status('connecting');
    const conn = new Client();
    connection = conn;
    let capturedFp = config.hostFp || '';
    conn.once('ready', () => {
      if (connection !== conn) return;
      ready = true;
      clearReconnect();
      if (!config.hostFp && capturedFp) {
        const previous = config.hostFp;
        config.hostFp = capturedFp;
        try { config.onSaveConfig?.(); }
        catch (error) {
          config.hostFp = previous;
          ready = false;
          manualClose = true;
          status('error', error.message);
          conn.end();
          return;
        }
      }
      status('ready');
      onReady?.();
    });
    conn.on('error', error => {
      if (connection === conn) status('error', error.message);
    });
    conn.on('close', () => {
      if (connection !== conn) return;
      connection = null;
      ready = false;
      scheduleReconnect();
    });
    try {
      conn.connect(sshOptions({ onFingerprint: fp => { capturedFp = fp; } }));
    } catch (error) {
      connection = null;
      status('error', error.message);
      scheduleReconnect();
    }
  }

  function disconnect() {
    manualClose = true;
    clearReconnect();
    ready = false;
    const conn = connection;
    connection = null;
    try { conn?.end(); } catch {}
  }

  function reconnect() {
    const shouldReconnect = !!config.enabled;
    disconnect();
    manualClose = false;
    if (shouldReconnect) connect();
  }

  function exec(command, { signal, timeoutMs = 15_000, conn = connection } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      if (!conn || (conn === connection && !ready)) return reject(new Error('router not connected'));
      let settled = false;
      let stream = null;
      let stdout = '';
      let stderr = '';
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        detachAbort();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimer(() => {
        try { stream?.close(); } catch {}
        finish(new Error(`SSH command timeout: ${command}`));
      }, timeoutMs);
      const detachAbort = attachAbortHandler(signal, error => {
        try { stream?.close(); } catch {}
        finish(error);
      });
      conn.exec(command, (error, channel) => {
        if (error) return finish(error);
        stream = channel;
        channel.on('data', chunk => { stdout += chunk.toString('utf8'); });
        channel.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
        channel.on('error', finish);
        channel.on('close', code => {
          const output = `${stdout}${stderr}`;
          if (code && !output) finish(new Error(`SSH command failed (${code}): ${command}`));
          else finish(null, output);
        });
      });
    });
  }

  async function fetchSessions({ signal } = {}) {
    const failures = [];
    for (const command of ACQUISITION_COMMANDS) {
      signal?.throwIfAborted();
      const output = await exec(command, { signal });
      const classification = classifyConntrackOutput(output);
      if (classification === 'supported' || classification === 'empty') return parseConntrack(output);
      failures.push(`${command}: ${classification}`);
    }
    throw new Error(`conntrack is unavailable (${failures.join('; ')})`);
  }

  async function refreshArp({ signal } = {}) {
    arpCache = parseIpNeighbors(await exec('ip -4 neigh show', { signal }), 4);
    arpRefreshedAt = Date.now();
    return arpCache;
  }

  async function refreshNdp({ signal } = {}) {
    ndpCache = ndpByMac(parseIpNeighbors(await exec('ip -6 neigh show', { signal }), 6));
    ndpRefreshedAt = Date.now();
    return ndpCache;
  }

  function temporaryConnection(input) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let capturedFp = input.expectedHostFp || '';
      const cleanup = () => { try { conn.removeAllListeners(); conn.end(); } catch {} };
      conn.once('ready', () => resolve({ conn, capturedFp, cleanup }));
      conn.once('error', error => { cleanup(); reject(error); });
      const previous = config;
      config = { ...input, port: Number(input.port || 22) };
      try { conn.connect(sshOptions({ expectedHostFp: input.expectedHostFp, onFingerprint: fp => { capturedFp = fp; } })); }
      catch (error) { cleanup(); reject(error); }
      finally { config = previous; }
    });
  }

  async function detect(input) {
    const temp = await temporaryConnection(input);
    try {
      const localExec = (command, options = {}) => exec(command, { ...options, conn: temp.conn });
      const failures = [];
      let sessions = null;
      let command = '';
      for (const candidate of ACQUISITION_COMMANDS) {
        const output = await localExec(candidate);
        const classification = classifyConntrackOutput(output);
        if (classification === 'supported' || classification === 'empty') {
          sessions = parseConntrack(output);
          command = candidate;
          break;
        }
        failures.push(`${candidate}: ${classification}`);
      }
      if (!sessions) throw new Error(`conntrack is unavailable (${failures.join('; ')})`);
      const lanIp = parseLanIp(await localExec('ip -o -4 addr show scope global'));
      return {
        ssh: { ok: true, hostFp: temp.capturedFp },
        lan: { ok: !!lanIp, ip: lanIp },
        nat: { ok: true, sessionsOk: true, sessions: sessions.length },
        conntrack: { ok: true, command, sessions: sessions.length },
      };
    } finally {
      temp.cleanup();
    }
  }

  async function detectCurrent() {
    const sessions = await fetchSessions();
    const lanIp = parseLanIp(await exec('ip -o -4 addr show scope global'));
    return {
      ssh: { ok: true, hostFp: config.hostFp || '' },
      lan: { ok: !!lanIp, ip: lanIp },
      nat: { ok: true, sessionsOk: true, sessions: sessions.length },
      conntrack: { ok: true, sessions: sessions.length },
    };
  }

  return {
    configure,
    connect,
    disconnect,
    reconnect,
    isEnabled: () => !!config.enabled,
    isReady: () => ready,
    fetchSessions,
    refreshArp,
    refreshNdp,
    needsArpRefresh: () => Date.now() - arpRefreshedAt >= ARP_REFRESH_MS,
    needsNdpRefresh: () => Date.now() - ndpRefreshedAt >= NDP_REFRESH_MS,
    getArpCache: () => arpCache,
    getArpMac: ip => arpCache.get(ip) || null,
    getNdpByMac: mac => ndpCache.get(String(mac || '').toLowerCase()) || [],
    getIp: () => config.ip || '',
    getUser: () => config.user || '',
    hasPass: () => !!config.pass,
    getNat: () => null,
    getHostFp: () => config.hostFp || '',
    exec,
    detect,
    detectCurrent,
  };
}

module.exports = {
  createConntrackPoller,
  hostFingerprint,
  ndpByMac,
  parseIpNeighbors,
  parseLanIp,
};
