// Config file I/O — pure file operations, no poller/module state.
// loadFile / saveFile / persistSecret operate only on the JSON config file.
// Applying loaded config to pollers is the caller's responsibility (server.js).
'use strict';
const logger = require('./logger');

const fs   = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', '.egressview.json');

// ─── Low-level file helpers ───────────────────────────────────────────────────

/**
 * Read and parse the config file. Returns {} on any error.
 * @param {string} [file]
 */
function loadFile(file = DEFAULT_CONFIG_FILE) {
  try {
    secureExistingFile(file);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    return {};
  }
}

/**
 * Strict config loader: missing file is allowed, but malformed/unreadable
 * files throw so callers do not treat corruption as a fresh install.
 * @param {string} [file]
 */
function loadFileOrThrow(file = DEFAULT_CONFIG_FILE) {
  try {
    secureExistingFile(file);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    logger.error('[config] load failed:', err.message);
    throw err;
  }
}

/**
 * Best-effort config loader for request paths that can degrade gracefully.
 * Returns {} on any error and logs non-missing-file failures.
 * @param {string} [file]
 */
function loadFileSafe(file = DEFAULT_CONFIG_FILE) {
  try {
    return loadFileOrThrow(file);
  } catch (err) {
    return {};
  }
}

/**
 * Write data to the config file (mode 0o600).
 * @param {object} data
 * @param {string} [file]
 */
function saveFile(data, file = DEFAULT_CONFIG_FILE) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function secureExistingFile(file) {
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link configuration file: ${file}`);
  }
  if (!stats.isFile()) throw new Error(`Configuration path is not a regular file: ${file}`);
  if ((stats.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
}

/**
 * Atomically merge credential fields into one section of the config file.
 * Only the specified `updates` keys are overwritten; all other sections are preserved.
 * Use when a new plaintext secret is received (login/setup routes).
 * @param {string} section  e.g. 'asus', 'yamaha', 'slack'
 * @param {object} updates  key/value pairs to merge
 * @param {string} [file]
 */
function persistSecret(section, updates, file = DEFAULT_CONFIG_FILE) {
  try {
    const cfg = loadFileOrThrow(file);
    cfg[section] = { ...(cfg[section] || {}), ...updates };
    saveFile(cfg, file);
  } catch (e) {
    logger.error('[config] persistSecret failed:', e.message);
    throw e;
  }
}

module.exports = {
  loadFile,
  loadFileOrThrow,
  loadFileSafe,
  saveFile,
  persistSecret,
  secureExistingFile,
  DEFAULT_CONFIG_FILE,
};
