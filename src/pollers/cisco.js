// Cisco IOS SSH poller: connect, execute commands, parse NAT sessions
//
// P2-30 PR 1: all mutable state (SSH connection, shell buffer, caches,
// config, timers) lives inside createCiscoPoller() so multiple router
// instances can coexist. The module still exports a default instance plus
// the pure parsers, so existing require('./cisco') callers are unchanged.
'use strict';
const logger = require('../logger');
const { t } = require('../i18n-server');

const crypto = require('crypto');
const { Client: SshClient } = require('ssh2');

// Prompt classifiers and the enable-mode handshake state machine live in a
// separate, pure module so they can be unit-tested without a real device (P2-24).
const {
  looksLikeShellPrompt,
  looksLikePagerPrompt,
  isPrivilegeError,
  runEnableHandshake,
} = require('./cisco-session');
const { abortError, attachAbortHandler } = require('./abort-signal');
const { extractCiscoHostName } = require('./router-prompt');

const CISCO_INITIAL_PROMPT_TIMEOUT_MS = 8_000;

// ── Parsers (pure, shared by all instances) ───────────────────────────────────

// Convert Cisco dot-notation MAC (aabb.cc11.0200) to colon notation (aa:bb:cc:11:02:00)
function dotMacToColon(mac) {
  const hex = mac.replace(/\./g, '');
  if (hex.length !== 12) return mac;
  return hex.match(/.{2}/g).join(':');
}

// Protocol-based default TTL (seconds) used when Cisco doesn't report remaining TTL
const PROTO_DEFAULT_TTL = { TCP: 86400, UDP: 300, ICMP: 60 };

// Parse a Cisco uptime-style age ("00:01:13", "1d02h", "2w3d", "1y23w") into
// seconds. Returns null for unknown formats and "never".
function parseCiscoAge(str) {
  const s = String(str || '').trim();
  let m;
  if ((m = s.match(/^(\d+):(\d{2}):(\d{2})$/)))
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  if ((m = s.match(/^(\d+)d(\d+)h$/)))
    return (+m[1]) * 86400 + (+m[2]) * 3600;
  if ((m = s.match(/^(\d+)w(\d+)d$/)))
    return (+m[1]) * 604800 + (+m[2]) * 86400;
  if ((m = s.match(/^(\d+)y(\d+)w$/)))
    return (+m[1]) * 31536000 + (+m[2]) * 604800;
  return null;
}

function parseNatTranslations(text, now = Date.now()) {
  const sessions = [];
  for (const line of String(text || '').split('\n')) {
    // Match: tcp/udp/icmp  WAN:port  LAN:port  ext-local:port  ext-global:port
    const m = line.match(
      /^\s*(tcp|udp|icmp)\s+\S+?:(\d+)\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/i
    );
    if (m) {
      const proto = m[1].toUpperCase();
      const src   = m[3];
      const sport = parseInt(m[4], 10);
      const dst   = m[5];
      const dport = parseInt(m[6], 10);
      const ttl   = PROTO_DEFAULT_TTL[proto] ?? 300;
      sessions.push({ proto, src, sport, dst, dport, ttl });
      continue;
    }
    // Verbose mode detail line for the entry above, e.g.:
    //   "create 00:01:13, use 00:00:50 timeout:86400000, left 23:59:09, ..."
    // "create" backdates firstSeen; "left" replaces the protocol-default TTL.
    const last = sessions[sessions.length - 1];
    if (!last) continue;
    const createM = line.match(/\bcreate[:\s]+([\w:]+)/i);
    if (createM) {
      const age = parseCiscoAge(createM[1]);
      if (age !== null) last.firstSeenHint = now - age * 1000;
    }
    const leftM = line.match(/\bleft[:\s]+([\w:]+)/i);
    if (leftM) {
      const left = parseCiscoAge(leftM[1]);
      if (left !== null) last.ttl = left;
    }
  }
  return sessions;
}

function parseArp(text) {
  // Cisco format: "Internet  192.168.1.10  5  aabb.cc11.0200  ARPA  Gi0/1"
  const re = /^Internet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+[\d-]+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})/gm;
  const result = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    result.set(m[1], dotMacToColon(m[2]));
  }
  return result;
}

function parseNdpNeighbors(text) {
  // "2001:DB8:1::10   5  aabb.cc11.0200  STALE  Gi0/1"
  const re = /^([0-9a-fA-F:]{4,45})\s+\d+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+\w+/gm;
  const result = new Map(); // mac → [ipv6]
  let m;
  while ((m = re.exec(text)) !== null) {
    const ipv6 = m[1].toLowerCase();
    if (ipv6.startsWith('fe80:')) continue; // skip link-local
    const mac  = dotMacToColon(m[2]);
    if (!result.has(mac)) result.set(mac, []);
    result.get(mac).push(ipv6);
  }
  return result;
}

function parseNatInsideInterfaces(text) {
  const interfaces = [];
  let readingInside = false;
  for (const line of String(text || '').split('\n')) {
    if (/^Inside interfaces\s*:/i.test(line.trim())) {
      readingInside = true;
      const inline = line.split(':').slice(1).join(':');
      interfaces.push(...inline.split(',').map(v => v.trim()).filter(Boolean));
      continue;
    }
    if (!readingInside) continue;
    if (/^\s+\S/.test(line)) {
      interfaces.push(...line.split(',').map(v => v.trim()).filter(Boolean));
      continue;
    }
    break;
  }
  return [...new Set(interfaces)];
}

function parseLanIp(text, preferredInterfaces = []) {
  const privateIp = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
  const candidates = [];
  for (const line of String(text || '').split('\n')) {
    // "GigabitEthernet0/1  192.168.1.1  YES NVRAM up  up"
    if (!/^\s*\w+\d[/\d.]*\s+\d/.test(line)) continue;
    const m = line.match(privateIp);
    if (!m) continue;
    const interfaceName = line.trim().split(/\s+/)[0];
    candidates.push({ interfaceName, ip: m[1] });
  }
  const preferred = new Set(preferredInterfaces);
  return candidates.find(candidate => preferred.has(candidate.interfaceName))?.ip
    || candidates[0]?.ip
    || '';
}

function isCiscoIos(text) {
  return /Cisco IOS/i.test(String(text || ''));
}

// ── Connection helpers (stateless) ────────────────────────────────────────────
// Prompt classifiers (looksLike*) and isPrivilegeError are imported from
// ./cisco-session at the top of this file.

function classifyConnError(err) {
  const msg = String(err?.message || '');
  if (/host key/i.test(msg) || /fingerprint/i.test(msg)) return 'hostKeyMismatch';
  if (/ECONNREFUSED/.test(msg))                            return 'connRefused';
  if (/ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(msg)) return 'connTimeout';
  if (/Authentication failed|All configured/i.test(msg))  return 'authFailed';
  if (/SSH timeout/i.test(msg))                            return 'shellTimeout';
  if (/SSH shell closed/i.test(msg))                       return 'shellClosed';
  return 'unknown';
}

function buildSshConnectOpts(ip, user, pass, expectedHostFp, onFpSave, logTag) {
  return {
    host: ip, port: 22,
    username: user, password: pass,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    hostHash: 'sha256',
    hostVerifier: hashedKey => {
      const fp = Buffer.isBuffer(hashedKey)
        ? hashedKey.toString('hex')
        : crypto.createHash('sha256').update(hashedKey).digest('hex');
      if (!expectedHostFp) {
        try {
          if (onFpSave) onFpSave(fp);
        } catch (err) {
          logger.error(`${logTag} Host key persistence failed:`, err.message);
          return false;
        }
        return true;
      }
      if (fp !== expectedHostFp) {
        logger.error(`${logTag || '[cisco]'} ⚠️ HOST KEY MISMATCH! Possible MITM attack.`);
        return false;
      }
      return true;
    },
    algorithms: { kex: ['curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256',
                         'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1'] },
  };
}

// Temporary shell for detect() — creates, runs, closes
function createTempCiscoShell({ ip, user, pass, enablePass, expectedHostFp }) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let shell = null;
    let buf   = '';
    let waiter = null;
    let capturedFp = '';
    let settled = false;

    const cleanup = () => {
      if (waiter?.timer) clearTimeout(waiter.timer);
      waiter = null;
      try { if (shell) shell.removeAllListeners(); } catch {}
      try { conn.removeAllListeners(); conn.end(); } catch {}
    };
    const fail = err => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const waitForPromptLocal = (ms = 15000, matcher = looksLikeShellPrompt) => new Promise((res, rej) => {
      if (matcher(buf)) { res(buf); return; }
      const timer = setTimeout(() => { waiter = null; rej(new Error('SSH timeout')); }, ms);
      waiter = { res, rej, timer, matcher };
    });
    const exec = async cmd => {
      buf = '';
      shell.write(cmd + '\n');
      return waitForPromptLocal();
    };

    conn.on('ready', () => {
      conn.shell({ term: 'vt100', cols: 220, rows: 500 }, async (err, stream) => {
        if (err) return fail(err);
        shell = stream;
        stream.on('data', chunk => {
          const text = chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
          buf += text;
          if (looksLikePagerPrompt(text)) stream.write(' '); // space advances one page
          if (waiter && waiter.matcher(buf)) {
            const cur = waiter; waiter = null;
            clearTimeout(cur.timer); cur.res(buf);
          }
        });
        stream.on('error', fail);
        stream.on('close', () => { if (!settled) fail(new Error('SSH shell closed')); });
        try {
          await waitForPromptLocal(CISCO_INITIAL_PROMPT_TIMEOUT_MS);
          // Enter privileged (enable) mode via the shared handshake state machine.
          await runEnableHandshake({
            initialBuf: buf,
            enablePass,
            write: (text) => { buf = ''; shell.write(text); },
            waitForPrompt: (matcher, ms) => waitForPromptLocal(ms, matcher),
          });
          const initialHostName = extractCiscoHostName(buf);
          const terminalRaw = await exec('terminal length 0');
          settled = true;
          resolve({
            exec,
            close: cleanup,
            hostFp: capturedFp,
            hostName: extractCiscoHostName(terminalRaw) || initialHostName,
          });
        } catch (e) { fail(e); }
      });
    });
    conn.on('error', fail);
    conn.connect(buildSshConnectOpts(ip, user, pass, expectedHostFp, fp => { capturedFp = fp; }));
  });
}

// Detection against explicit credentials needs no instance state.
async function detectCisco({ ip, user, pass, enablePass, expectedHostFp } = {}) {
  if (!ip || !user || !pass) throw new Error('Cisco IP, username, and password are required');
  let shell;
  try {
    shell = await createTempCiscoShell({ ip, user, pass, enablePass, expectedHostFp });
  } catch (sshErr) {
    const err = new Error(sshErr.message);
    err.diag = { ssh: { ok: false, code: classifyConnError(sshErr) } };
    throw err;
  }
  try {
    const versionRaw   = await shell.exec('show version');
    const ifBriefRaw   = await shell.exec('show ip interface brief');
    const natRaw       = await shell.exec('show ip nat translations');
    const natStatsRaw  = await shell.exec('show ip nat statistics');
    // A privilege-1 user with no enablePass configured stays in user mode,
    // producing "% Invalid input" for the NAT command. Distinguish this from
    // a genuine zero-session success so the UI can guide the user.
    const privilegeError = isPrivilegeError(natRaw);
    const sessions     = parseNatTranslations(natRaw);
    const lanIp        = parseLanIp(ifBriefRaw, parseNatInsideInterfaces(natStatsRaw));
    const isIos        = isCiscoIos(versionRaw);
    return {
      ssh:  { ok: true },
      nat:  { ok: isIos && !privilegeError, sessions: sessions.length, sessionsOk: sessions.length > 0 && !privilegeError },
      lan:  { ip: lanIp },
      ios:  { ok: isIos, version: (versionRaw.match(/Version\s+([\d.()\w]+)/i) || [])[1] || '' },
      suggested: { ciscoIp: ip, ciscoUser: user },
      hostFp: shell.hostFp,
      hostName: shell.hostName || '',
      diag: { ssh: { ok: true }, isIos, lanIp, natSessions: sessions.length, privilegeError },
    };
  } finally {
    shell.close();
  }
}

// ── Poller factory ────────────────────────────────────────────────────────────

const CISCO_ARP_REFRESH_MS = 60 * 1000;
const CISCO_NDP_REFRESH_MS = 120 * 1000;

/**
 * Create an isolated Cisco IOS poller instance. Every piece of mutable
 * state (SSH connection, shell buffer, caches, config, timers) belongs to
 * the instance, so several routers can be polled from one process.
 *
 * @param {{ id?: string }} [opts]  routerId for log prefixes ('' → '[cisco]')
 */
function createCiscoPoller({ id = '' } = {}) {
  const TAG     = id ? `[cisco:${id}]`     : '[cisco]';
  const TAG_ARP = id ? `[cisco-arp:${id}]` : '[cisco-arp]';
  const TAG_NDP = id ? `[cisco-ndp:${id}]` : '[cisco-ndp]';

  let ciscoShell      = null;
  let ciscoConn       = null;
  let ciscoReady      = false;
  let shellBuf        = '';
  let ciscoReconnectTimer = null;
  let ciscoConnecting = false;
  let shellWaiter     = null;
  let execChain       = Promise.resolve();

  // ARP cache (IP → MAC in colon notation)
  const ciscoArpCache = new Map();
  let ciscoArpLastRefresh = 0;

  // NDP cache (MAC → [ipv6, ...])
  const ciscoNdpCache = new Map();
  let ciscoNdpLastRefresh = 0;

  // Config
  let ciscoIp      = '';
  let ciscoUser    = '';
  let ciscoPass    = '';
  let ciscoEnablePass = '';
  let ciscoEnabled = false;
  let ciscoHostFp  = '';
  let ciscoHostName = '';
  // Whether "show ip nat translations verbose" works on this device; assumed
  // true until a poll proves otherwise, re-assumed when the target changes.
  let ciscoVerboseSupported = true;

  // Callbacks
  let onStatus     = () => {};
  let onSaveConfig = () => {};

  function configure(cfg) {
    if (cfg.ip !== undefined && cfg.ip !== ciscoIp) {
      ciscoVerboseSupported = true;
      ciscoHostName = '';
    }
    if (cfg.ip         !== undefined) ciscoIp         = cfg.ip;
    if (cfg.user       !== undefined) ciscoUser       = cfg.user;
    if (cfg.pass       !== undefined) ciscoPass       = cfg.pass;
    if (cfg.enablePass !== undefined) ciscoEnablePass = cfg.enablePass;
    if (cfg.enabled    !== undefined) ciscoEnabled    = cfg.enabled;
    if (cfg.hostFp     !== undefined) ciscoHostFp     = cfg.hostFp;
    if (cfg.onStatus)     onStatus     = cfg.onStatus;
    if (cfg.onSaveConfig) onSaveConfig = cfg.onSaveConfig;
  }

  // ── Persistent connection ───────────────────────────────────────────────────

  function clearShellWaiter() {
    if (shellWaiter?.timer) clearTimeout(shellWaiter.timer);
    shellWaiter?.removeAbort?.();
    shellWaiter = null;
  }
  function rejectShellWaiter(err) {
    const w = shellWaiter; clearShellWaiter();
    if (w) w.reject(err);
  }

  function waitForPrompt(timeoutMs = 45000, matcher = looksLikeShellPrompt, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError(signal, 'Cisco command aborted')); return; }
      if (matcher(shellBuf)) { resolve(shellBuf); return; }
      clearShellWaiter();
      const timer = setTimeout(() => rejectShellWaiter(new Error('SSH timeout')), timeoutMs);
      shellWaiter = { resolve, reject, timer, matcher, removeAbort: () => {} };
      const removeAbort = attachAbortHandler(signal, rejectShellWaiter, 'Cisco command aborted');
      if (shellWaiter) shellWaiter.removeAbort = removeAbort;
    });
  }

  async function ciscoExec(cmd, timeoutMs = 45000, { signal } = {}) {
    const run = async () => {
      if (signal?.aborted) throw abortError(signal, 'Cisco command aborted');
      if (!ciscoReady || !ciscoShell) throw new Error('Cisco not connected');
      shellBuf = '';
      ciscoShell.write(cmd + '\n');
      await waitForPrompt(timeoutMs, looksLikeShellPrompt, { signal });
      return shellBuf;
    };
    const result = execChain.then(run, run);
    execChain = result.catch(() => {});
    return result;
  }

  function scheduleCiscoReconnect(ms) {
    if (ciscoReconnectTimer) clearTimeout(ciscoReconnectTimer);
    if (!ciscoEnabled) return;
    onStatus({ ready: false, state: 'reconnecting', message: t('cisco.reconnecting') });
    ciscoReconnectTimer = setTimeout(() => { ciscoReconnectTimer = null; connectCisco(); }, ms);
  }

  function connectCisco(onReady) {
    if (!ciscoEnabled) return;
    if (!ciscoIp || !ciscoUser || !ciscoPass) {
      logger.info(`${TAG} credentials not configured yet — skip connect`);
      onStatus({ ready: false, state: 'failed', message: t('cisco.no-config') });
      return;
    }
    if (ciscoConnecting) { logger.info(`${TAG} Connect already in progress, skip`); return; }
    if (ciscoReconnectTimer) { clearTimeout(ciscoReconnectTimer); ciscoReconnectTimer = null; }
    if (ciscoConn) { try { ciscoConn.removeAllListeners(); ciscoConn.on('error', () => {}); ciscoConn.end(); } catch {} ciscoConn = null; }
    ciscoReady = false;
    ciscoShell = null;
    ciscoConnecting = true;
    onStatus({ ready: false, state: 'connecting', message: t('cisco.connecting') });

    const conn = new SshClient();
    ciscoConn = conn;

    conn.on('ready', () => {
      conn.shell({ term: 'vt100', cols: 220, rows: 500 }, (err, stream) => {
        if (err) {
          logger.error(`${TAG} shell error:`, err.message);
          ciscoConnecting = false;
          onStatus({ ready: false, state: 'failed', message: t('cisco.shell-failed') + err.message });
          scheduleCiscoReconnect(5000);
          return;
        }
        ciscoShell = stream;

        stream.on('data', chunk => {
          const text = chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
          shellBuf += text;
          if (looksLikePagerPrompt(text)) stream.write(' ');
          if (shellWaiter && shellWaiter.matcher(shellBuf)) {
            const { resolve } = shellWaiter; clearShellWaiter(); resolve(shellBuf);
          }
        });
        stream.on('error', err => rejectShellWaiter(err));
        stream.on('close', () => {
          rejectShellWaiter(new Error('SSH shell closed'));
          ciscoReady = false;
          ciscoConnecting = false;
          logger.info(`${TAG} Shell closed, reconnecting in 3s…`);
          scheduleCiscoReconnect(3000);
        });

        setTimeout(async () => {
          try {
            await waitForPrompt(CISCO_INITIAL_PROMPT_TIMEOUT_MS);
            // Enter privileged (enable) mode via the shared handshake state machine.
            await runEnableHandshake({
              initialBuf: shellBuf,
              enablePass: ciscoEnablePass,
              write: (text) => { shellBuf = ''; ciscoShell.write(text); },
              waitForPrompt: (matcher, ms) => waitForPrompt(ms, matcher),
            });
            ciscoHostName = extractCiscoHostName(shellBuf) || ciscoHostName;
            shellBuf = '';
            ciscoShell.write('terminal length 0\n');
            await waitForPrompt(5000);
            ciscoHostName = extractCiscoHostName(shellBuf) || ciscoHostName;
            ciscoReady = true;
            ciscoConnecting = false;
            logger.info(`${TAG} Connected to IOS — ready`);
            onStatus({ ready: true, message: t('cisco.connected'), hostName: ciscoHostName || undefined });
            if (onReady) onReady();
          } catch (e) {
            ciscoConnecting = false;
            logger.error(`${TAG} init error:`, e.message);
            onStatus({ ready: false, state: 'failed', message: t('cisco.init-failed') + e.message });
            scheduleCiscoReconnect(5000);
          }
        }, 500);
      });
    });

    conn.on('error', err => {
      logger.error(`${TAG} SSH error:`, err.message);
      ciscoReady = false;
      ciscoConnecting = false;
      onStatus({ ready: false, state: 'failed', message: t('cisco.ssh-failed') + err.message });
      scheduleCiscoReconnect(5000);
    });

    conn.connect(buildSshConnectOpts(ciscoIp, ciscoUser, ciscoPass, ciscoHostFp, fp => {
      const previousFp = ciscoHostFp;
      ciscoHostFp = fp;
      try { onSaveConfig(); }
      catch (err) { ciscoHostFp = previousFp; throw err; }
      logger.info(`${TAG} Host key recorded (TOFU):`, fp.substring(0, 16) + '...');
    }, TAG));
  }

  // ── Public operations ───────────────────────────────────────────────────────

  async function fetchNatSessions({ signal } = {}) {
    // Prefer verbose output: its per-entry "create"/"left" ages give an accurate
    // firstSeen and remaining TTL instead of protocol-default guesses. Older IOS
    // that rejects the verbose keyword answers "% Invalid input", which is the
    // same marker as a privilege error — retry plain to tell the two apart.
    if (ciscoVerboseSupported) {
      const raw = await ciscoExec('show ip nat translations verbose', 90000, { signal });
      if (!isPrivilegeError(raw)) return parseNatTranslations(raw);
      ciscoVerboseSupported = false;
      logger.info(`${TAG} verbose NAT output unavailable — falling back to plain output`);
    }
    const raw = await ciscoExec('show ip nat translations', 90000, { signal });
    // Staying in user mode returns a privilege error indistinguishable from zero
    // sessions, so raise an explicit error instead
    if (isPrivilegeError(raw)) {
      throw new Error('privileged EXEC required — enable mode not active');
    }
    return parseNatTranslations(raw);
  }

  async function refreshCiscoArp({ signal } = {}) {
    if (!ciscoEnabled || !ciscoReady) return;
    try {
      const raw = await ciscoExec('show arp', 45000, { signal });
      const newMap = parseArp(raw);
      ciscoArpCache.clear();
      for (const [k, v] of newMap) ciscoArpCache.set(k, v);
      ciscoArpLastRefresh = Date.now();
      logger.info(`${TAG_ARP} cache refreshed: ${newMap.size} entries`);
    } catch (e) {
      logger.error(`${TAG_ARP} refresh failed:`, e.message);
      if (signal?.aborted) throw e;
    }
  }

  async function refreshCiscoNdp({ signal } = {}) {
    if (!ciscoEnabled || !ciscoReady) return;
    try {
      const raw = await ciscoExec('show ipv6 neighbors', 45000, { signal });
      const newMap = parseNdpNeighbors(raw);
      ciscoNdpCache.clear();
      for (const [k, v] of newMap) ciscoNdpCache.set(k, v);
      ciscoNdpLastRefresh = Date.now();
      logger.info(`${TAG_NDP} cache refreshed: ${newMap.size} entries`);
    } catch (e) {
      logger.error(`${TAG_NDP} refresh failed:`, e.message);
      if (signal?.aborted) throw e;
    }
  }

  async function detectCurrentCisco() {
    if (!ciscoReady || !ciscoShell) throw new Error('Cisco not connected');
    const versionRaw = await ciscoExec('show version');
    const ifBriefRaw = await ciscoExec('show ip interface brief');
    const natRaw     = await ciscoExec('show ip nat translations');
    const natStatsRaw = await ciscoExec('show ip nat statistics');
    const privilegeError = isPrivilegeError(natRaw);
    const sessions   = parseNatTranslations(natRaw);
    const lanIp      = parseLanIp(ifBriefRaw, parseNatInsideInterfaces(natStatsRaw));
    return {
      ssh:  { ok: true },
      nat:  { ok: !privilegeError, sessions: sessions.length, sessionsOk: sessions.length > 0 && !privilegeError },
      lan:  { ip: lanIp },
      ios:  { ok: isCiscoIos(versionRaw) },
      suggested: { ciscoIp: ciscoIp, ciscoUser: ciscoUser },
      diag: { ssh: { ok: true }, lanIp, natSessions: sessions.length, privilegeError },
    };
  }

  function disconnect() {
    ciscoEnabled = false;
    ciscoReady   = false;
    ciscoConnecting = false;
    rejectShellWaiter(new Error('Cisco disconnected'));
    if (ciscoReconnectTimer) { clearTimeout(ciscoReconnectTimer); ciscoReconnectTimer = null; }
    if (ciscoConn) { try { ciscoConn.removeAllListeners(); ciscoConn.on('error', () => {}); ciscoConn.end(); } catch {} ciscoConn = null; }
    ciscoShell = null;
    shellBuf   = '';
    // Also clear the caches so resolveMacByIp doesn't keep returning stale
    // ARP/NDP data after being disabled
    ciscoArpCache.clear();
    ciscoNdpCache.clear();
    ciscoArpLastRefresh = 0;
    ciscoNdpLastRefresh = 0;
  }

  function reconnect() {
    ciscoReady = false;
    ciscoConnecting = false;
    rejectShellWaiter(new Error('Cisco reconnecting'));
    if (ciscoConn) { try { ciscoConn.removeAllListeners(); ciscoConn.on('error', () => {}); ciscoConn.end(); } catch {} ciscoConn = null; }
    scheduleCiscoReconnect(500);
  }

  return {
    getId: () => id,
    configure,
    connectCisco,
    disconnect,
    reconnect,
    ciscoExec,
    detectCisco,          // stateless, exposed on the instance for API parity
    detectCurrentCisco,
    refreshCiscoArp,
    refreshCiscoNdp,
    fetchNatSessions,
    getArpCache:    () => ciscoArpCache,
    getArpMac:      ip => ciscoArpCache.get(ip) || null,
    getNdpByMac:    mac => ciscoNdpCache.get((mac || '').toLowerCase()) || null,
    isReady:        () => ciscoReady,
    isEnabled:      () => ciscoEnabled,
    getIp:          () => ciscoIp,
    getUser:        () => ciscoUser,
    hasPass:        () => !!ciscoPass,
    getNat:         () => null, // Cisco uses no descriptor concept
    getHostFp:      () => ciscoHostFp,
    getHostName:    () => ciscoHostName,
    needsArpRefresh: () => Date.now() - ciscoArpLastRefresh > CISCO_ARP_REFRESH_MS,
    needsNdpRefresh: () => Date.now() - ciscoNdpLastRefresh > CISCO_NDP_REFRESH_MS,
  };
}

// Default instance: preserves the single-router API used across the codebase.
const defaultPoller = createCiscoPoller();

module.exports = {
  ...defaultPoller,
  createCiscoPoller,
  // Pure parsers (shared, stateless)
  parseNatTranslations,
  parseCiscoAge,
  parseArp,
  parseNdpNeighbors,
  parseLanIp,
  parseNatInsideInterfaces,
  dotMacToColon,
  isCiscoIos,
  isPrivilegeError,
  extractCiscoHostName,
};
