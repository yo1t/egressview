// Database backup and restore
'use strict';
const logger = require('./logger');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const backupInventory = require('./backup-inventory');
const { BackupPruneRunner, DEFAULT_TIMEOUT_MS } = require('./backup-prune-runner');

const DEFAULT_DB_PATH    = path.join(__dirname, '..', '.egressview.db');
const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '.egressview-backups');

let DB_PATH    = DEFAULT_DB_PATH;
let BACKUP_DIR = DEFAULT_BACKUP_DIR;

let backupIntervalTimer = null;
let backupIntervalHours = 24; // default: daily
let maxGenerations = 7;       // default: 7 backups
let maxBackupBytes = 0;       // default: no storage cap
let autoPrune = false;        // explicit opt-in only
let freeBytesOverride = null;  // tests only

function backupCapacity() {
  const dbSize = fs.statSync(DB_PATH).size;
  const stats = fs.statfsSync(BACKUP_DIR);
  const freeBytes = freeBytesOverride == null ? stats.bsize * stats.bavail : freeBytesOverride;
  const requiredBytes = dbSize + backupInventory.DEFAULT_SAFETY_MARGIN_BYTES;
  return { dbSize, freeBytes, requiredBytes, ready: freeBytes >= requiredBytes };
}

function resolvePruneTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 && parsed <= 6 * 60 * 60 * 1000
    ? Math.trunc(parsed)
    : DEFAULT_TIMEOUT_MS;
}

const pruneRunner = new BackupPruneRunner({
  timeoutMs: resolvePruneTimeout(process.env.EGRESSVIEW_BACKUP_PRUNE_TIMEOUT_MS),
  onSettled(job, internalError) {
    if (job.status === 'completed' && job.operation === 'execute') {
      const deleted = job.result?.deleted || [];
      logger.info(`[backup] Cleanup ${job.id} completed: ${deleted.length} old generation(s), ` +
                  `${job.result?.deletedBytes || 0} bytes released`);
      if (job.source === 'automatic-capacity') {
        createBackup({ capacityPruned: true }).catch(error => {
          logger.warn('[backup] Backup retry after capacity cleanup failed:', error.message);
        });
      }
    } else if (!['completed', 'cancelled'].includes(job.status)) {
      logger.warn(`[backup] Cleanup ${job.id} ${job.status}:`, internalError || job.error || 'unknown error');
    }
  },
});

function configure(cfg) {
  if (cfg.dbPath) DB_PATH = cfg.dbPath;
  if (cfg.backupDir) BACKUP_DIR = cfg.backupDir;
  if (Number.isInteger(cfg.intervalHours) && cfg.intervalHours > 0) backupIntervalHours = cfg.intervalHours;
  if (Number.isInteger(cfg.maxGenerations) && cfg.maxGenerations >= 2) maxGenerations = cfg.maxGenerations;
  if (Number.isSafeInteger(cfg.maxBackupBytes) && cfg.maxBackupBytes >= 0) maxBackupBytes = cfg.maxBackupBytes;
  if (typeof cfg.autoPrune === 'boolean') autoPrune = cfg.autoPrune;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function verifyDbFile(filePath) {
  let candidate = null;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    const result = candidate.pragma('integrity_check')[0]?.integrity_check;
    if (result !== 'ok') throw new Error(`integrity_check returned '${result}'`);
  } catch (err) {
    throw new Error(`Database integrity check failed for ${path.basename(filePath)}: ${err.message}`, { cause: err });
  } finally {
    if (candidate) { try { candidate.close(); } catch {} }
  }
}

function removeSidecars(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function replaceDbAtomically(sourcePath) {
  const tempPath = `${DB_PATH}.restore-${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.copyFileSync(sourcePath, tempPath);
    fs.chmodSync(tempPath, 0o600);
    verifyDbFile(tempPath);
    fs.renameSync(tempPath, DB_PATH);
    removeSidecars(DB_PATH);
    verifyDbFile(DB_PATH);
    removeSidecars(DB_PATH);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// Create a backup of the DB using SQLite's online backup API.
// db.backup() takes a consistent snapshot including WAL contents, unlike a
// plain file copy which would miss transactions not yet checkpointed into
// the main DB file.
async function createBackup({ capacityPruned = false } = {}) {
  if (!fs.existsSync(DB_PATH)) {
    logger.info('[backup] No database to backup');
    return null;
  }
  ensureBackupDir();
  const capacity = backupCapacity();
  if (!capacity.ready) {
    logger.warn(`[backup] Backup skipped: need ${capacity.requiredBytes} bytes, ` +
                `${capacity.freeBytes} bytes available`);
    if (autoPrune && !capacityPruned && !pruneRunner.getActive()) {
      try {
        const job = startPruneJob({ execute: true, source: 'automatic-capacity' });
        logger.info(`[backup] Capacity cleanup started: ${job.id}`);
      } catch (pruneError) {
        logger.warn('[backup] Capacity cleanup could not start:', pruneError.message);
      }
    }
    return null;
  }
  const timestamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace('Z', '');
  const uniqueId = crypto.randomBytes(4).toString('hex');
  const backupName = `egressview_${timestamp}-${uniqueId}.db`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  let src = null;
  try {
    src = new Database(DB_PATH, { fileMustExist: true });
    await src.backup(backupPath);
    verifyDbFile(backupPath);
    logger.info(`[backup] Created: ${backupName}`);
    if (autoPrune) {
      try {
        const job = startPruneJob({ execute: true, source: 'automatic' });
        logger.info(`[backup] Automatic cleanup started: ${job.id}`);
      } catch (pruneError) {
        logger.warn('[backup] Automatic prune failed; the new backup was kept:', pruneError.message);
      }
    } else {
      logCapacityWarning();
    }
    return backupName;
  } catch (err) {
    logger.error('[backup] Failed:', err.message);
    try { fs.unlinkSync(backupPath); } catch {}  // remove partial backup
    return null;
  } finally {
    if (src) { try { src.close(); } catch {} }
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
const BACKUP_NAME_RE = /^egressview_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{3}-[0-9a-f]{8})?\.db$/;

function getBackupPath(name) {
  if (!name || !BACKUP_NAME_RE.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(p)) return null;
  return p;
}

// Restore from a backup file (replaces current DB)
async function restoreFromFile(sourcePath, {
  beforeReplace,
  afterReplace,
  beforeRollback,
  afterRollback,
  replaceDb = replaceDbAtomically,
} = {}) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error('Backup file not found');
  }
  verifyDbFile(sourcePath);

  // A restore is destructive, so an existing DB is never replaced unless a
  // verified safety backup has been created successfully first.
  let safetyPath = null;
  if (fs.existsSync(DB_PATH)) {
    const safetyName = await createBackup();
    if (!safetyName) throw new Error('Safety backup failed; restore aborted');
    safetyPath = getBackupPath(safetyName);
    if (!safetyPath) throw new Error('Safety backup verification failed; restore aborted');
  }

  let prepareStarted = false;
  let replacementStarted = false;
  try {
    if (beforeReplace) {
      prepareStarted = true;
      await beforeReplace();
    }
    replacementStarted = true;
    replaceDb(sourcePath);
    if (afterReplace) await afterReplace();
  } catch (restoreErr) {
    try {
      if (!replacementStarted) {
        if (prepareStarted && afterRollback) await afterRollback();
        throw restoreErr;
      }
      if (beforeRollback) await beforeRollback();
      if (safetyPath) {
        replaceDb(safetyPath);
        logger.warn('[backup] Restore failed; original database recovered from safety backup');
      } else {
        try { fs.unlinkSync(DB_PATH); } catch {}
        removeSidecars(DB_PATH);
      }
      if (afterRollback) await afterRollback();
    } catch (rollbackErr) {
      if (rollbackErr === restoreErr) throw restoreErr;
      throw new Error(`Restore failed (${restoreErr.message}); safety rollback also failed (${rollbackErr.message})`, { cause: rollbackErr });
    }
    throw restoreErr;
  }
  logger.info(`[backup] Restored from: ${path.basename(sourcePath)}`);
}

// Restore from a named backup generation
async function restoreFromGeneration(name, options) {
  const p = getBackupPath(name);
  if (!p) throw new Error('Backup not found: ' + name);
  await restoreFromFile(p, options);
}

// Start periodic backup
function startPeriodicBackup() {
  stopPeriodicBackup();
  const intervalMs = backupIntervalHours * 60 * 60 * 1000;
  backupIntervalTimer = setInterval(() => { createBackup().catch(() => {}); }, intervalMs);
  logger.info(`[backup] Periodic backup every ${backupIntervalHours}h, keep ${maxGenerations} generations`);
  logCapacityWarning();
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
  return { intervalHours: backupIntervalHours, maxGenerations, maxBackupBytes, autoPrune };
}

function inventory({ verify = false } = {}) {
  ensureBackupDir();
  return backupInventory.buildInventory({ dbPath: DB_PATH, backupDir: BACKUP_DIR, verify });
}

function previewPrune() {
  ensureBackupDir();
  return backupInventory.buildPrunePlan({
    dbPath: DB_PATH,
    backupDir: BACKUP_DIR,
    maxGenerations,
    maxBackupBytes,
  });
}

function pruneBackups() {
  ensureBackupDir();
  return backupInventory.executePrune({
    dbPath: DB_PATH,
    backupDir: BACKUP_DIR,
    maxGenerations,
    maxBackupBytes,
  });
}

function pruneOptions() {
  return {
    dbPath: DB_PATH,
    backupDir: BACKUP_DIR,
    maxGenerations,
    maxBackupBytes,
  };
}

function startPruneJob({ execute = false, source = 'manual' } = {}) {
  ensureBackupDir();
  return pruneRunner.start({
    operation: execute ? 'execute' : 'preview',
    options: pruneOptions(),
    source,
  });
}

function getPruneJob(id) {
  return pruneRunner.get(id);
}

function getActivePruneJob() {
  return pruneRunner.getActive();
}

function cancelPruneJob(id) {
  return pruneRunner.cancel(id);
}

function logCapacityWarning() {
  try {
    const diagnostics = inventory();
    const { summary } = diagnostics;
    if (!summary.migrationReady) {
      logger.warn(`[backup] Disk capacity warning: migration needs ${summary.migrationRequiredBytes} bytes, ` +
                  `${summary.freeBytes} bytes available (${summary.shortfallBytes} bytes short)`);
    }
    if (maxBackupBytes > 0 && summary.backupBytes > maxBackupBytes) {
      logger.warn(`[backup] Backup storage warning: ${summary.backupBytes} bytes exceeds ` +
                  `${maxBackupBytes} byte limit; review the dry-run prune plan`);
    }
  } catch (error) {
    logger.warn('[backup] Capacity diagnostics failed:', error.message);
  }
}

/** Override DB and backup directory paths for unit testing. */
function _setPathsForTest(dbPath, backupDir) {
  pruneRunner.reset();
  DB_PATH    = dbPath;
  BACKUP_DIR = backupDir;
  // Reset config to defaults so tests start from a known state
  backupIntervalHours = 24;
  maxGenerations      = 7;
  maxBackupBytes      = 0;
  autoPrune           = false;
  freeBytesOverride   = null;
  stopPeriodicBackup();
}

function _setFreeBytesForTest(value) {
  freeBytesOverride = value;
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
  inventory,
  previewPrune,
  pruneBackups,
  startPruneJob,
  getPruneJob,
  getActivePruneJob,
  cancelPruneJob,
  logCapacityWarning,
  _setPathsForTest,
  _setFreeBytesForTest,
  _verifyDbFile: verifyDbFile,
};
