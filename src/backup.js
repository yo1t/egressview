// Database backup and restore
'use strict';
const logger = require('./logger');

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.widemap.db');
const BACKUP_DIR = path.join(__dirname, '..', '.widemap-backups');

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

// Create a backup copy of the DB file
function createBackup() {
  if (!fs.existsSync(DB_PATH)) {
    logger.info('[backup] No database to backup');
    return null;
  }
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupName = `widemap_${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  try {
    fs.copyFileSync(DB_PATH, backupPath);
    logger.info(`[backup] Created: ${backupName}`);
    pruneOldBackups();
    return backupName;
  } catch (err) {
    logger.error('[backup] Failed:', err.message);
    return null;
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
      .filter(f => f.startsWith('widemap_') && f.endsWith('.db'))
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
function getBackupPath(name) {
  if (!name || name.includes('..') || name.includes('/')) return null;
  const p = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(p)) return null;
  return p;
}

// Restore from a backup file (replaces current DB)
function restoreFromFile(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error('Backup file not found');
  }
  // Create a safety backup of current DB before restoring
  createBackup();
  // Replace current DB
  fs.copyFileSync(sourcePath, DB_PATH);
  logger.info(`[backup] Restored from: ${path.basename(sourcePath)}`);
}

// Restore from a named backup generation
function restoreFromGeneration(name) {
  const p = getBackupPath(name);
  if (!p) throw new Error('Backup not found: ' + name);
  restoreFromFile(p);
}

// Start periodic backup
function startPeriodicBackup() {
  stopPeriodicBackup();
  const intervalMs = backupIntervalHours * 60 * 60 * 1000;
  backupIntervalTimer = setInterval(createBackup, intervalMs);
  logger.info(`[backup] Periodic backup every ${backupIntervalHours}h, keep ${maxGenerations} generations`);
  // Create initial backup if none exist
  if (listBackups().length === 0) createBackup();
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
};
