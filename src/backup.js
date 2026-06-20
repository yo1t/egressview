// Database backup and restore
'use strict';
const logger = require('./logger');

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH    = path.join(__dirname, '..', '.egressview.db');
const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '.egressview-backups');

let DB_PATH    = DEFAULT_DB_PATH;
let BACKUP_DIR = DEFAULT_BACKUP_DIR;

let backupIntervalTimer = null;
let backupIntervalHours = 24; // default: daily
let maxGenerations = 7;       // default: 7 backups

function configure(cfg) {
  if (cfg.intervalHours) backupIntervalHours = cfg.intervalHours;
  if (cfg.maxGenerations) maxGenerations = cfg.maxGenerations;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// Create a backup of the DB using SQLite's online backup API.
// db.backup() takes a consistent snapshot including WAL contents, unlike a
// plain file copy which would miss transactions not yet checkpointed into
// the main DB file.
async function createBackup() {
  if (!fs.existsSync(DB_PATH)) {
    logger.info('[backup] No database to backup');
    return null;
  }
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupName = `egressview_${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  // Only clean up the target file on failure if WE created it — a backup
  // taken in the same second as a previous one shares the timestamped name,
  // and we must not delete that earlier (good) backup.
  const existedBefore = fs.existsSync(backupPath);
  let src = null;
  try {
    src = new Database(DB_PATH, { fileMustExist: true });
    await src.backup(backupPath);
    logger.info(`[backup] Created: ${backupName}`);
    pruneOldBackups();
    return backupName;
  } catch (err) {
    logger.error('[backup] Failed:', err.message);
    if (!existedBefore) { try { fs.unlinkSync(backupPath); } catch {} }  // remove partial backup
    return null;
  } finally {
    if (src) { try { src.close(); } catch {} }
  }
}

// Remove excess backups (keep only maxGenerations)
function pruneOldBackups() {
  ensureBackupDir();
  const files = listBackups();
  if (files.length <= maxGenerations) return;
  // Sort oldest first (by name = timestamp)
  const toRemove = files.slice(0, files.length - maxGenerations);
  for (const f of toRemove) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
      logger.info(`[backup] Pruned: ${f.name}`);
    } catch {}
  }
}

// List available backups sorted by date (oldest first)
function listBackups() {
  ensureBackupDir();
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('egressview_') && f.endsWith('.db'))
      .map(name => {
        const stat = fs.statSync(path.join(BACKUP_DIR, name));
        return { name, size: stat.size, created: stat.mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return files;
  } catch {
    return [];
  }
}

// Get the path to a specific backup file (for download)
const BACKUP_NAME_RE = /^egressview_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/;

function getBackupPath(name) {
  if (!name || !BACKUP_NAME_RE.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(p)) return null;
  return p;
}

// Restore from a backup file (replaces current DB)
async function restoreFromFile(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error('Backup file not found');
  }
  // Create a safety backup of current DB before restoring
  await createBackup();
  // Replace current DB. Backup files are closed snapshots (no live WAL),
  // so a plain copy is safe here. Remove stale WAL/SHM of the old DB so
  // they are not replayed against the restored file.
  fs.copyFileSync(sourcePath, DB_PATH);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
  logger.info(`[backup] Restored from: ${path.basename(sourcePath)}`);
}

// Restore from a named backup generation
async function restoreFromGeneration(name) {
  const p = getBackupPath(name);
  if (!p) throw new Error('Backup not found: ' + name);
  await restoreFromFile(p);
}

// Start periodic backup
function startPeriodicBackup() {
  stopPeriodicBackup();
  const intervalMs = backupIntervalHours * 60 * 60 * 1000;
  backupIntervalTimer = setInterval(() => { createBackup().catch(() => {}); }, intervalMs);
  logger.info(`[backup] Periodic backup every ${backupIntervalHours}h, keep ${maxGenerations} generations`);
  // Create a backup on startup if none exist or the latest is older than the interval.
  // This ensures a backup is taken even when the service restarts before the interval elapses.
  const existing = listBackups();
  if (existing.length === 0) {
    createBackup().catch(() => {});
  } else {
    const latestMtime = new Date(existing[existing.length - 1].created).getTime();
    if (Date.now() - latestMtime >= intervalMs) {
      createBackup().catch(() => {});
    }
  }
}

function stopPeriodicBackup() {
  if (backupIntervalTimer) {
    clearInterval(backupIntervalTimer);
    backupIntervalTimer = null;
  }
}

function getConfig() {
  return { intervalHours: backupIntervalHours, maxGenerations };
}

/** Override DB and backup directory paths for unit testing. */
function _setPathsForTest(dbPath, backupDir) {
  DB_PATH    = dbPath;
  BACKUP_DIR = backupDir;
  // Reset config to defaults so tests start from a known state
  backupIntervalHours = 24;
  maxGenerations      = 7;
  stopPeriodicBackup();
}

module.exports = {
  configure,
  createBackup,
  listBackups,
  getBackupPath,
  restoreFromFile,
  restoreFromGeneration,
  startPeriodicBackup,
  stopPeriodicBackup,
  getConfig,
  _setPathsForTest,
};
