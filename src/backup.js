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

// Node's timers take a signed 32-bit number of milliseconds. A larger delay is
// not an error: Node prints a TimeoutOverflowWarning and uses 1 ms instead.
// On 2026-09-23 an interval of 8,760 hours (31,536,000,000 ms) did exactly
// that on the production Hub -- the backup ran continuously, each run opening
// its own database connection, until the process held 1,031 connections and
// 7 GB and the machine stopped answering SSH. 596 hours is the largest whole
// number of hours that fits.
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_INTERVAL_HOURS = Math.floor(MAX_TIMER_MS / (60 * 60 * 1000));

// One backup at a time. Every run opens its own connection to the database and
// copies all of it; two at once is twice the disk and memory for the same
// result, and the storm above was hundreds at once.
let backupInFlight = null;
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
  if (Number.isInteger(cfg.intervalHours) && cfg.intervalHours > 0) {
    if (cfg.intervalHours > MAX_INTERVAL_HOURS) {
      logger.warn(`[backup] intervalHours ${cfg.intervalHours} is above the ${MAX_INTERVAL_HOURS}-hour limit `
        + `a timer can hold; keeping ${backupIntervalHours}`);
    } else {
      backupIntervalHours = cfg.intervalHours;
    }
  }
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
//
// Only one runs at a time: a second caller gets the run already in progress.
function createBackup(options) {
  if (backupInFlight) {
    logger.info('[backup] A backup is already running; not starting another');
    return backupInFlight;
  }
  backupInFlight = runBackup(options).finally(() => { backupInFlight = null; });
  return backupInFlight;
}

function removeWithSidecars(filePath) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(filePath + suffix); } catch { /* not there */ }
  }
}

/**
 * Whether a freshly written copy is the whole of its source.
 *
 * `verifyDbFile` alone is not enough: an empty file passes `integrity_check`
 * as an empty database. So the copy must also be as long as the pages it
 * declares, on the same schema version, and hold every table the source
 * holds -- which is also what rules out an empty copy, since it has none.
 */
function verifyCompleteCopy(copyPath, source) {
  const size = fs.statSync(copyPath).size;
  verifyDbFile(copyPath);
  const copy = new Database(copyPath, { readonly: true, fileMustExist: true });
  try {
    const declared = copy.pragma('page_size', { simple: true }) * copy.pragma('page_count', { simple: true });
    if (declared !== size) throw new Error(`the copy is ${size} bytes but declares ${declared}`);
    const version = copy.pragma('user_version', { simple: true });
    const sourceVersion = source.pragma('user_version', { simple: true });
    if (version !== sourceVersion) {
      throw new Error(`the copy is schema v${version}, the source v${sourceVersion}`);
    }
    const tables = db => new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    const have = tables(copy);
    const missing = [...tables(source)].filter(name => !have.has(name));
    if (missing.length) throw new Error(`the copy is missing ${missing.join(', ')}`);
  } finally {
    copy.close();
  }
}

async function runBackup({ capacityPruned = false } = {}) {
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
  // Written under a name nothing lists, and given its real name only once it
  // has been checked. The backup directory on 2026-09-23 held 2,761 files
  // under final names, nearly all 0 bytes: a run that dies after naming its
  // file and before filling it leaves something that looks like a backup to
  // everything that reads the directory -- including the startup restore.
  const partialPath = `${backupPath}.partial`;
  let src = null;
  try {
    src = new Database(DB_PATH, { fileMustExist: true });
    await src.backup(partialPath);
    verifyCompleteCopy(partialPath, src);
    // Opening the copy to check it makes SQLite create a -shm beside it (the
    // copy keeps the source's WAL mode). Renaming only the main file left
    // those behind; the production backup of 2026-09-23 had both. Nothing
    // wrote to the copy, so they carry nothing -- a -wal that does is a
    // reason to stop, not to delete it.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = partialPath + suffix;
      if (!fs.existsSync(sidecar)) continue;
      if (suffix === '-wal' && fs.statSync(sidecar).size > 0) {
        throw new Error('the copy has a non-empty -wal after being read');
      }
      fs.unlinkSync(sidecar);
    }
    fs.renameSync(partialPath, backupPath);
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
    removeWithSidecars(partialPath);
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
/**
 * Removes copies a previous process started and never finished. There is one
 * Hub process, so at start nothing else can be writing them; left in place
 * they cost disk and prove nothing.
 */
function removeAbandonedPartials() {
  let names;
  try { names = fs.readdirSync(BACKUP_DIR); } catch { return 0; }
  const partials = names.filter(name => name.startsWith('egressview_') && name.endsWith('.db.partial'));
  for (const name of partials) removeWithSidecars(path.join(BACKUP_DIR, name));
  if (partials.length) logger.info(`[backup] Removed ${partials.length} unfinished backup(s) from an earlier run`);
  return partials.length;
}

function startPeriodicBackup() {
  stopPeriodicBackup();
  ensureBackupDir();
  removeAbandonedPartials();
  // configure() already refuses a larger value; this is the last line, because
  // the failure it prevents is silent and continuous.
  const intervalMs = Math.min(backupIntervalHours * 60 * 60 * 1000, MAX_TIMER_MS);
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
  MAX_INTERVAL_HOURS,
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
