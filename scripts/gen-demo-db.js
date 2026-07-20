#!/usr/bin/env node
'use strict';
// Generate .egressview.demo.db — a clean, pre-seeded SQLite snapshot for demos and CI.
// Run:  node scripts/gen-demo-db.js
// The resulting file is committed to git and used automatically when DEMO_MODE=true.

const path = require('path');
const fs   = require('fs');

const OUT = path.join(__dirname, '..', '.egressview.demo.db');

// Remove stale copy so history.js starts fresh
for (const suf of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(OUT + suf); } catch {}
}

process.env.EGRESSVIEW_DB_PATH = OUT;

const history = require('../src/history');
const { seedDemoConnections } = require('./demo-seed');

history.setRetentionDays(730);
history.loadConnectionHistory();

const seeded = seedDemoConnections(history);
history.snapshotHistory();
history.closeDb();

// Checkpoint WAL and leave the committed snapshot in DELETE mode so merely
// inspecting it does not create sidecars. Runtime initialization enables WAL.
const Database = require('better-sqlite3');
const db = new Database(OUT);
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('journal_mode = DELETE');
db.close();

// Remove WAL/SHM — we only want the main file in git
for (const suf of ['-shm', '-wal']) {
  try { fs.unlinkSync(OUT + suf); } catch {}
}

console.log(`[gen-demo-db] seeded ${seeded} connections → ${OUT}`);
console.log(`[gen-demo-db] file size: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
