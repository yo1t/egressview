// Poll scheduler: ルーターの NAT セッションポーリングループと差分 push（P2-23 で
// server.js から分離）。依存は init() で注入し、単体テストを可能にする。
//
// ループのライフサイクル: 無効化されると finally で自然消滅するため、実行時に
// 再有効化されたときは startXPolling() で再起動する（多重起動はフラグで防止）。
'use strict';

const logger = require('./logger');

// ─── Injected dependencies ────────────────────────────────────────────────────
let _io, _yamaha, _cisco, _runtime, _history, _devices, _beacons, _investigation;
let _appState = null;
let _queueConnectionEnrichment = () => {};
let _pollIntervalMs = 60_000;

// ─── Module state ─────────────────────────────────────────────────────────────
// 差分 push 用タイムスタンプ: ルーターごとに独立して管理し、片方のポーリングが
// もう片方の差分ウィンドウを詰めないようにする
let lastYamahaEmitTime = Date.now();
let lastCiscoEmitTime  = Date.now();

// Track session keys seen in the previous poll to detect newly-appeared sessions
// (used for poll-based beacon event recording when [INSPECT] is unavailable).
let lastPollKeys = new Set();

// 多重起動防止フラグ
let yamahaPollActive = false;
let ciscoPollActive  = false;

/**
 * Inject all external dependencies. Must be called once before start*Polling().
 *
 * @param {{
 *   io, yamaha, cisco, runtime, history, devices, beacons, investigation,
 *   appState, queueConnectionEnrichment: (ips: string[]) => void,
 *   pollIntervalMs: number
 * }} deps
 */
function init(deps) {
  _io            = deps.io;
  _yamaha        = deps.yamaha;
  _cisco         = deps.cisco;
  _runtime       = deps.runtime;
  _history       = deps.history;
  _devices       = deps.devices;
  _beacons       = deps.beacons;
  _investigation = deps.investigation;
  _appState      = deps.appState;
  _queueConnectionEnrichment = deps.queueConnectionEnrichment;
  _pollIntervalMs = deps.pollIntervalMs;
}

function startYamahaPolling() {
  if (yamahaPollActive) return;
  yamahaPollActive = true;
  pollYamahaConnections();
}

function startCiscoPolling() {
  if (ciscoPollActive) return;
  ciscoPollActive = true;
  pollCiscoConnections();
}

async function pollYamahaConnections() {
  if (!_yamaha.isEnabled()) { yamahaPollActive = false; return; }
  try {
    if (!_yamaha.isReady()) {
      logger.debug('[yamaha] poll skipped: not ready');
      return;
    }
    const sessions = await _yamaha.fetchSessions();
    logger.debug(`[yamaha] ${sessions.length} sessions parsed`);

    const unique = [...new Set(sessions.map(s => s.dst))];
    _queueConnectionEnrichment(unique);

    const now = Date.now();
    if (_yamaha.needsArpRefresh()) await _yamaha.refreshArp();
    if (_yamaha.needsNdpRefresh()) {
      await _yamaha.refreshNdp();
      for (const [ip, mac] of _yamaha.getArpCache()) {
        const ipv6 = _yamaha.getNdpByMac(mac);
        if (ipv6 && ipv6.length) {
          _devices.observeDevice({ ip, mac, ipv6Addr: ipv6[0], lastSeen: Date.now(), source: 'ndp' });
        }
      }
    }

    sessions.forEach(s => _runtime.recordConnection(s, now, 'yamaha'));

    // Poll-based beacon event recording: only used as fallback when INSPECT syslog is
    // disabled.  When inspectEnabled=true, INSPECT provides precise TCP session-close
    // timestamps; writing poll events on top would duplicate observations with ±60 s
    // precision and skew the CoV calculation.
    // lastPollKeys is updated unconditionally so the delta is accurate when the setting toggles.
    const currentPollKeys = new Set(sessions.map(s => `${s.src}|${s.dst}|${s.dport}|${s.proto}`));
    if (!_appState.inspectEnabled) {
      for (const s of sessions) {
        const key = `${s.src}|${s.dst}|${s.dport}|${s.proto}`;
        if (!lastPollKeys.has(key)) {
          const entry = _history.getConnectionHistory().get(key);
          _beacons.appendEvent({
            src: s.src, dst: s.dst,
            dstHost: entry?.dstHost || s.dst,
            dport: s.dport, proto: s.proto,
            seenAt: now, source: 'poll',
          });
        }
      }
    }
    lastPollKeys = currentPollKeys;

    _history.pruneHistory();

    // 差分 push: 前回 emit 以降に lastSeen が更新されたエントリのみ送信
    const deltaConns = [..._history.getConnectionHistory().values()]
      .filter(c => c.lastSeen > lastYamahaEmitTime);
    lastYamahaEmitTime = now;
    if (deltaConns.length > 0) {
      _io.emit('connections-update', {
        connections: deltaConns,
        serverTime:  now,
        partial:     true,
        delta:       true,
      });
      logger.debug(`[yamaha] emit delta: ${deltaConns.length} connections (of ${_history.getConnectionHistory().size} total)`);
    } else {
      logger.debug('[yamaha] emit delta: 0 changes, skipped');
    }

    if (_appState.autoInvestigate) {
      const srcIps = [...new Set(sessions.map(s => s.src))];
      for (const ip of srcIps) _investigation.enqueue(ip, _runtime.resolveMacByIp(ip));
    }
  } catch (err) {
    logger.error('[yamaha] poll error:', err.message);
    if (err.message.includes('timeout')) {
      logger.warn('[yamaha] Timeout detected, resetting connection…');
      _yamaha.reconnect();
    }
  } finally {
    if (_yamaha.isEnabled()) setTimeout(pollYamahaConnections, _pollIntervalMs);
    else yamahaPollActive = false;
  }
}

async function pollCiscoConnections() {
  if (!_cisco.isEnabled()) { ciscoPollActive = false; return; }
  try {
    if (!_cisco.isReady()) {
      logger.debug('[cisco] poll skipped: not ready');
      return;
    }
    const sessions = await _cisco.fetchSessions();
    logger.debug(`[cisco] ${sessions.length} sessions parsed`);

    const unique = [...new Set(sessions.map(s => s.dst))];
    _queueConnectionEnrichment(unique);

    const now = Date.now();
    if (_cisco.needsArpRefresh()) await _cisco.refreshArp();
    if (_cisco.needsNdpRefresh()) {
      await _cisco.refreshNdp();
      for (const [ip, mac] of _cisco.getArpCache()) {
        const ipv6 = _cisco.getNdpByMac(mac);
        if (ipv6 && ipv6.length) {
          _devices.observeDevice({ ip, mac, ipv6Addr: ipv6[0], lastSeen: Date.now(), source: 'ndp' });
        }
      }
    }

    sessions.forEach(s => _runtime.recordConnection(s, now, 'cisco'));

    _history.pruneHistory();

    const deltaConns = [..._history.getConnectionHistory().values()]
      .filter(c => c.lastSeen > lastCiscoEmitTime);
    lastCiscoEmitTime = now;
    if (deltaConns.length > 0) {
      _io.emit('connections-update', {
        connections: deltaConns,
        serverTime:  now,
        partial:     true,
        delta:       true,
      });
      logger.debug(`[cisco] emit delta: ${deltaConns.length} connections`);
    }
  } catch (err) {
    logger.error('[cisco] poll error:', err.message);
    if (err.message.includes('timeout')) {
      logger.warn('[cisco] Timeout detected, resetting connection…');
      _cisco.reconnect();
    }
  } finally {
    if (_cisco.isEnabled()) setTimeout(pollCiscoConnections, _pollIntervalMs);
    else ciscoPollActive = false;
  }
}

// テスト用: モジュール状態をリセット
function _resetForTest() {
  lastYamahaEmitTime = Date.now();
  lastCiscoEmitTime  = Date.now();
  lastPollKeys = new Set();
  yamahaPollActive = false;
  ciscoPollActive  = false;
}

module.exports = {
  init,
  startYamahaPolling,
  startCiscoPolling,
  _resetForTest,
};
