// Database backup and restore
'use strict';
const logger = require('./logger');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
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

/**
 * Checks a database file on a worker thread and rejects if it is not whole.
 *
 * A restore used to run this check on the main thread, three times: on the
 * file chosen, on the copy made of it, and on the database after the swap.
 * integrity_check on the production database takes 171-283 s, and the
 * watchdog kills the process at 120 s -- so a restore from the settings
 * screen stopped the Hub partway through, with its connections closed.
 */
async function verifyDbFile(filePath) {
  const result = await verifyImpl(filePath);
  if (!result.ok) {
    throw new Error(`Database integrity check failed for ${path.basename(filePath)}: ${result.error}`);
  }
}

function removeSidecars(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

async function replaceDbAtomically(sourcePath) {
  const id = crypto.randomBytes(6).toString('hex');
  const tempPath = `${DB_PATH}.restore-${id}.tmp`;
  // The replaced database's -wal and -shm leave *before* the swap. Removed
  // after it (as this used to), a failure in between left the restored file
  // beside the old -wal, and SQLite replays a -wal into whatever main file it
  // sits next to (db-restore.js has the same rule for the startup restore).
  const asidePrefix = `${DB_PATH}.replaced-${id}`;
  const movedAside = [];
  try {
    // Not copyFileSync: 3.6 GB copied synchronously holds the main thread for
    // as long as the disk takes.
    await fs.promises.copyFile(sourcePath, tempPath);
    fs.chmodSync(tempPath, 0o600);
    await verifyDbFile(tempPath);
    for (const suffix of ['-wal', '-shm']) {
      if (!fs.existsSync(DB_PATH + suffix)) continue;
      fs.renameSync(DB_PATH + suffix, asidePrefix + suffix);
      movedAside.push(suffix);
    }
    fs.renameSync(tempPath, DB_PATH);
  } catch (error) {
    for (const suffix of movedAside.slice().reverse()) {
      try { fs.renameSync(asidePrefix + suffix, DB_PATH + suffix); } catch (restoreError) {
        logger.error(`[backup] Could not put ${path.basename(DB_PATH + suffix)} back; `
          + `it is kept at ${path.basename(asidePrefix + suffix)}: ${restoreError.message}`);
      }
    }
    throw error;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
  // Swapped. What was moved aside belonged to the database just replaced,
  // whose content is in the safety backup every restore takes first.
  for (const suffix of movedAside) {
    try { fs.unlinkSync(asidePrefix + suffix); } catch {}
  }
  await verifyDbFile(DB_PATH);
  removeSidecars(DB_PATH);
}

// Create a backup of the DB using SQLite's online backup API.
// db.backup() takes a consistent snapshot including WAL contents, unlike a
// plain file copy which would miss transactions not yet checkpointed into
// the main DB file.
//
// Only one runs at a time: a second caller gets the run already in progress.
function createBackup(options = {}) {
  // While a restore is replacing the database, a backup would read a file
  // that is being swapped -- and nothing stopped one starting, once the
  // restore no longer held the main thread. The restore's own safety backup
  // is the one exception.
  if (restoreInFlight && !options.forRestore) {
    logger.info('[backup] A restore is running; not starting a backup');
    return Promise.resolve(null);
  }
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

// How long a backup copy may take before it is abandoned. On the production
// Hub a verified 3.6 GB copy took 8 min 38 s (the pre-migration backup of
// 2026-09-22); an hour leaves room for a slower disk without letting a stuck
// copy hold its single-flight slot forever.
const BACKUP_COPY_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Copies and verifies on a worker thread (backup-copy.js), so the main
 * thread -- which serves the UI and is watched by the watchdog -- only waits.
 *
 * @returns {Promise<{ ok: boolean, error?: string, bytes?: number, copiedMs?: number, verifiedMs?: number }>}
 */
function copyOnWorker(source, destination, { timeoutMs = BACKUP_COPY_TIMEOUT_MS } = {}) {
  return runOnWorker({ source, destination }, timeoutMs, 'copy');
}

/**
 * Runs integrity_check on a worker thread.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
function verifyOnWorker(filePath, { timeoutMs = BACKUP_COPY_TIMEOUT_MS } = {}) {
  return runOnWorker({ mode: 'verify', path: filePath }, timeoutMs, 'check');
}

function runOnWorker(workerData, timeoutMs, what) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const worker = new Worker(path.join(__dirname, 'backup-copy-worker.js'), { workerData });
    const timer = setTimeout(() => {
      finish({ ok: false, error: `the ${what} did not finish within ${Math.round(timeoutMs / 60000)} minutes` });
      worker.terminate().catch(() => {});
    }, timeoutMs);
    worker.once('message', finish);
    worker.once('error', error => finish({ ok: false, error: error.message }));
    worker.once('exit', code => finish({ ok: false, error: `the ${what} worker exited with code ${code}` }));
  });
}

let copyImpl = copyOnWorker;
let verifyImpl = verifyOnWorker;

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
  try {
    const copy = await copyImpl(DB_PATH, partialPath);
    if (!copy.ok) throw new Error(copy.error || 'the copy failed');
    fs.renameSync(partialPath, backupPath);
    logger.info(`[backup] Created: ${backupName} (${copy.bytes ?? '?'} bytes; `
      + `copied in ${((copy.copiedMs ?? 0) / 1000).toFixed(1)} s, verified in ${((copy.verifiedMs ?? 0) / 1000).toFixed(1)} s, `
      + 'off the main thread)');
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

// One restore at a time. Two used to be impossible only because the first
// held the main thread until it finished; with the checks off it, a second
// request -- a double click, or an upload beside a generation restore -- would
// swap the database under the first.
let restoreInFlight = false;

// Restore from a backup file (replaces current DB)
async function restoreFromFile(sourcePath, options = {}) {
  if (restoreInFlight) throw new Error('A restore is already running');
  restoreInFlight = true;
  try {
    return await restoreFromFileOnce(sourcePath, options);
  } finally {
    restoreInFlight = false;
  }
}

async function restoreFromFileOnce(sourcePath, {
  beforeReplace,
  afterReplace,
  beforeRollback,
  afterRollback,
  replaceDb = replaceDbAtomically,
} = {}) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error('Backup file not found');
  }
  await verifyDbFile(sourcePath);

  // A restore is destructive, so an existing DB is never replaced unless a
  // verified safety backup has been created successfully first.
  let safetyPath = null;
  if (fs.existsSync(DB_PATH)) {
    const safetyName = await createBackup({ forRestore: true });
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
    await replaceDb(sourcePath);
    if (afterReplace) await afterReplace();
  } catch (restoreErr) {
    try {
      if (!replacementStarted) {
        if (prepareStarted && afterRollback) await afterRollback();
        throw restoreErr;
      }
      if (beforeRollback) await beforeRollback();
      if (safetyPath) {
        await replaceDb(safetyPath);
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
  copyImpl            = copyOnWorker;
  stopPeriodicBackup();
}

/** Replaces the copy step, for tests that need a copy to hang or fail. */
function _setCopyForTest(fn) {
  copyImpl = fn || copyOnWorker;
}

function _setVerifyForTest(fn) {
  verifyImpl = fn || verifyOnWorker;
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
  _setCopyForTest,
  _setVerifyForTest,
  _verifyOnWorker: verifyOnWorker,
  _copyOnWorker: copyOnWorker,
  _replaceDbAtomically: replaceDbAtomically,
  _verifyDbFile: verifyDbFile,
};
