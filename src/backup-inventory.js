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
        created: stats.mtime.toISOString(),
        mtimeMs: stats.mtimeMs,
        integrity: 'unchecked',
        schema: null,
      });
    }
  }
  return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
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
    backupBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
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
  if (entry.integrity !== 'ok' || selected.has(entry.path)) return false;
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
} = {}) {
  const entries = candidateFiles(dbPath, backupDir).map(verifyEntry);
  const summary = capacity(dbPath, entries, safetyMarginBytes, freeBytes);
  const candidates = [];
  const selected = new Set();
  const remaining = {
    normal: entries.filter(entry => entry.kind === 'normal'),
    migration: entries.filter(entry => entry.kind === 'migration'),
  };
  const minimum = { normal: MIN_NORMAL_GENERATIONS, migration: MIN_MIGRATION_GENERATIONS };

  function removeOldest(kind, reason) {
    const list = remaining[kind];
    if (list.filter(entry => entry.integrity === 'ok').length <= minimum[kind]) return false;
    const index = list.findIndex(entry => entry.integrity === 'ok');
    if (index === -1) return false;
    const [entry] = list.splice(index, 1);
    if (!addCandidate(entry, candidates, selected)) return false;
    entry.reason = reason;
    return true;
  }

  while (remaining.normal.filter(entry => entry.integrity === 'ok').length >
         Math.max(MIN_NORMAL_GENERATIONS, maxGenerations)) {
    if (!removeOldest('normal', 'generation-limit')) break;
  }
  while (remaining.migration.filter(entry => entry.integrity === 'ok').length >
         MIN_MIGRATION_GENERATIONS) {
    if (!removeOldest('migration', 'migration-retention')) break;
  }

  let projectedBackupBytes = summary.backupBytes - candidates.reduce((sum, entry) => sum + entry.size, 0);
  let projectedFreeBytes = summary.freeBytes + candidates.reduce((sum, entry) => sum + entry.size, 0);
  const needStorageReduction = () => maxBackupBytes > 0 && projectedBackupBytes > maxBackupBytes;
  const needMigrationSpace = () => projectedFreeBytes < summary.migrationRequiredBytes;

  while (needStorageReduction() || needMigrationSpace()) {
    const kinds = ['normal', 'migration'].filter(kind =>
      remaining[kind].filter(entry => entry.integrity === 'ok').length > minimum[kind]);
    const choices = kinds
      .map(kind => ({ kind, entry: remaining[kind].find(entry => entry.integrity === 'ok') }))
      .filter(choice => choice.entry)
      .sort((a, b) => a.entry.mtimeMs - b.entry.mtimeMs || a.entry.name.localeCompare(b.entry.name));
    if (!choices.length) break;
    const reason = needMigrationSpace() ? 'migration-space' : 'storage-limit';
    const before = candidates.length;
    removeOldest(choices[0].kind, reason);
    if (candidates.length === before) break;
    const added = candidates[candidates.length - 1];
    projectedBackupBytes -= added.size;
    projectedFreeBytes += added.size;
  }

  const publicEntries = entries.map(({ path: _path, mtimeMs: _mtimeMs, error, reason: _reason, ...entry }) => ({
    ...entry,
    ...(error ? { error } : {}),
  }));
  const publicCandidates = candidates.map(({ path: _path, mtimeMs: _mtimeMs, error: _error, ...entry }) => entry);
  return {
    entries: publicEntries,
    candidates: publicCandidates,
    candidateBytes: publicCandidates.reduce((sum, entry) => sum + entry.size, 0),
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
    blocked: (needStorageReduction() || needMigrationSpace()),
  };
}

function executePrune(options = {}) {
  const plan = buildPrunePlan(options);
  const deleted = [];
  const unlinkFile = options.unlinkFile || fs.unlinkSync;
  for (const candidate of plan.candidates) {
    const source = candidateFiles(options.dbPath, options.backupDir)
      .find(entry => entry.name === candidate.name && entry.kind === candidate.kind);
    if (!source || source.size !== candidate.size || source.created !== candidate.created) {
      throw new Error(`Backup changed after prune planning: ${candidate.name}`);
    }
    const verified = verifyEntry(source);
    if (verified.integrity !== 'ok') {
      throw new Error(`Backup failed integrity verification before prune: ${candidate.name}`);
    }
    unlinkFile(source.path);
    deleted.push({ name: source.name, kind: source.kind, size: source.size, reason: candidate.reason });
  }
  return {
    deleted,
    deletedBytes: deleted.reduce((sum, entry) => sum + entry.size, 0),
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
};
