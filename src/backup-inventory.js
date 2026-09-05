// Backup inventory, capacity diagnostics, and safe prune planning.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIB = 1024 * 1024;
const DEFAULT_SAFETY_MARGIN_BYTES = 256 * MIB;
const MIN_NORMAL_GENERATIONS = 2;
const MIN_MIGRATION_GENERATIONS = 1;
const NORMAL_NAME_RE = /^egressview_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{3}-[0-9a-f]{8})?\.db$/;

function freeBytesFor(targetPath) {
  const stats = fs.statfsSync(path.dirname(targetPath));
  return stats.bsize * stats.bavail;
}

function migrationNameRegex(dbPath) {
  const escaped = path.basename(dbPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.pre-migration\\..+\\.bak$`);
}

function candidateFiles(dbPath, backupDir) {
  const entries = [];
  const locations = [
    { dir: backupDir, kind: 'normal', matches: name => NORMAL_NAME_RE.test(name) },
    { dir: path.dirname(dbPath), kind: 'migration', matches: name => migrationNameRegex(dbPath).test(name) },
  ];
  for (const location of locations) {
    let names = [];
    try { names = fs.readdirSync(location.dir); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      if (!location.matches(name)) continue;
      const filePath = path.join(location.dir, name);
      let stats;
      try { stats = fs.statSync(filePath); } catch { continue; }
      if (!stats.isFile()) continue;
      entries.push({
        name,
        kind: location.kind,
        path: filePath,
        size: stats.size,
        allocatedSize: Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size,
        created: stats.mtime.toISOString(),
        mtimeMs: stats.mtimeMs,
        integrity: 'unchecked',
        schema: null,
      });
    }
  }
  return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

// Retention planning reads only the fixed-size SQLite header. Full integrity
// checks already run when a backup is created and again before restore;
// repeating them for every generation made a dry-run take tens of minutes on
// production-sized databases.
function inspectSqliteHeader(entry) {
  let fd = null;
  try {
    fd = fs.openSync(entry.path, 'r');
    const header = Buffer.alloc(100);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString('binary', 0, 16) !== 'SQLite format 3\0') {
      throw new Error('invalid SQLite header');
    }
    const rawPageSize = header.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const validPageSize = pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
    if (!validPageSize || entry.size < pageSize || entry.size % pageSize !== 0) {
      throw new Error('invalid SQLite page geometry');
    }
    return { ...entry, header: 'ok', schema: header.readUInt32BE(60) };
  } catch (error) {
    return { ...entry, header: 'failed', schema: null, error: error.message };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
}

function verifyEntry(entry) {
  let db = null;
  try {
    db = new Database(entry.path, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check')[0]?.integrity_check;
    if (integrity !== 'ok') throw new Error(`integrity_check returned '${integrity}'`);
    return { ...entry, integrity: 'ok', schema: db.pragma('user_version', { simple: true }) };
  } catch (error) {
    return { ...entry, integrity: 'failed', schema: null, error: error.message };
  } finally {
    if (db) { try { db.close(); } catch {} }
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(entry.path + suffix); } catch {}
    }
  }
}

function capacity(dbPath, entries, safetyMarginBytes = DEFAULT_SAFETY_MARGIN_BYTES, freeBytesOverride) {
  const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const freeBytes = Number.isFinite(freeBytesOverride) && freeBytesOverride >= 0
    ? freeBytesOverride
    : freeBytesFor(dbPath);
  const migrationRequiredBytes = dbSize * 2 + safetyMarginBytes;
  return {
    dbSize,
    backupBytes: entries.reduce((sum, entry) => sum + entry.allocatedSize, 0),
    logicalBackupBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    freeBytes,
    safetyMarginBytes,
    migrationRequiredBytes,
    migrationReady: freeBytes >= migrationRequiredBytes,
    shortfallBytes: Math.max(0, migrationRequiredBytes - freeBytes),
  };
}

function buildInventory({ dbPath, backupDir, verify = false, safetyMarginBytes, freeBytes } = {}) {
  const rawEntries = candidateFiles(dbPath, backupDir);
  const entries = verify ? rawEntries.map(verifyEntry) : rawEntries;
  const summary = capacity(dbPath, entries, safetyMarginBytes, freeBytes);
  return {
    entries: entries.map(({ path: _path, mtimeMs: _mtimeMs, error, ...entry }) => ({
      ...entry,
      ...(error ? { error } : {}),
    })),
    summary,
  };
}

function addCandidate(entry, candidates, selected) {
  if (selected.has(entry.path)) return false;
  selected.add(entry.path);
  candidates.push(entry);
  return true;
}

function buildPrunePlan({
  dbPath,
  backupDir,
  maxGenerations,
  maxBackupBytes = 0,
  safetyMarginBytes = DEFAULT_SAFETY_MARGIN_BYTES,
  freeBytes,
  onProgress,
} = {}) {
  const entries = candidateFiles(dbPath, backupDir).map(inspectSqliteHeader);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.allocatedSize, 0);
  const summary = capacity(dbPath, entries, safetyMarginBytes, freeBytes);
  const candidates = [];
  const selected = new Set();
  const usable = {
    normal: entries.filter(entry => entry.kind === 'normal' && entry.header === 'ok'),
    migration: entries.filter(entry => entry.kind === 'migration' && entry.header === 'ok'),
  };
  const minimum = { normal: MIN_NORMAL_GENERATIONS, migration: MIN_MIGRATION_GENERATIONS };
  const present = {
    normal: entries.some(entry => entry.kind === 'normal'),
    migration: entries.some(entry => entry.kind === 'migration'),
  };
  const missing = {
    normal: present.normal ? Math.max(0, minimum.normal - usable.normal.length) : 0,
    migration: present.migration ? Math.max(0, minimum.migration - usable.migration.length) : 0,
  };
  // Preserve the total number of restore points when one class is short. A
  // migration snapshot is preferable to deleting a valid fallback merely
  // because a normal generation could not be created.
  const effectiveMinimum = {
    normal: Math.min(usable.normal.length, minimum.normal + missing.migration),
    migration: Math.min(usable.migration.length, minimum.migration + missing.normal),
  };
  const protectedEntries = [
    ...usable.normal.slice(-effectiveMinimum.normal),
    ...usable.migration.slice(-effectiveMinimum.migration),
  ];
  const protectedPaths = new Set(protectedEntries.map(entry => entry.path));
  const remaining = {
    normal: usable.normal.filter(entry => !protectedPaths.has(entry.path)),
    migration: usable.migration.filter(entry => !protectedPaths.has(entry.path)),
  };

  for (const entry of entries.filter(entry => entry.header !== 'ok')) {
    entry.reason = 'invalid-backup';
    addCandidate(entry, candidates, selected);
  }

  onProgress?.({
    phase: 'planning',
    completed: entries.length,
    total: entries.length,
    verifiedBytes: 0,
    totalBytes,
  });

  function removeOldest(kind, reason) {
    const list = remaining[kind];
    if (!list.length) return false;
    const [entry] = list.splice(0, 1);
    if (!addCandidate(entry, candidates, selected)) return false;
    entry.reason = reason;
    return true;
  }

  const normalRetention = Math.max(effectiveMinimum.normal, maxGenerations);
  while (remaining.normal.length + effectiveMinimum.normal > normalRetention) {
    if (!removeOldest('normal', 'generation-limit')) break;
  }
  while (remaining.migration.length > 0) {
    if (!removeOldest('migration', 'migration-retention')) break;
  }

  let projectedBackupBytes = summary.backupBytes - candidates.reduce((sum, entry) => sum + entry.allocatedSize, 0);
  let projectedFreeBytes = summary.freeBytes + candidates.reduce((sum, entry) => sum + entry.allocatedSize, 0);
  const needStorageReduction = () => maxBackupBytes > 0 && projectedBackupBytes > maxBackupBytes;
  const needMigrationSpace = () => projectedFreeBytes < summary.migrationRequiredBytes;

  while (needStorageReduction() || needMigrationSpace()) {
    const kinds = ['normal', 'migration'].filter(kind => remaining[kind].length > 0);
    const choices = kinds
      .map(kind => ({ kind, entry: remaining[kind][0] }))
      .filter(choice => choice.entry)
      .sort((a, b) => a.entry.mtimeMs - b.entry.mtimeMs || a.entry.name.localeCompare(b.entry.name));
    if (!choices.length) break;
    const reason = needMigrationSpace() ? 'migration-space' : 'storage-limit';
    const before = candidates.length;
    removeOldest(choices[0].kind, reason);
    if (candidates.length === before) break;
    const added = candidates[candidates.length - 1];
    projectedBackupBytes -= added.allocatedSize;
    projectedFreeBytes += added.allocatedSize;
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

  const publicEntries = entries.map(({ path: _path, mtimeMs: _mtimeMs, error, reason: _reason, ...entry }) => ({
    ...entry,
    ...(error ? { error } : {}),
  }));
  const publicCandidates = candidates.map(({ path: _path, mtimeMs: _mtimeMs, error: _error, ...entry }) => entry);
  return {
    entries: publicEntries,
    candidates: publicCandidates,
    candidateBytes: publicCandidates.reduce((sum, entry) => sum + entry.allocatedSize, 0),
    protectedRestorePoints: protectedEntries.map(({ path: _path, mtimeMs: _mtimeMs, ...entry }) => entry),
    summary: {
      ...summary,
      projectedBackupBytes,
      projectedFreeBytes,
      projectedMigrationReady: projectedFreeBytes >= summary.migrationRequiredBytes,
    },
    limits: {
      maxGenerations,
      maxBackupBytes,
      minNormalGenerations: MIN_NORMAL_GENERATIONS,
      minMigrationGenerations: MIN_MIGRATION_GENERATIONS,
    },
    retentionDegraded: missing.normal > 0 || missing.migration > 0,
    safetyBlocked: false,
    blocked: missing.normal > 0 || missing.migration > 0 || needStorageReduction() || needMigrationSpace(),
  };
}

function executePrune(options = {}) {
  const plan = buildPrunePlan(options);
  if (plan.safetyBlocked) {
    throw new Error('Protected restore point failed the fast SQLite safety check');
  }
  const deleted = [];
  let deletedBytes = 0;
  const totalBytes = plan.candidates.reduce((sum, entry) => sum + entry.allocatedSize, 0);
  const unlinkFile = options.unlinkFile || fs.unlinkSync;
  for (const [index, candidate] of plan.candidates.entries()) {
    const source = candidateFiles(options.dbPath, options.backupDir)
      .find(entry => entry.name === candidate.name && entry.kind === candidate.kind);
    if (!source || source.size !== candidate.size || source.allocatedSize !== candidate.allocatedSize ||
        source.created !== candidate.created) {
      throw new Error(`Backup changed after prune planning: ${candidate.name}`);
    }
    const current = inspectSqliteHeader(source);
    if (current.header !== candidate.header || current.schema !== candidate.schema) {
      throw new Error(`Backup safety state changed after prune planning: ${candidate.name}`);
    }
    unlinkFile(source.path);
    const sidecarWarnings = [];
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { unlinkFile(source.path + suffix); } catch (error) {
        // The immutable backup itself is already gone. A stale sidecar does
        // not contain a usable restore point, so report it without turning a
        // completed deletion into an ambiguous failure.
        if (error.code !== 'ENOENT') sidecarWarnings.push(suffix);
      }
    }
    deletedBytes += source.allocatedSize;
    deleted.push({
      name: source.name,
      kind: source.kind,
      size: source.size,
      allocatedSize: source.allocatedSize,
      reason: candidate.reason,
      ...(sidecarWarnings.length ? { sidecarWarnings } : {}),
    });
    options.onProgress?.({
      phase: 'deleting',
      completed: index + 1,
      total: plan.candidates.length,
      verifiedBytes: 0,
      totalBytes,
    });
  }
  return {
    deleted,
    deletedBytes,
    diagnostics: buildInventory({
      dbPath: options.dbPath,
      backupDir: options.backupDir,
      safetyMarginBytes: options.safetyMarginBytes,
    }),
  };
}

module.exports = {
  buildInventory,
  buildPrunePlan,
  executePrune,
  MIN_NORMAL_GENERATIONS,
  MIN_MIGRATION_GENERATIONS,
  DEFAULT_SAFETY_MARGIN_BYTES,
  _candidateFiles: candidateFiles,
  _verifyEntry: verifyEntry,
  _inspectSqliteHeader: inspectSqliteHeader,
};
