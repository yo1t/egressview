'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const inventory = require('../../src/backup-inventory');

let tmpDir;
let dbPath;
let backupDir;

function makeDb(filePath, schema = 7, bytes = 0) {
  const db = new Database(filePath);
  db.exec('CREATE TABLE IF NOT EXISTS marks (value TEXT)');
  db.prepare('INSERT INTO marks VALUES (?)').run('ok');
  db.pragma(`user_version = ${schema}`);
  db.close();
  if (bytes > fs.statSync(filePath).size) fs.truncateSync(filePath, bytes);
}

function normal(name, schema = 7) {
  const filePath = path.join(backupDir, name);
  makeDb(filePath, schema);
  return filePath;
}

function migration(name, schema = 6) {
  const filePath = path.join(tmpDir, `${path.basename(dbPath)}.pre-migration.${name}.bak`);
  makeDb(filePath, schema);
  return filePath;
}

function setTime(filePath, seconds) {
  const time = new Date(1_700_000_000_000 + seconds * 1000);
  fs.utimesSync(filePath, time, time);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-backup-inventory-'));
  dbPath = path.join(tmpDir, 'runtime.db');
  backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(backupDir);
  makeDb(dbPath);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('backup inventory', () => {
  it('lists normal and migration backups without temporary or unrelated files', () => {
    normal('egressview_2026-01-01_00-00-00.db');
    migration('v6-to-v7.2026-01-01T00-00-00');
    fs.writeFileSync(path.join(backupDir, 'egressview_partial.tmp'), 'partial');
    fs.writeFileSync(path.join(tmpDir, 'unrelated.bak'), 'unrelated');

    const result = inventory.buildInventory({ dbPath, backupDir });

    assert.deepEqual(result.entries.map(entry => entry.kind).sort(), ['migration', 'normal']);
    assert.ok(result.entries.every(entry => entry.integrity === 'unchecked'));
    assert.ok(result.summary.dbSize > 0);
    assert.ok(result.summary.backupBytes > 0);
    assert.ok(result.summary.logicalBackupBytes >= result.summary.backupBytes);
  });

  it('reports schema and integrity without exposing filesystem paths', () => {
    normal('egressview_2026-01-01_00-00-00.db', 5);
    fs.writeFileSync(path.join(backupDir, 'egressview_2026-01-02_00-00-00.db'), 'broken');

    const result = inventory.buildInventory({ dbPath, backupDir, verify: true });
    const healthy = result.entries.find(entry => entry.integrity === 'ok');
    const broken = result.entries.find(entry => entry.integrity === 'failed');

    assert.equal(healthy.schema, 5);
    assert.equal(broken.schema, null);
    assert.ok(result.entries.every(entry => !Object.hasOwn(entry, 'path')));
  });
});

describe('backup prune planning', () => {
  it('protects two normal generations and the latest migration generation', () => {
    for (let index = 1; index <= 4; index += 1) {
      const filePath = normal(`egressview_2026-01-0${index}_00-00-00.db`);
      setTime(filePath, index);
    }
    for (let index = 1; index <= 3; index += 1) {
      const filePath = migration(`v${index}-to-v${index + 1}.2026-01-0${index}T00-00-00`);
      setTime(filePath, index);
    }

    const plan = inventory.buildPrunePlan({ dbPath, backupDir, maxGenerations: 2 });

    assert.equal(plan.candidates.filter(entry => entry.kind === 'normal').length, 2);
    assert.equal(plan.candidates.filter(entry => entry.kind === 'migration').length, 2);
    assert.ok(plan.candidates.every(entry => entry.integrity === 'unchecked'));
    assert.equal(plan.protectedRestorePoints.length, 3);
    assert.ok(plan.protectedRestorePoints.every(entry => entry.header === 'ok'));
    assert.equal(plan.safetyBlocked, false);
    assert.equal(plan.limits.minNormalGenerations, 2);
    assert.equal(plan.limits.minMigrationGenerations, 1);
  });

  it('blocks cleanup when a protected restore point fails the fast safety check', () => {
    const old = normal('egressview_2026-01-01_00-00-00.db');
    const middle = normal('egressview_2026-01-02_00-00-00.db');
    const newest = normal('egressview_2026-01-03_00-00-00.db');
    const broken = path.join(backupDir, 'egressview_2026-01-04_00-00-00.db');
    fs.writeFileSync(broken, 'broken');
    setTime(old, 1);
    setTime(middle, 2);
    setTime(newest, 3);
    setTime(broken, 4);

    const plan = inventory.buildPrunePlan({ dbPath, backupDir, maxGenerations: 2 });

    assert.deepEqual(plan.candidates.map(entry => entry.name), [path.basename(old), path.basename(middle)]);
    assert.equal(plan.entries.find(entry => entry.name === path.basename(broken)).integrity, 'unchecked');
    assert.equal(plan.protectedRestorePoints.find(entry => entry.name === path.basename(broken)).header, 'failed');
    assert.equal(plan.safetyBlocked, true);
    assert.equal(plan.blocked, true);
    assert.throws(() => inventory.executePrune({ dbPath, backupDir, maxGenerations: 2 }),
      /Protected restore point/);
    assert.equal(inventory._candidateFiles(dbPath, backupDir).length, 4);
  });

  it('does not scan an old deletion candidate as a database', () => {
    const broken = path.join(backupDir, 'egressview_2026-01-01_00-00-00.db');
    fs.writeFileSync(broken, 'broken');
    const middle = normal('egressview_2026-01-02_00-00-00.db');
    const newest = normal('egressview_2026-01-03_00-00-00.db');
    setTime(broken, 1);
    setTime(middle, 2);
    setTime(newest, 3);

    const plan = inventory.buildPrunePlan({ dbPath, backupDir, maxGenerations: 2 });

    assert.deepEqual(plan.candidates.map(entry => entry.name), [path.basename(broken)]);
    assert.equal(plan.safetyBlocked, false);
    assert.ok(plan.protectedRestorePoints.every(entry => entry.header === 'ok'));
  });

  it('plans large sparse generations without reading their contents', () => {
    for (let index = 1; index <= 12; index += 1) {
      const filePath = normal(`egressview_2026-02-${String(index).padStart(2, '0')}_00-00-00.db`);
      fs.truncateSync(filePath, 4 * 1024 * 1024 * 1024);
      setTime(filePath, index);
    }

    const started = performance.now();
    const plan = inventory.buildPrunePlan({ dbPath, backupDir, maxGenerations: 2 });
    const elapsedMs = performance.now() - started;

    assert.equal(plan.candidates.length, 10);
    assert.equal(plan.safetyBlocked, false);
    assert.ok(elapsedMs < 1_000, `metadata-only planning took ${elapsedMs.toFixed(1)}ms`);
    assert.ok(plan.summary.logicalBackupBytes > plan.summary.backupBytes);
  });

  it('uses names as a deterministic tie-breaker for equal timestamps', () => {
    const names = [
      'egressview_2026-01-03_00-00-00.db',
      'egressview_2026-01-01_00-00-00.db',
      'egressview_2026-01-02_00-00-00.db',
    ];
    for (const name of names) {
      const filePath = normal(name);
      setTime(filePath, 1);
    }

    const plan = inventory.buildPrunePlan({ dbPath, backupDir, maxGenerations: 2 });

    assert.equal(plan.candidates[0].name, 'egressview_2026-01-01_00-00-00.db');
  });

  it('reports a blocked storage target rather than crossing retention floors', () => {
    normal('egressview_2026-01-01_00-00-00.db');
    normal('egressview_2026-01-02_00-00-00.db');
    migration('v6-to-v7.2026-01-01T00-00-00');

    const plan = inventory.buildPrunePlan({
      dbPath,
      backupDir,
      maxGenerations: 2,
      maxBackupBytes: 1,
    });

    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.blocked, true);
  });

  it('selects oldest generations until the physical storage cap is met', () => {
    const files = [];
    for (let index = 1; index <= 4; index += 1) {
      const filePath = normal(`egressview_2026-01-0${index}_00-00-00.db`);
      setTime(filePath, index);
      files.push(filePath);
    }
    const stats = fs.statSync(files[0]);
    const oneGeneration = Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;

    const plan = inventory.buildPrunePlan({
      dbPath,
      backupDir,
      maxGenerations: 10,
      maxBackupBytes: oneGeneration * 3,
    });

    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].reason, 'storage-limit');
    assert.ok(plan.summary.projectedBackupBytes <= oneGeneration * 3);
  });

  it('uses old candidates for migration headroom but never crosses retention floors', () => {
    for (let index = 1; index <= 4; index += 1) {
      const filePath = normal(`egressview_2026-01-0${index}_00-00-00.db`);
      setTime(filePath, index);
    }

    const plan = inventory.buildPrunePlan({
      dbPath,
      backupDir,
      maxGenerations: 10,
      freeBytes: 0,
    });

    assert.equal(plan.candidates.length, 2);
    assert.ok(plan.candidates.every(entry => entry.reason === 'migration-space'));
    assert.equal(plan.blocked, true);
  });
});

describe('backup prune execution', () => {
  it('does not change files during dry-run and removes only recomputed candidates', () => {
    for (let index = 1; index <= 4; index += 1) {
      const filePath = normal(`egressview_2026-01-0${index}_00-00-00.db`);
      setTime(filePath, index);
    }
    for (let index = 1; index <= 2; index += 1) {
      const filePath = migration(`v${index}-to-v${index + 1}.2026-01-0${index}T00-00-00`);
      setTime(filePath, index);
    }
    const before = inventory._candidateFiles(dbPath, backupDir).map(entry => entry.name);
    const plan = inventory.buildPrunePlan({ dbPath, backupDir, maxGenerations: 2 });
    assert.deepEqual(inventory._candidateFiles(dbPath, backupDir).map(entry => entry.name), before);

    const result = inventory.executePrune({ dbPath, backupDir, maxGenerations: 2 });
    const remaining = inventory._candidateFiles(dbPath, backupDir);

    assert.equal(result.deleted.length, plan.candidates.length);
    assert.equal(remaining.filter(entry => entry.kind === 'normal').length, 2);
    assert.equal(remaining.filter(entry => entry.kind === 'migration').length, 1);
    assert.ok(result.deletedBytes > 0);
  });

  it('fails without crossing retention floors when deletion is rejected', () => {
    for (let index = 1; index <= 3; index += 1) {
      normal(`egressview_2026-01-0${index}_00-00-00.db`);
    }

    assert.throws(() => inventory.executePrune({
      dbPath,
      backupDir,
      maxGenerations: 2,
      unlinkFile: () => { throw Object.assign(new Error('read only'), { code: 'EROFS' }); },
    }), /read only/);
    assert.equal(inventory._candidateFiles(dbPath, backupDir).filter(entry => entry.kind === 'normal').length, 3);
  });
});
