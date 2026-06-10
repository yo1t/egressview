// Notes: per-device memo storage keyed by IP, MAC, or IP|MAC.
// Pure module — no external module dependencies.
'use strict';
const logger = require('./logger');

const fs   = require('fs');
const path = require('path');

const NOTES_FILE = path.join(__dirname, '..', '.widemap.notes.json');

// Allowed key: an IPv4 address, a MAC address, their combination separated by |,
// OR a UUID (deviceId-based canonical key introduced in P1-5 step 8).
const NOTE_KEY_RE = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})(?:\|(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}))?$/;
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Object.<string, string>} */
let notes = Object.create(null);

// ─── Key validation ───────────────────────────────────────────────────────────

function isSafeKey(k) {
  if (typeof k !== 'string' || k.length > 96) return false;
  return NOTE_KEY_RE.test(k) || UUID_RE.test(k);
}

/**
 * Look up a note for a device using deviceId first (canonical), then IP|MAC fallbacks.
 * @param {string|null} deviceId
 * @param {string|null} ip
 * @param {string|null} mac
 * @returns {string|null}
 */
function getForDevice(deviceId, ip, mac) {
  if (deviceId && notes[deviceId]) return notes[deviceId];
  if (ip && mac && notes[`${ip}|${mac}`]) return notes[`${ip}|${mac}`];
  if (ip  && notes[ip])  return notes[ip];
  if (mac && notes[mac]) return notes[mac];
  return null;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    notes = Object.create(null);
    let kept = 0, dropped = 0;
    for (const k of Object.keys(parsed)) {
      if (isSafeKey(k) && typeof parsed[k] === 'string') { notes[k] = parsed[k]; kept++; }
      else { dropped++; }
    }
    logger.info(`[notes] Loaded ${kept} entries${dropped ? ` (dropped ${dropped} unsafe)` : ''}`);
  } catch {
    notes = Object.create(null);
  }
}

function save() {
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), { mode: 0o600 });
    try { fs.chmodSync(NOTES_FILE, 0o600); } catch {}
  } catch (e) {
    logger.error('[notes] save failed:', e.message);
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Returns the whole notes object (reference — do not mutate externally). */
function getAll() { return notes; }

function get(key) { return notes[key]; }

function set(key, value) { notes[key] = value; }

function del(key) { delete notes[key]; }

/**
 * Remove all keys that match ip or mac (exact or as part of a composite key).
 * Used before setting a new note to avoid duplicate keys.
 */
function clearByIpMac(ip, mac) {
  for (const k of Object.keys(notes)) {
    const [kip, kmac] = k.split('|');
    if ((ip && kip === ip) || (mac && (kmac === mac || kip === mac))) delete notes[k];
  }
}

/**
 * Returns true when any stored key references the given ip or mac.
 */
function has(ip, mac) {
  if (ip  && notes[ip])  return true;
  if (mac && notes[mac]) return true;
  for (const k of Object.keys(notes)) {
    const [kip, kmac] = k.split('|');
    if (ip  && kip === ip)                     return true;
    if (mac && (kmac === mac || kip === mac))   return true;
  }
  return false;
}

module.exports = { isSafeKey, load, save, getAll, get, set, del, clearByIpMac, has, getForDevice };
