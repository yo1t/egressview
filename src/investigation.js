// Auto-investigation queue: enrich new LAN devices with nmap/DNS/OUI lookup.
// Dependencies injected via init() for testability.
'use strict';
const logger = require('./logger');

const { isAllowedRouterIp } = require('./utils');

const INVESTIGATE_CONCURRENCY = 2;
const INVESTIGATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ─── Injected dependencies ────────────────────────────────────────────────────
let _notes, _io, _yamaha, _asus, _deviceId;
let _getAutoInvestigate = () => false;

// ─── Queue state ──────────────────────────────────────────────────────────────
const investigatedAt      = new Map();
const investigationQueue  = [];
const inQueueIps          = new Set();
let   runningInvestigations = 0;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   notes, io, yamaha, asus, deviceId,
 *   getAutoInvestigate: () => boolean
 * }} deps
 */
function init(deps) {
  _notes               = deps.notes;
  _io                  = deps.io;
  _yamaha              = deps.yamaha;
  _asus                = deps.asus;
  _deviceId            = deps.deviceId;
  _getAutoInvestigate  = deps.getAutoInvestigate;
}

// ─── Queue management ─────────────────────────────────────────────────────────

function enqueue(ip, mac) {
  if (!_getAutoInvestigate()) return;
  if (!ip || !isAllowedRouterIp(ip)) return;
  if (ip === _asus.getRouterIp() || ip === _yamaha.getIp()) return;
  if (_notes.has(ip, mac)) return;
  if (inQueueIps.has(ip)) return;
  const last = investigatedAt.get(ip);
  if (last && Date.now() - last < INVESTIGATE_COOLDOWN_MS) return;
  inQueueIps.add(ip);
  investigationQueue.push({ ip, mac });
  drain();
}

function drain() {
  while (runningInvestigations < INVESTIGATE_CONCURRENCY && investigationQueue.length > 0) {
    const job = investigationQueue.shift();
    inQueueIps.delete(job.ip);
    runningInvestigations++;
    _run(job.ip, job.mac).finally(() => {
      runningInvestigations--;
      drain();
    });
  }
}

async function _run(ip, mac) {
  investigatedAt.set(ip, Date.now());
  if (_notes.has(ip, mac)) return;
  try {
    logger.info(`[auto-investigate] start ${ip} (mac=${mac || '?'})`);
    const result = await _deviceId.investigateIp(ip, {
      ouiDb:         _deviceId.getOuiDb(),
      yamahaExec:    _yamaha.isReady() ? _yamaha.yamahaExec : null,
      yamahaEnabled: _yamaha.isEnabled(),
      yamahaReady:   _yamaha.isReady(),
    });
    if (!result || !result.draft) return;
    if (_notes.has(ip, mac)) return;
    const key = (ip && mac) ? `${ip}|${mac}` : (ip || mac);
    if (!_notes.isSafeKey(key)) return;
    _notes.set(key, ('[Auto] ' + result.draft).substring(0, 500));
    _notes.save();
    _io.emit('notes-update', { notes: _notes.getAll() });
    logger.info(`[auto-investigate] saved ${ip}`);
  } catch (e) {
    logger.error(`[auto-investigate] ${ip} failed: ${e.message}`);
  }
}

module.exports = { init, enqueue, drain };
